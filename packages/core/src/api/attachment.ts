import { Transport } from '../protocol/transport.js';
import { WireConnection } from '../protocol/wire.js';
import { performHandshake, type HandshakeResult } from '../protocol/handshake.js';
import { attachDatabase, createDatabase, detachDatabase, dropDatabase } from '../protocol/attach.js';
import { startTransaction, type TransactionOptions } from '../protocol/transaction.js';
import {
  prepareInfo,
  runStatement,
  streamRows,
  type QueryOptions,
  type QueryResult,
  type Row,
  type SessionContext,
} from './session.js';
import { FirebirdBlobError, FirebirdConnectionError } from './errors.js';
import { StatementCache } from './statement-cache.js';
import { InlineBlobCache } from './inline-cache.js';
import { PreparedStatement } from './prepared.js';
import { Transaction } from './transaction.js';
import { blobsMayProduceLazy, resolveOptions, type FirebirdConnectionOptions, type LegacyOptionAliases, type ResolvedOptions } from './options.js';
import { Op } from '../protocol/constants.js';
import { executeScript, type ExecuteScriptOptions, type ScriptExecutionResult } from '../script/execute.js';
import { EventChannel, type EventListener } from '../events/events.js';
import { rewriteNamedParams, type QueryParams } from './named-params.js';

export type ConnectInput = FirebirdConnectionOptions & LegacyOptionAliases;

/** An open database attachment. Obtain via `connect()` or `createDatabase()`. */
export class Attachment {
  private detached = false;
  private eventChannel: EventChannel | null = null;
  /** Serializes wire operations — one logical op at a time per connection. */
  private opChain: Promise<unknown> = Promise.resolve();
  /** @internal */
  readonly session: SessionContext;

  private constructor(
    readonly wire: WireConnection,
    readonly options: ResolvedOptions,
    readonly handshake: HandshakeResult,
    readonly dbHandle: number,
  ) {
    // FB 5.0.2+ inline blobs (protocol ≥ 19): announce the size in every
    // op_execute, and route incoming op_inline_blob packets to a tx-scoped
    // cache that blob reads consult first (zero round trips on a hit).
    let inline: InlineBlobCache | null = null;
    if (handshake.protocolVersion >= 19 && options.maxInlineBlobSize > 0) {
      inline = new InlineBlobCache(options.maxBlobCacheSize);
      wire.inlineBlobSize = options.maxInlineBlobSize;
      wire.onInlineBlob = (txId, blobId, _info, data) => inline!.store(txId, blobId, data);
    }
    this.session = {
      wire,
      dbHandle,
      opts: options,
      cache: options.statementCacheSize > 0 ? new StatementCache(wire, options.statementCacheSize) : null,
      lock: (fn) => this.withLock(fn),
      inline: inline ?? undefined,
    };
  }

  /**
   * Packet flushes performed on this connection so far (≈ round trips).
   * Useful for performance assertions and diagnostics.
   */
  get roundTrips(): number {
    return this.wire.flushCount;
  }

  /** @internal */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.catch(() => undefined);
    return next;
  }

  static async open(raw: ConnectInput, mode: 'attach' | 'create' = 'attach'): Promise<Attachment> {
    const opts = resolveOptions(raw);
    const transport = await Transport.connect({
      host: opts.host,
      port: opts.port,
      connectTimeoutMs: opts.connectTimeoutMs,
    });
    const wire = new WireConnection(transport);
    try {
      // The connect deadline must cover the handshake + attach, not just the
      // TCP connect: a loaded server can accept the socket then stall on its
      // responses, which would otherwise hang the read forever.
      const handle = await withTimeout(
        opts.connectTimeoutMs,
        `Handshake/attach to ${opts.host}:${opts.port}`,
        async () => {
          const hs = await performHandshake(wire, {
            database: opts.database,
            user: opts.user,
            password: opts.password,
            wireCrypt: opts.wireCrypt,
            wireCompression: opts.wireCompression,
            wireCryptPlugin: opts.wireCryptPlugin,
            authPlugin: opts.authPlugin,
            srpSeed: opts.srpSeed,
          });
          const h =
            mode === 'create'
              ? await createDatabase(wire, opts, hs.dpbAuthData, hs.pendingAuth)
              : await attachDatabase(wire, opts, hs.dpbAuthData, hs.pendingAuth);
          return { hs, h };
        },
      );
      return new Attachment(wire, opts, handle.hs, handle.h);
    } catch (err) {
      wire.close();
      throw err;
    }
  }

  /** Negotiated protocol version (13 = FB3 … 16 = FB4/5). */
  get protocolVersion(): number {
    return this.handshake.protocolVersion;
  }

  get wireEncrypted(): boolean {
    return this.handshake.encrypted;
  }

  /** Negotiated wire-crypt plugin (Arc4/ChaCha/ChaCha64), or null. */
  get wireCryptPlugin(): string | null {
    return this.handshake.cryptPlugin;
  }

  get wireCompressed(): boolean {
    return this.handshake.compressed;
  }

  /** Start an explicit transaction. */
  async startTransaction(options?: TransactionOptions): Promise<Transaction> {
    const handle = await this.withLock(() => startTransaction(this.wire, this.dbHandle, options));
    return new Transaction(this, handle, options ?? {});
  }

  /**
   * Run `fn` inside a transaction: commits on success, rolls back on error.
   */
  async transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
    const tx = await this.startTransaction(options);
    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (err) {
      if (!tx.isFinished) {
        try {
          await tx.rollback();
        } catch {
          /* surface the original error */
        }
      }
      throw err;
    }
  }

  /**
   * Run a single statement in its own transaction and return the rows.
   * Type rows via the generic: `db.query<{ ID: number }>('select id from t')`.
   * (Compile-time shaping only — no runtime validation.)
   */
  async query<T = Row>(sql: string, params: QueryParams = [], options?: QueryOptions): Promise<T[]> {
    return (await this.run<T>(sql, params, options)).rows;
  }

  /**
   * Run a statement and return the FIRST row, or `undefined` when the result
   * is empty. The whole result set is still fetched — put `FIRST 1` (or a
   * unique predicate) in the SQL when the query could match many rows.
   */
  async queryOne<T = Row>(sql: string, params: QueryParams = [], options?: QueryOptions): Promise<T | undefined> {
    return (await this.run<T>(sql, params, options)).rows[0];
  }

  /**
   * Prepare a statement for repeated execution (pinned outside the LRU
   * cache). Close it when done.
   */
  async prepare(sql: string): Promise<PreparedStatement> {
    // Rewrite @name → ? once, at prepare time; the ordered names let the
    // statement bind a named-params object on each run.
    const { sql: wireSql, names } = rewriteNamedParams(sql);
    const tx = await this.startTransaction();
    try {
      const info = await this.withLock(() => prepareInfo(this.session, tx.handle, wireSql));
      await tx.commit(); // statements outlive the preparing transaction
      return new PreparedStatement(this, info, sql, names);
    } catch (err) {
      if (!tx.isFinished) {
        try {
          await tx.rollback();
        } catch {
          /* surface the original error */
        }
      }
      throw err;
    }
  }

  /** Run a single statement in its own transaction; returns rows + count. */
  async run<T = Row>(sql: string, params: QueryParams = [], options?: QueryOptions): Promise<QueryResult<T>> {
    if (blobsMayProduceLazy(options?.blobs ?? this.options.blobs)) {
      throw new FirebirdBlobError(
        "lazy blob modes ('lazy', 'lazy-binary', 'lazy-text') require an explicit transaction or a stream — use db.transaction(tx => tx.query(…, {blobs:…})) or db.queryStream(…, {blobs:…}), or override with {blobs:'eager'}",
      );
    }
    const tx = await this.startTransaction();
    try {
      const result = await this.withLock(() =>
        runStatement(this.session, tx.handle, sql, params, { query: options ?? {}, txAlive: () => !tx.isFinished }),
      );
      await tx.commit();
      return result as QueryResult<T>;
    } catch (err) {
      if (!tx.isFinished) {
        try {
          await tx.rollback();
        } catch {
          /* surface the original error */
        }
      }
      throw err;
    }
  }

  /** Run a single statement in its own transaction; returns affected count. */
  async execute(sql: string, params: QueryParams = [], options?: QueryOptions): Promise<number> {
    return (await this.run(sql, params, options)).rowsAffected;
  }

  /**
   * Stream rows lazily in its own transaction (committed when iteration ends,
   * rolled back on error or early break). Rows arrive in adaptively-sized
   * batches; the next fetch only fires as you consume — backpressure-friendly
   * for large result sets. Do not run other statements on THIS connection
   * while iterating; use a separate connection (or the pool) for concurrency.
   *
   * ```ts
   * for await (const row of db.queryStream('select * from big_table')) { … }
   * ```
   */
  /**
   * Parse and execute a multi-statement Firebird script (handles `SET TERM`,
   * PSQL bodies, comments, strings). See `ExecuteScriptOptions` for
   * transaction scoping and error handling.
   */
  executeScript(script: string, options?: ExecuteScriptOptions): Promise<ScriptExecutionResult> {
    return executeScript(this, script, options);
  }

  /**
   * Subscribe to Firebird `POST_EVENT` notifications. Returns a started
   * `EventListener` (an EventEmitter): `.on(name, count => …)` per event,
   * `.on('post', (name, count) => …)` for any, `.on('error', …)`. Call
   * `.close()` when done. Uses a separate async channel, so it does not block
   * queries on this connection.
   *
   * ```ts
   * const ev = await db.events(['order_placed']);
   * ev.on('order_placed', (count) => refresh());
   * ```
   */
  async events(names: string[]): Promise<EventListener> {
    if (this.detached) throw new Error('Attachment already closed');
    if (names.length === 0) throw new Error('events() requires at least one event name');
    this.eventChannel ??= new EventChannel(this, this.options.host);
    return this.eventChannel.subscribe(names);
  }

  /** @internal Called by the channel when its last subscription closes. */
  detachEventChannel(): void {
    this.eventChannel = null;
  }

  async *queryStream<T = Row>(sql: string, params: QueryParams = [], options?: QueryOptions): AsyncGenerator<T> {
    const tx = await this.startTransaction();
    let ok = false;
    try {
      yield* streamRows(this.session, tx.handle, sql, params, (fn) => this.withLock(fn), {
        query: options ?? {},
        txAlive: () => !tx.isFinished && this.isAlive,
      }) as AsyncGenerator<T>;
      ok = true;
    } finally {
      if (!tx.isFinished) {
        try {
          if (ok) await tx.commit();
          else await tx.rollback();
        } catch {
          /* surface the original outcome */
        }
      }
    }
  }

  /** True while the connection is usable (socket open, not detached). */
  get isAlive(): boolean {
    return !this.detached && this.wire.transport.isOpen;
  }

  /** Cheap liveness check via op_ping (one round trip). */
  async ping(): Promise<void> {
    await this.withLock(async () => {
      this.wire.writer.int32(Op.ping);
      this.wire.flush();
      await this.wire.readResponse();
    });
  }

  /**
   * Drop every cached prepared statement and release the server handles NOW
   * (the deferred op_free_statements ride one op_ping round trip). Prepared
   * statements pin table metadata, so run this before DDL like
   * `recreate table` — otherwise it fails with "object ... is in use".
   */
  async clearStatementCache(): Promise<void> {
    const cache = this.session.cache;
    if (!cache || cache.size === 0) return;
    await this.withLock(async () => {
      cache.clear(); // queues one deferred op_free_statement per handle
      this.wire.writer.int32(Op.ping);
      this.wire.flush(); // the deferred frees ride this packet
      await this.wire.readResponse();
    });
  }

  /** `await using db = await connect(…)` → disconnects at scope exit. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect();
  }

  async disconnect(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    this.eventChannel?.closeAll();
    this.eventChannel = null;
    this.session.inline?.clear();
    try {
      await detachDatabase(this.wire);
    } catch {
      // Connection already dead — closing the socket is all that's left.
    } finally {
      this.wire.close();
    }
  }

  /** Drops the attached database file on the server, then closes. */
  async dropDatabase(): Promise<void> {
    if (this.detached) throw new Error('Attachment already closed');
    this.detached = true;
    try {
      await dropDatabase(this.wire, this.dbHandle);
    } finally {
      this.wire.close();
    }
  }
}

/** Reject if `fn` doesn't settle within `ms` (covers stalled server responses). */
async function withTimeout<T>(ms: number, label: string, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FirebirdConnectionError(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function connect(options: ConnectInput): Promise<Attachment> {
  return Attachment.open(options, 'attach');
}

export function create(options: ConnectInput): Promise<Attachment> {
  return Attachment.open(options, 'create');
}
