import {
  commitTransaction,
  rollbackTransaction,
  startTransaction,
  type TransactionOptions,
} from '../protocol/transaction.js';
import { runStatement, streamRows, type QueryOptions, type QueryResult, type RunContext, type Row } from './session.js';
import { FirebirdError } from './errors.js';
import type { ParamValue } from '../protocol/msgcodec.js';
import type { Attachment } from './attachment.js';

/** isc_read_only_trans: "attempted update during read-only transaction". */
const ISC_READ_ONLY_TRANS = 335544361;

function isReadOnlyViolation(err: unknown): boolean {
  if (err instanceof FirebirdError && err.gdsCode === ISC_READ_ONLY_TRANS) return true;
  return /attempted update during read-only transaction/i.test(String((err as Error)?.message ?? ''));
}

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
  private wasAutoUpgraded = false;

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

  /** True once `autoUpgradeReadOnly` has promoted this transaction to read-write. */
  get autoUpgraded(): boolean {
    return this.wasAutoUpgraded;
  }

  private assertActive(): void {
    if (this.finished) throw new Error('Transaction already committed or rolled back');
  }

  /** @internal Run context binding lazy-blob validity to this tx generation. */
  private runContext(options?: QueryOptions): RunContext {
    const gen = this.generation;
    return { query: options ?? {}, txAlive: () => !this.finished && this.generation === gen && this.att.isAlive };
  }

  /** Run a statement and return its rows (`query<T>` types them). */
  async query<T = Row>(sql: string, params: ParamValue[] = [], options?: QueryOptions): Promise<T[]> {
    return (await this.run<T>(sql, params, options)).rows;
  }

  /**
   * Run a statement and return the FIRST row, or `undefined` when the result
   * is empty. The whole result set is still fetched — put `FIRST 1` (or a
   * unique predicate) in the SQL when the query could match many rows.
   */
  async queryOne<T = Row>(sql: string, params: ParamValue[] = [], options?: QueryOptions): Promise<T | undefined> {
    return (await this.run<T>(sql, params, options)).rows[0];
  }

  /** Run a statement and return rows + affected-record count. */
  async run<T = Row>(sql: string, params: ParamValue[] = [], options?: QueryOptions): Promise<QueryResult<T>> {
    this.assertActive();
    const attempt = () =>
      this.att.withLock(() => runStatement(this.att.session, this.handle, sql, params, this.runContext(options)));
    try {
      return (await attempt()) as QueryResult<T>;
    } catch (err) {
      if (!this.shouldAutoUpgrade(err)) throw err;
      // RO→RW auto-upgrade: commit the (write-free) read-only transaction,
      // reopen read-write with the same isolation, replay the statement ONCE.
      // After the upgrade `readOnly` is false, so a second failure propagates.
      await this.restart({ ...this.options, readOnly: false });
      this.wasAutoUpgraded = true;
      return (await attempt()) as QueryResult<T>;
    }
  }

  /** Write refused because THIS transaction is read-only, and upgrading is opted in. */
  private shouldAutoUpgrade(err: unknown): boolean {
    if (this.finished || this.options.readOnly !== true) return false;
    if (!(this.options.autoUpgradeReadOnly ?? this.att.options.autoUpgradeReadOnly)) return false;
    return isReadOnlyViolation(err);
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
  queryStream<T = Row>(sql: string, params: ParamValue[] = [], options?: QueryOptions): AsyncGenerator<T> {
    this.assertActive();
    return streamRows(
      this.att.session,
      this.handle,
      sql,
      params,
      (fn) => this.att.withLock(fn),
      this.runContext(options),
    ) as AsyncGenerator<T>;
  }

  /**
   * `await using tx = await db.startTransaction()` → rolls back at scope
   * exit unless the transaction was committed (or rolled back) explicitly.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.finished) await this.rollback();
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
    this.att.session.inline?.clearTx(this.handle); // unread inline blobs die with the tx
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
    this.att.session.inline?.clearTx(this.handle);
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
