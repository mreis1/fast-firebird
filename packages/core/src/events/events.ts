import { EventEmitter } from 'node:events';
import { Transport } from '../protocol/transport.js';
import { WireConnection } from '../protocol/wire.js';
import { EPB_VERSION1, Op, P_REQ_ASYNC } from '../protocol/constants.js';
import type { Attachment } from '../api/attachment.js';

const MAX_EVENT_NAME = 255;

function buildEpb(counts: Map<string, number>): Buffer {
  const parts: number[] = [EPB_VERSION1];
  for (const [name, count] of counts) {
    const bytes = Buffer.from(name, 'latin1');
    if (bytes.length > MAX_EVENT_NAME) throw new Error(`Event name too long: ${name}`);
    parts.push(bytes.length, ...bytes, count & 0xff, (count >> 8) & 0xff, (count >> 16) & 0xff, (count >>> 24) & 0xff);
  }
  return Buffer.from(parts);
}

function parseEpb(buf: Buffer): Map<string, number> {
  const counts = new Map<string, number>();
  let pos = 1; // skip version byte
  while (pos < buf.length) {
    const len = buf[pos++]!;
    const name = buf.toString('latin1', pos, pos + len);
    pos += len;
    const count = buf.readUInt32LE(pos);
    pos += 4;
    counts.set(name, count);
  }
  return counts;
}

/**
 * Per-attachment async event channel. Firebird gives a connection exactly one
 * async aux port; every subscription flows over it and is demultiplexed by
 * request id (rid). Created lazily on the first subscription and torn down
 * when the last one closes.
 */
export class EventChannel {
  private transport: Transport | null = null;
  private wire: WireConnection | null = null;
  private readonly subs = new Map<number, EventListener>();
  private static nextRid = 1;
  private starting: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly att: Attachment,
    private readonly auxHost: string,
  ) {}

  private async ensureStarted(): Promise<void> {
    if (this.wire) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const resp = await this.att.withLock(async () => {
        this.att.wire.writer.int32(Op.connect_request).int32(P_REQ_ASYNC).int32(this.att.dbHandle).int32(0);
        this.att.wire.flush();
        return this.att.wire.readResponse();
      });
      if (resp.data.length < 4) throw new Error('Event aux-port response missing address');
      const port = resp.data.readUInt16BE(2);
      this.transport = await Transport.connect({ host: this.auxHost, port });
      this.wire = new WireConnection(this.transport);
      void this.readLoop();
    })();
    return this.starting;
  }

  /** Subscribe to a set of events; returns a started listener. */
  async subscribe(names: string[]): Promise<EventListener> {
    await this.ensureStarted();
    const rid = EventChannel.nextRid++;
    const listener = new EventListener(this, rid, names);
    this.subs.set(rid, listener);
    await this.queEvents(listener);
    return listener;
  }

  /** @internal Arm (or re-arm) a subscription's request with its counts. */
  async queEvents(listener: EventListener): Promise<void> {
    if (this.closed) return;
    const epb = buildEpb(listener.counts);
    await this.att.withLock(async () => {
      this.att.wire.writer
        .int32(Op.que_events)
        .int32(this.att.dbHandle)
        .opaque(epb)
        .int32(0) // ast
        .int32(0) // arg
        .int32(listener.rid);
      this.att.wire.flush();
      await this.att.wire.readResponse();
    });
  }

  private async readLoop(): Promise<void> {
    const wire = this.wire!;
    try {
      while (!this.closed) {
        const op = await wire.readOp();
        if (op !== Op.event) {
          if (op === Op.exit || op === Op.disconnect) break;
          continue;
        }
        await wire.readInt32(); // database
        const epb = Buffer.from(await wire.readOpaque());
        await wire.readInt32(); // ast
        await wire.readInt32(); // arg
        const rid = await wire.readInt32();
        if (this.closed) break;
        const listener = this.subs.get(rid);
        if (!listener) continue; // cancelled subscription
        listener.deliver(parseEpb(epb));
        await this.queEvents(listener); // one-shot: re-arm
      }
    } catch (err) {
      if (!this.closed) {
        for (const l of this.subs.values()) l.emit('error', err);
      }
    }
  }

  /** @internal Cancel a subscription; tears the channel down when empty. */
  async unsubscribe(listener: EventListener): Promise<void> {
    if (!this.subs.delete(listener.rid)) return;
    try {
      await this.att.withLock(async () => {
        this.att.wire.writer.int32(Op.cancel_events).int32(this.att.dbHandle).int32(listener.rid);
        this.att.wire.flush();
        await this.att.wire.readResponse();
      });
    } catch {
      /* connection may already be gone */
    }
    if (this.subs.size === 0) await this.shutdown();
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    const t = this.transport;
    this.transport = null;
    this.wire = null;
    this.att.detachEventChannel();
    // FIN, not RST — abrupt closes corrupt FB3's event-port cleanup.
    if (t) await t.endGracefully();
  }

  /** Force-close the whole channel (used on attachment disconnect). */
  closeAll(): void {
    this.closed = true;
    this.subs.clear();
    void this.transport?.endGracefully();
    this.transport = null;
    this.wire = null;
  }
}

/**
 * A live subscription to Firebird `POST_EVENT` notifications.
 *
 * Emits the event name with the current (cumulative) count and `'post'` with
 * `(name, count)` for any subscribed event. The first delivery per event
 * establishes the baseline and does NOT fire — only posts after subscription
 * are reported. Emits `'error'` on aux-channel failure. Call `close()` when
 * done. Firebird's one-shot requests are re-armed automatically, so posts
 * between deliveries are not missed.
 */
export class EventListener extends EventEmitter {
  /** @internal current cumulative counts (also the re-arm baseline). */
  readonly counts = new Map<string, number>();
  private readonly baselined = new Set<string>();
  private closed = false;

  /** @internal */
  constructor(
    private readonly channel: EventChannel,
    readonly rid: number,
    names: string[],
  ) {
    super();
    for (const n of names) this.counts.set(n, 0);
  }

  /** @internal apply a server count update, firing deltas past the baseline. */
  deliver(serverCounts: Map<string, number>): void {
    for (const [name, count] of serverCounts) {
      const prev = this.counts.get(name) ?? 0;
      this.counts.set(name, count);
      if (!this.baselined.has(name)) {
        this.baselined.add(name);
        continue;
      }
      if (count > prev) {
        this.emit(name, count);
        this.emit('post', name, count);
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.channel.unsubscribe(this);
  }
}
