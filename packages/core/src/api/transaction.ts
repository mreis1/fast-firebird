import { commitTransaction, rollbackTransaction } from '../protocol/transaction.js';
import { runStatement, streamRows, type QueryOptions, type QueryResult, type RunContext, type Row } from './session.js';
import type { ParamValue } from '../protocol/msgcodec.js';
import type { Attachment } from './attachment.js';

export class Transaction {
  private finished = false;

  constructor(
    private readonly att: Attachment,
    readonly handle: number,
  ) {}

  get isFinished(): boolean {
    return this.finished;
  }

  private assertActive(): void {
    if (this.finished) throw new Error('Transaction already committed or rolled back');
  }

  /** @internal Run context binding lazy-blob validity to this transaction. */
  private runContext(options?: QueryOptions): RunContext {
    return { query: options ?? {}, txAlive: () => !this.finished && this.att.isAlive };
  }

  /** Run a statement and return its rows. */
  async query(sql: string, params: ParamValue[] = [], options?: QueryOptions): Promise<Row[]> {
    return (await this.run(sql, params, options)).rows;
  }

  /** Run a statement and return rows + affected-record count. */
  async run(sql: string, params: ParamValue[] = [], options?: QueryOptions): Promise<QueryResult> {
    this.assertActive();
    return this.att.withLock(() => runStatement(this.att.session, this.handle, sql, params, this.runContext(options)));
  }

  /** Run a statement, returning only the affected-record count. */
  async execute(sql: string, params: ParamValue[] = [], options?: QueryOptions): Promise<number> {
    return (await this.run(sql, params, options)).rowsAffected;
  }

  /**
   * Stream rows lazily within THIS transaction (no commit/rollback here —
   * the caller owns the transaction). Backpressure at batch granularity.
   * Lazy blob handles from this stream stay valid until the transaction ends.
   */
  queryStream(sql: string, params: ParamValue[] = [], options?: QueryOptions): AsyncGenerator<Row> {
    this.assertActive();
    return streamRows(this.att.session, this.handle, sql, params, (fn) => this.att.withLock(fn), this.runContext(options));
  }

  async commit(): Promise<void> {
    this.assertActive();
    this.finished = true;
    await this.att.withLock(() => commitTransaction(this.att.wire, this.handle));
  }

  async rollback(): Promise<void> {
    this.assertActive();
    this.finished = true;
    await this.att.withLock(() => rollbackTransaction(this.att.wire, this.handle));
  }

  /** Commit but keep the transaction context open for further work. */
  async commitRetaining(): Promise<void> {
    this.assertActive();
    await this.att.withLock(() => commitTransaction(this.att.wire, this.handle, true));
  }

  async rollbackRetaining(): Promise<void> {
    this.assertActive();
    await this.att.withLock(() => rollbackTransaction(this.att.wire, this.handle, true));
  }
}
