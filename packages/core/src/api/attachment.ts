import { Transport } from '../protocol/transport.js';
import { WireConnection } from '../protocol/wire.js';
import { performHandshake, type HandshakeResult } from '../protocol/handshake.js';
import { attachDatabase, createDatabase, detachDatabase, dropDatabase } from '../protocol/attach.js';
import { startTransaction, type TransactionOptions } from '../protocol/transaction.js';
import { prepareInfo, runStatement, streamRows, type QueryResult, type Row, type SessionContext } from './session.js';
import { StatementCache } from './statement-cache.js';
import { PreparedStatement } from './prepared.js';
import { Transaction } from './transaction.js';
import { resolveOptions, type FirebirdConnectionOptions, type LegacyOptionAliases, type ResolvedOptions } from './options.js';
import { Op } from '../protocol/constants.js';
import type { ParamValue } from '../protocol/msgcodec.js';

export type ConnectInput = FirebirdConnectionOptions & LegacyOptionAliases;

/** An open database attachment. Obtain via `connect()` or `createDatabase()`. */
export class Attachment {
  private detached = false;
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
    this.session = {
      wire,
      dbHandle,
      opts: options,
      cache: options.statementCacheSize > 0 ? new StatementCache(wire, options.statementCacheSize) : null,
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
      const handle =
        mode === 'create'
          ? await createDatabase(wire, opts, hs.dpbAuthData, hs.pendingAuth)
          : await attachDatabase(wire, opts, hs.dpbAuthData, hs.pendingAuth);
      return new Attachment(wire, opts, hs, handle);
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
    return new Transaction(this, handle);
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

  /** Run a single statement in its own transaction and return the rows. */
  async query(sql: string, params: ParamValue[] = []): Promise<Row[]> {
    return (await this.run(sql, params)).rows;
  }

  /**
   * Prepare a statement for repeated execution (pinned outside the LRU
   * cache). Close it when done.
   */
  async prepare(sql: string): Promise<PreparedStatement> {
    const tx = await this.startTransaction();
    try {
      const info = await this.withLock(() => prepareInfo(this.session, tx.handle, sql));
      await tx.commit(); // statements outlive the preparing transaction
      return new PreparedStatement(this, info, sql);
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
  async run(sql: string, params: ParamValue[] = []): Promise<QueryResult> {
    const tx = await this.startTransaction();
    try {
      const result = await this.withLock(() => runStatement(this.session, tx.handle, sql, params));
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

  /** Run a single statement in its own transaction; returns affected count. */
  async execute(sql: string, params: ParamValue[] = []): Promise<number> {
    return (await this.run(sql, params)).rowsAffected;
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
  async *queryStream(sql: string, params: ParamValue[] = []): AsyncGenerator<Row> {
    const tx = await this.startTransaction();
    let ok = false;
    try {
      yield* streamRows(this.session, tx.handle, sql, params, (fn) => this.withLock(fn));
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

  async disconnect(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
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

export function connect(options: ConnectInput): Promise<Attachment> {
  return Attachment.open(options, 'attach');
}

export function create(options: ConnectInput): Promise<Attachment> {
  return Attachment.open(options, 'create');
}
