import { Transport } from '../protocol/transport.js';
import { WireConnection } from '../protocol/wire.js';
import { performHandshake, readResponseWithAuth } from '../protocol/handshake.js';
import { Info, Op, SERVICE_MGR, Spb, SvcAction, SvcInfo } from '../protocol/constants.js';
import { ParamBuffer } from '../protocol/buffers.js';
import { resolveOptions, type FirebirdConnectionOptions, type LegacyOptionAliases } from '../api/options.js';

export interface ServiceConnectOptions
  extends Omit<FirebirdConnectionOptions, 'database'>,
    Omit<LegacyOptionAliases, never> {
  database?: string; // ignored for services; kept for option-shape reuse
}

export interface ServerInfo {
  /** Full server version string, e.g. "LI-V5.0.4.1812 Firebird 5.0". */
  serverVersion: string;
  /** Services-manager protocol version number. */
  serviceVersion: number;
  /** Server implementation string. */
  implementation: string;
  /** Path to the security database in use. */
  securityDatabase?: string;
}

/**
 * A connection to the Firebird Service Manager (`service_mgr`). Supports
 * server metadata queries and streaming service actions (e.g. database
 * statistics). Uses the same SRP handshake + wire crypt as a normal
 * attachment. Call `disconnect()` when done.
 */
export class Service {
  private detached = false;
  private opChain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly wire: WireConnection,
    private readonly handle: number,
  ) {}

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(fn, fn);
    this.opChain = next.catch(() => undefined);
    return next;
  }

  static async connect(raw: ServiceConnectOptions): Promise<Service> {
    const opts = resolveOptions({ ...raw, database: SERVICE_MGR });
    const transport = await Transport.connect({
      host: opts.host,
      port: opts.port,
      connectTimeoutMs: opts.connectTimeoutMs,
    });
    const wire = new WireConnection(transport);
    try {
      const hs = await performHandshake(wire, {
        database: SERVICE_MGR,
        user: opts.user,
        password: opts.password,
        wireCrypt: opts.wireCrypt,
        wireCompression: opts.wireCompression,
        wireCryptPlugin: opts.wireCryptPlugin,
        authPlugin: opts.authPlugin,
      });
      const spb = buildAttachSpb(opts.user, hs.dpbAuthData);
      wire.writer.int32(Op.service_attach).int32(0).string(SERVICE_MGR).opaque(spb);
      wire.flush();
      // Service attach may still require SRP continuation (FB3 crypt-off path).
      const resp = await readResponseWithAuth(wire, hs.pendingAuth);
      return new Service(wire, resp.handle);
    } catch (err) {
      wire.close();
      throw err;
    }
  }

  /** Query the server for version, implementation and security-db path. */
  async getServerInfo(): Promise<ServerInfo> {
    const items = Buffer.from([
      SvcInfo.version,
      SvcInfo.server_version,
      SvcInfo.implementation,
      SvcInfo.user_dbpath,
    ]);
    const data = await this.serviceInfo(items);
    const info: ServerInfo = { serverVersion: '', serviceVersion: 0, implementation: '' };
    parseServiceInfo(data, (item, reader) => {
      switch (item) {
        case SvcInfo.version:
          info.serviceVersion = reader.int();
          break;
        case SvcInfo.server_version:
          info.serverVersion = reader.string();
          break;
        case SvcInfo.implementation:
          info.implementation = reader.string();
          break;
        case SvcInfo.user_dbpath:
          info.securityDatabase = reader.string();
          break;
        default:
          reader.skip();
      }
    });
    return info;
  }

  /** Retrieve database statistics (gstat) as text, streamed to completion. */
  async getStatistics(database: string): Promise<string> {
    // SpbStart structure: first byte is the action, string params use a
    // 2-byte length (StringSpb). See ClumpletReader.cpp SpbStart/StringSpb.
    const spb = new ParamBuffer();
    spb.tag(SvcAction.db_stats);
    spb.string2(Spb.dbname, database);
    await this.serviceStart(spb.toBuffer());
    return this.collectOutput();
  }

  /** Low-level: start an arbitrary service action from a raw SPB. */
  async serviceStart(spb: Buffer): Promise<void> {
    await this.withLock(async () => {
      this.wire.writer.int32(Op.service_start).int32(this.handle).int32(0).opaque(spb);
      this.wire.flush();
      await this.wire.readResponse();
    });
  }

  /**
   * Low-level: one op_service_info round trip; returns the info buffer.
   * Wire order (protocol.cpp): p_info_items (a send-SPB, usually empty),
   * then p_info_recv_items (the isc_info_svc_* codes we want back).
   */
  serviceInfo(resultItems: Buffer, sendSpb: Buffer = Buffer.alloc(0), bufferLength = 65535): Promise<Buffer> {
    return this.withLock(async () => {
      this.wire.writer
        .int32(Op.service_info)
        .int32(this.handle)
        .int32(0)
        .opaque(sendSpb) // p_info_items
        .opaque(resultItems) // p_info_recv_items
        .int32(bufferLength);
      this.wire.flush();
      return Buffer.from((await this.wire.readResponse()).data);
    });
  }

  /** Drain line-oriented service output (isc_info_svc_to_eof) to a string. */
  private async collectOutput(): Promise<string> {
    let out = '';
    for (;;) {
      const data = await this.serviceInfo(Buffer.from([SvcInfo.to_eof]));
      let done = true;
      let chunk = '';
      parseServiceInfo(data, (item, reader) => {
        if (item === SvcInfo.to_eof) {
          chunk += reader.string();
          done = chunk.length === 0;
        } else if (item === Info.truncated) {
          done = false;
          reader.skip();
        } else {
          reader.skip();
        }
      });
      out += chunk;
      if (done) break;
    }
    return out;
  }

  async disconnect(): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    try {
      await this.withLock(async () => {
        this.wire.writer.int32(Op.service_detach).int32(this.handle);
        this.wire.flush();
        await this.wire.readResponse();
      });
    } catch {
      /* already gone */
    } finally {
      this.wire.close();
    }
  }
}

function buildAttachSpb(user: string, authData: string | null): Buffer {
  // SpbAttach requires a DOUBLED version header:
  // [isc_spb_version(2)][isc_spb_current_version(2)] then TraditionalDpb params.
  const pb = new ParamBuffer();
  pb.tag(Spb.current_version).tag(Spb.current_version);
  pb.bytes(Spb.utf8_filename, Buffer.alloc(0));
  pb.string(Spb.user_name, user);
  if (authData) pb.string(Spb.specific_auth_data, authData, (s) => Buffer.from(s, 'latin1'));
  return pb.toBuffer();
}

/** Reader over one service-info cluster (UInt16LE length-prefixed values). */
interface ClusterReader {
  int(): number;
  string(): string;
  skip(): void;
}

/** Walk a service-info response, invoking `visit(item, reader)` per cluster. */
function parseServiceInfo(buf: Buffer, visit: (item: number, reader: ClusterReader) => void): void {
  let pos = 0;
  while (pos < buf.length) {
    const item = buf[pos++]!;
    if (item === Info.end) break;
    const reader: ClusterReader = {
      int() {
        const len = buf.readUInt16LE(pos);
        pos += 2;
        let v = 0;
        for (let k = 0; k < len; k++) v |= buf[pos + k]! << (8 * k);
        pos += len;
        return v;
      },
      string() {
        const len = buf.readUInt16LE(pos);
        pos += 2;
        const s = buf.toString('latin1', pos, pos + len);
        pos += len;
        return s;
      },
      skip() {
        const len = buf.readUInt16LE(pos);
        pos += 2 + len;
      },
    };
    // isc_info_end / truncated carry no length; guard.
    if (item === Info.truncated) {
      visit(item, reader);
      continue;
    }
    visit(item, reader);
  }
}

export function connectService(options: ServiceConnectOptions): Promise<Service> {
  return Service.connect(options);
}
