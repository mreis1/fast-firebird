import { FreeStatement } from '../protocol/constants.js';
import { freeStatement, type PreparedStatementInfo } from '../protocol/statement.js';
import { executePrepared, type QueryOptions, type QueryResult, type Row } from './session.js';
import { blobsMayProduceLazy } from './options.js';
import { FirebirdBlobError } from './errors.js';
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
  ) {}

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
  async run<T = Row>(params: ParamValue[] = [], tx?: Transaction, options?: QueryOptions): Promise<QueryResult<T>> {
    this.assertOpen();
    if (tx) {
      return this.att.withLock(() =>
        executePrepared(this.att.session, tx.handle, this.info, params, true, {
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
        executePrepared(this.att.session, own.handle, this.info, params, true, {
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

  async query<T = Row>(params: ParamValue[] = [], tx?: Transaction, options?: QueryOptions): Promise<T[]> {
    return (await this.run<T>(params, tx, options)).rows;
  }

  /** First row or `undefined` (see `Attachment.queryOne`). */
  async queryOne<T = Row>(params: ParamValue[] = [], tx?: Transaction, options?: QueryOptions): Promise<T | undefined> {
    return (await this.run<T>(params, tx, options)).rows[0];
  }

  async execute(params: ParamValue[] = [], tx?: Transaction, options?: QueryOptions): Promise<number> {
    return (await this.run(params, tx, options)).rowsAffected;
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
