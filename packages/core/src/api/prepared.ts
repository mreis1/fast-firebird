import { FreeStatement } from '../protocol/constants.js';
import { freeStatement, type PreparedStatementInfo } from '../protocol/statement.js';
import { executePrepared, type QueryOptions, type QueryResult, type Row } from './session.js';
import { blobsMayProduceLazy } from './options.js';
import { FirebirdBlobError } from './errors.js';
import { bindNamedParams, isNamedParams, FirebirdParamError, type QueryParams } from './named-params.js';
import { executeBatchPrepared, type BatchOptions, type BatchResult, type BatchRows } from './batch.js';
import type { SqlVarDesc } from '../protocol/info.js';
import type { ParamValue } from '../protocol/msgcodec.js';
import type { Attachment } from './attachment.js';
import type { Transaction } from './transaction.js';

/**
 * An explicitly prepared statement, pinned outside the LRU cache.
 * Re-execution costs a single round trip. Close it when done.
 */
export class PreparedStatement {
  private closed = false;

  /** @internal */
  constructor(
    private readonly att: Attachment,
    private readonly info: PreparedStatementInfo,
    readonly sql: string,
    /** `@name` markers in `?` order — empty for a positional statement. */
    private readonly paramNames: string[] = [],
  ) {}

  /**
   * Reorder a named-params object to positional, or pass an array through.
   * Throws if a named object is given for a statement with no `@name` markers.
   */
  private bind(params: QueryParams): ParamValue[] {
    if (!isNamedParams(params)) return params;
    if (this.paramNames.length === 0) {
      throw new FirebirdParamError(
        'a named-parameter object was passed but the prepared SQL has no @name markers — prepare with @name markers or pass a positional array',
      );
    }
    return bindNamedParams(this.paramNames, params);
  }

  /** Described input parameters. */
  get inputs(): readonly SqlVarDesc[] {
    return this.info.description.inputs;
  }

  /** Described output columns. */
  get outputs(): readonly SqlVarDesc[] {
    return this.info.description.outputs;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Prepared statement already closed: ${this.sql}`);
  }

  /** Run inside an explicit transaction, or a one-shot one when omitted. */
  async run<T = Row>(params: QueryParams = [], tx?: Transaction, options?: QueryOptions): Promise<QueryResult<T>> {
    this.assertOpen();
    const bound = this.bind(params);
    if (tx) {
      return this.att.withLock(() =>
        executePrepared(this.att.session, tx.handle, this.info, bound, true, {
          query: options ?? {},
          txAlive: () => !tx.isFinished && this.att.isAlive,
        }),
      ) as Promise<QueryResult<T>>;
    }
    if (blobsMayProduceLazy(options?.blobs ?? this.att.options.blobs)) {
      throw new FirebirdBlobError(
        "lazy blob modes require an explicit transaction — pass a tx to stmt.run(params, tx, {blobs:'lazy'})",
      );
    }
    const own = await this.att.startTransaction();
    try {
      const result = await this.att.withLock(() =>
        executePrepared(this.att.session, own.handle, this.info, bound, true, {
          query: options ?? {},
          txAlive: () => !own.isFinished,
        }),
      );
      await own.commit();
      return result as QueryResult<T>;
    } catch (err) {
      if (!own.isFinished) {
        try {
          await own.rollback();
        } catch {
          /* surface the original error */
        }
      }
      throw err;
    }
  }

  async query<T = Row>(params: QueryParams = [], tx?: Transaction, options?: QueryOptions): Promise<T[]> {
    return (await this.run<T>(params, tx, options)).rows;
  }

  /** First row or `undefined` (see `Attachment.queryOne`). */
  async queryOne<T = Row>(params: QueryParams = [], tx?: Transaction, options?: QueryOptions): Promise<T | undefined> {
    return (await this.run<T>(params, tx, options)).rows[0];
  }

  async execute(params: QueryParams = [], tx?: Transaction, options?: QueryOptions): Promise<number> {
    return (await this.run(params, tx, options)).rowsAffected;
  }

  /**
   * Bulk-run this statement against many parameter rows via the wire batch
   * API (Firebird 4+) — in the given transaction, or a one-shot one. Repeat
   * calls reuse the prepared handle: zero prepare cost per batch. See
   * `Attachment.executeBatch`.
   */
  async executeBatch(rows: BatchRows, tx?: Transaction, options?: BatchOptions): Promise<BatchResult> {
    this.assertOpen();
    if (tx) {
      return this.att.withLock(() =>
        executeBatchPrepared(this.att.session, tx.handle, this.info, rows, this.paramNames, options),
      );
    }
    const own = await this.att.startTransaction();
    try {
      const result = await this.att.withLock(() =>
        executeBatchPrepared(this.att.session, own.handle, this.info, rows, this.paramNames, options),
      );
      await own.commit();
      return result;
    } catch (err) {
      if (!own.isFinished) {
        try {
          await own.rollback();
        } catch {
          /* surface the original error */
        }
      }
      throw err;
    }
  }

  /** `await using stmt = await db.prepare(…)` → closes at scope exit. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /** Release the server-side handle (deferred; rides with the next packet). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.att.withLock(async () => {
      freeStatement(this.att.session.wire, this.info.handle, FreeStatement.DSQL_drop);
    });
  }
}
