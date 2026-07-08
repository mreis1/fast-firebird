import { Transport } from '../protocol/transport.js';
import { WireConnection } from '../protocol/wire.js';
import { performHandshake, type HandshakeResult } from '../protocol/handshake.js';
import { attachDatabase, createDatabase, detachDatabase, dropDatabase } from '../protocol/attach.js';
import { resolveOptions, type FirebirdConnectionOptions, type LegacyOptionAliases, type ResolvedOptions } from './options.js';

export type ConnectInput = FirebirdConnectionOptions & LegacyOptionAliases;

/** An open database attachment. Obtain via `connect()` or `createDatabase()`. */
export class Attachment {
  private detached = false;

  private constructor(
    readonly wire: WireConnection,
    readonly options: ResolvedOptions,
    readonly handshake: HandshakeResult,
    readonly dbHandle: number,
  ) {}

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
