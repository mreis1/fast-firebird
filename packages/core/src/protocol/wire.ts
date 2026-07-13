import { Transport } from './transport.js';
import { XdrWriter } from './xdr.js';
import { IscArg, Op } from './constants.js';
import { FirebirdError, type StatusVectorArg } from '../api/errors.js';
import messageTable from './messages.json' with { type: 'json' };

const MESSAGES = messageTable as Record<string, { m: string; s?: string }>;

function formatGdsMessage(code: number, params: string[]): { text: string; sqlState?: string } {
  const entry = MESSAGES[String(code)];
  if (!entry) {
    return { text: `Firebird error ${code}${params.length ? ` (${params.join(', ')})` : ''}` };
  }
  const text = entry.m.replace(/@(\d+)/g, (_, n: string) => params[Number(n) - 1] ?? `@${n}`);
  return { text, sqlState: entry.s };
}

export interface GenericResponse {
  handle: number;
  /** 8-byte object id (blob id, etc.) as received. */
  oid: Buffer;
  data: Buffer;
  warnings: StatusVectorArg[];
}

/**
 * Low-level operation reader/writer over the transport. Owns the packet
 * writer (single-flush discipline) and the incremental XDR read helpers.
 */
export class WireConnection {
  readonly writer = new XdrWriter(4096);
  /** Negotiated protocol version; set by the handshake. */
  protocolVersion = 13;
  /**
   * Packet flushes so far — a faithful proxy for round trips, since every
   * flush is followed by at least one awaited response. First-class metric
   * per plans/performance.md; tests assert budgets against it.
   */
  flushCount = 0;
  /** Deferred (lazy-send) operations whose responses are pending, FIFO. */
  private deferredResponses = 0;
  /**
   * Max blob size (bytes) the server may inline with row data — written into
   * every op_execute at protocol ≥ 19. 0 = disabled.
   */
  inlineBlobSize = 0;
  /**
   * op_inline_blob consumer (set by the attachment): the server volunteers
   * small blobs ahead of fetch/sql responses; they must be consumed wherever
   * ops are read, so readOp() dispatches them here.
   */
  onInlineBlob?: (txId: number, blobId: Buffer, info: Buffer, data: Buffer) => void;

  constructor(readonly transport: Transport) {}

  flush(): void {
    if (this.writer.length === 0) return;
    this.flushCount++;
    this.transport.write(this.writer.finish());
  }

  /** Note one deferred op written (response consumed later, FIFO). */
  markDeferred(): void {
    this.deferredResponses++;
  }

  // ── incremental XDR reads ────────────────────────────────────────────────
  async readInt32(): Promise<number> {
    return (await this.transport.read(4)).readInt32BE(0);
  }

  async readOpaque(): Promise<Buffer> {
    const len = (await this.transport.read(4)).readUInt32BE(0);
    if (len === 0) return Buffer.alloc(0);
    const padded = (len + 3) & ~3;
    const data = await this.transport.read(padded);
    return data.subarray(0, len);
  }

  async readString(): Promise<string> {
    return (await this.readOpaque()).toString('utf8');
  }

  /**
   * Read the next operation code, skipping op_dummy keep-alives and
   * consuming any deferred-op responses queued before it.
   */
  async readOp(): Promise<number> {
    for (;;) {
      const op = await this.readInt32();
      if (op === Op.dummy) continue;
      if (op === Op.response && this.deferredResponses > 0) {
        this.deferredResponses--;
        await this.parseResponseBody(); // errors from deferred ops are dropped by design
        continue;
      }
      if (op === Op.inline_blob) {
        // P_INLINE_BLOB: tran id (int32), blob id (8 raw), blob info
        // (counted opaque), blob data (counted opaque; UInt16LE-framed
        // segments inside — same framing as op_get_segment responses).
        const txId = await this.readInt32();
        const blobId = Buffer.from(await this.transport.read(8));
        const info = Buffer.from(await this.readOpaque());
        const data = Buffer.from(await this.readOpaque());
        this.onInlineBlob?.(txId, blobId, info, data); // no handler → drop (stay in sync)
        continue;
      }
      return op;
    }
  }

  /** Expect an op_response; parse it and throw on error status. */
  async readResponse(): Promise<GenericResponse> {
    const op = await this.readOp();
    if (op !== Op.response) {
      throw new FirebirdError(`Protocol error: expected op_response(9), got op ${op}`);
    }
    return this.parseResponseBody();
  }

  async parseResponseBody(): Promise<GenericResponse> {
    const handle = await this.readInt32();
    const oid = Buffer.from(await this.transport.read(8));
    const data = Buffer.from(await this.readOpaque());
    const { error, warnings } = await this.readStatusVector();
    if (error) throw error;
    return { handle, oid, data, warnings };
  }

  /** Decode the status vector; returns an Error if it carries one. */
  async readStatusVector(): Promise<{ error: FirebirdError | null; warnings: StatusVectorArg[] }> {
    interface Cluster {
      code: number;
      warning: boolean;
      params: string[];
      interpreted?: string;
    }
    const args: StatusVectorArg[] = [];
    const clusters: Cluster[] = [];
    let current: Cluster | null = null;
    let sqlState: string | undefined;

    for (;;) {
      const arg = await this.readInt32();
      if (arg === IscArg.end) break;
      switch (arg) {
        case IscArg.gds:
        case IscArg.warning: {
          const code = await this.readInt32();
          if (code !== 0) {
            args.push({ type: 'gds', value: code });
            current = { code, warning: arg === IscArg.warning, params: [] };
            clusters.push(current);
          }
          break;
        }
        case IscArg.string:
        case IscArg.cstring: {
          const s = await this.readString();
          args.push({ type: 'string', value: s });
          current?.params.push(s);
          break;
        }
        case IscArg.interpreted: {
          const s = await this.readString();
          args.push({ type: 'interpreted', value: s });
          if (current) current.interpreted = s;
          break;
        }
        case IscArg.sql_state: {
          const s = await this.readString();
          args.push({ type: 'sql_state', value: s });
          sqlState = s;
          break;
        }
        case IscArg.number: {
          const n = await this.readInt32();
          args.push({ type: 'number', value: n });
          current?.params.push(String(n));
          break;
        }
        default:
          throw new FirebirdError(`Unexpected status vector argument type ${arg}`);
      }
    }

    const errors = clusters.filter((c) => !c.warning);
    if (errors.length === 0) return { error: null, warnings: args };

    const lines: string[] = [];
    let tableSqlState: string | undefined;
    for (const c of errors) {
      const { text, sqlState: s } = formatGdsMessage(c.code, c.params);
      lines.push(c.interpreted ?? text);
      tableSqlState ??= s;
    }
    const first = errors[0]!;
    return {
      error: new FirebirdError(lines.join('\n'), first.code, sqlState ?? tableSqlState, args),
      warnings: [],
    };
  }

  close(): void {
    this.transport.close();
  }
}
