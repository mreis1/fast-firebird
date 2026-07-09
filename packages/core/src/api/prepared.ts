import { FreeStatement } from '../protocol/constants.js';
import { freeStatement, type PreparedStatementInfo } from '../protocol/statement.js';
import { executePrepared, type QueryResult, type Row } from './session.js';
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
  async run(params: ParamValue[] = [], tx?: Transaction): Promise<QueryResult> {
    this.assertOpen();
    if (tx) {
      return this.att.withLock(() => executePrepared(this.att.session, tx.handle, this.info, params, true));
    }
    const own = await this.att.startTransaction();
    try {
      const result = await this.att.withLock(() =>
        executePrepared(this.att.session, own.handle, this.info, params, true),
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

  async query(params: ParamValue[] = [], tx?: Transaction): Promise<Row[]> {
    return (await this.run(params, tx)).rows;
  }

  async execute(params: ParamValue[] = [], tx?: Transaction): Promise<number> {
    return (await this.run(params, tx)).rowsAffected;
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
