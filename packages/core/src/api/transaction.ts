import { commitTransaction, rollbackTransaction } from '../protocol/transaction.js';
import { runStatement, streamRows, type QueryResult, type Row } from './session.js';
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

  /** Run a statement and return its rows. */
  async query(sql: string, params: ParamValue[] = []): Promise<Row[]> {
    return (await this.run(sql, params)).rows;
  }

  /** Run a statement and return rows + affected-record count. */
  async run(sql: string, params: ParamValue[] = []): Promise<QueryResult> {
    this.assertActive();
    return this.att.withLock(() => runStatement(this.att.session, this.handle, sql, params));
  }

  /** Run a statement, returning only the affected-record count. */
  async execute(sql: string, params: ParamValue[] = []): Promise<number> {
    return (await this.run(sql, params)).rowsAffected;
  }

  /**
   * Stream rows lazily within THIS transaction (no commit/rollback here —
   * the caller owns the transaction). Backpressure at batch granularity.
   */
  queryStream(sql: string, params: ParamValue[] = []): AsyncGenerator<Row> {
    this.assertActive();
    return streamRows(this.att.session, this.handle, sql, params, (fn) => this.att.withLock(fn));
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
