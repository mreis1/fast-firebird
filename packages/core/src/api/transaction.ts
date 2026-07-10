import {
  commitTransaction,
  rollbackTransaction,
  startTransaction,
  type TransactionOptions,
} from '../protocol/transaction.js';
import { runStatement, streamRows, type QueryOptions, type QueryResult, type RunContext, type Row } from './session.js';
import type { ParamValue } from '../protocol/msgcodec.js';
import type { Attachment } from './attachment.js';

export interface RestartOptions extends TransactionOptions {
  /** Finish the current transaction by 'commit' (default) or 'rollback'. */
  action?: 'commit' | 'rollback';
}

/** Keys that constitute a transaction strategy (vs the `action` control). */
function hasStrategy(o: RestartOptions): boolean {
  return o.isolation !== undefined || o.readOnly !== undefined || o.wait !== undefined || o.autoCommit !== undefined;
}

export class Transaction {
  private finished = false;
  private currentHandle: number;
  /** Bumped on restart so lazy blob handles from a prior cycle read as dead. */
  private generation = 0;

  constructor(
    private readonly att: Attachment,
    handle: number,
    private options: TransactionOptions,
  ) {
    this.currentHandle = handle;
  }

  /** Server-side transaction handle (changes across `restart`). */
  get handle(): number {
    return this.currentHandle;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  private assertActive(): void {
    if (this.finished) throw new Error('Transaction already committed or rolled back');
  }

  /** @internal Run context binding lazy-blob validity to this tx generation. */
  private runContext(options?: QueryOptions): RunContext {
    const gen = this.generation;
    return { query: options ?? {}, txAlive: () => !this.finished && this.generation === gen && this.att.isAlive };
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
    try {
      await this.att.withLock(() => commitTransaction(this.att.wire, this.handle));
    } catch (err) {
      // A refused commit leaves the transaction ALIVE server-side — e.g. DDL
      // metadata locks are taken at commit time, so "object in use" surfaces
      // here, not at execute. Reopen so the owner can roll back instead of
      // leaking an active transaction (which blocks all later DDL with
      // "update conflicts with concurrent update").
      this.finished = false;
      throw err;
    }
  }

  async rollback(): Promise<void> {
    this.assertActive();
    this.finished = true;
    try {
      await this.att.withLock(() => rollbackTransaction(this.att.wire, this.handle));
    } catch (err) {
      this.finished = false;
      throw err;
    }
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

  /**
   * Finish the current transaction and immediately start a fresh one on the
   * same connection, reusing the same isolation strategy — or a new one if
   * transaction options are supplied. Reuses this `Transaction` object (its
   * `handle` changes). Any lazy blob handles from before the restart become
   * invalid (reading them throws `FirebirdBlobError`).
   *
   * ```ts
   * await tx.restart();                         // commit, reopen, same strategy
   * await tx.restart({ action: 'rollback' });   // rollback, reopen, same strategy
   * await tx.restart({ readOnly: false });      // commit, reopen with a new strategy
   * ```
   */
  async restart(options: RestartOptions = {}): Promise<void> {
    const action = options.action ?? 'commit';
    if (!this.finished) {
      await this.att.withLock(() =>
        action === 'rollback'
          ? rollbackTransaction(this.att.wire, this.currentHandle)
          : commitTransaction(this.att.wire, this.currentHandle),
      );
    }
    if (hasStrategy(options)) {
      const { action: _drop, ...strategy } = options;
      this.options = strategy;
    }
    this.currentHandle = await this.att.withLock(() => startTransaction(this.att.wire, this.att.dbHandle, this.options));
    this.generation++;
    this.finished = false;
  }
}
