import { commitTransaction, rollbackTransaction } from '../protocol/transaction.js';
import { runStatement, type QueryResult, type Row } from './session.js';
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
    return this.att.withLock(() =>
      runStatement(this.att.wire, this.att.dbHandle, this.handle, sql, params, this.att.options),
    );
  }

  /** Run a statement, returning only the affected-record count. */
  async execute(sql: string, params: ParamValue[] = []): Promise<number> {
    return (await this.run(sql, params)).rowsAffected;
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
