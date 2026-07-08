import { Transport } from '../protocol/transport.js';
import { WireConnection } from '../protocol/wire.js';
import { performHandshake, type HandshakeResult } from '../protocol/handshake.js';
import { attachDatabase, createDatabase, detachDatabase, dropDatabase } from '../protocol/attach.js';
import { startTransaction, type TransactionOptions } from '../protocol/transaction.js';
import { runStatement, type QueryResult, type Row } from './session.js';
import { Transaction } from './transaction.js';
import { resolveOptions, type FirebirdConnectionOptions, type LegacyOptionAliases, type ResolvedOptions } from './options.js';
import type { ParamValue } from '../protocol/msgcodec.js';

export type ConnectInput = FirebirdConnectionOptions & LegacyOptionAliases;

/** An open database attachment. Obtain via `connect()` or `createDatabase()`. */
export class Attachment {
  private detached = false;
  /** Serializes wire operations — one logical op at a time per connection. */
  private opChain: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly wire: WireConnection,
    readonly options: ResolvedOptions,
    readonly handshake: HandshakeResult,
    readonly dbHandle: number,
  ) {}

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
        authPlugin: opts.authPlugin,
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

  /** Run a single statement in its own transaction; returns rows + count. */
  async run(sql: string, params: ParamValue[] = []): Promise<QueryResult> {
    const tx = await this.startTransaction();
    try {
      const result = await this.withLock(() =>
        runStatement(this.wire, this.dbHandle, tx.handle, sql, params, this.options),
      );
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

  async disconnect(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    try {
      await detachDatabase(this.wire);
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
