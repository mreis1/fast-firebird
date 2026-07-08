import { Socket, connect as netConnect } from 'node:net';

/**
 * Bidirectional byte filter installed on the wire (encryption, compression).
 * Filters are applied to sent bytes in installation order and to received
 * bytes in reverse order.
 */
export interface WireFilter {
  send(data: Buffer): Buffer;
  receive(data: Buffer): Buffer;
}

export interface TransportOptions {
  host: string;
  port: number;
  connectTimeoutMs?: number;
  /** Disable Nagle (we already coalesce writes ourselves). Default true. */
  noDelay?: boolean;
}

class ByteQueue {
  private chunks: Buffer[] = [];
  private head = 0; // offset into chunks[0]
  length = 0;

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** Removes and returns exactly n bytes (caller must check length first). */
  take(n: number): Buffer {
    this.length -= n;
    const first = this.chunks[0]!;
    // Fast path: served entirely from the first chunk.
    if (first.length - this.head >= n) {
      const out = first.subarray(this.head, this.head + n);
      this.head += n;
      if (this.head === first.length) {
        this.chunks.shift();
        this.head = 0;
      }
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let copied = 0;
    while (copied < n) {
      const c = this.chunks[0]!;
      const avail = c.length - this.head;
      const want = Math.min(avail, n - copied);
      c.copy(out, copied, this.head, this.head + want);
      copied += want;
      this.head += want;
      if (this.head === c.length) {
        this.chunks.shift();
        this.head = 0;
      }
    }
    return out;
  }
}

/**
 * TCP transport with an awaitable exact-read interface and pluggable
 * wire filters. Writes are explicitly coalesced: callers build one or more
 * packets and flush them in a single socket write (round-trip discipline).
 */
export class Transport {
  private socket!: Socket;
  private readonly rx = new ByteQueue();
  private rxWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private filters: WireFilter[] = [];
  private error: Error | null = null;
  private closed = false;

  static async connect(opts: TransportOptions): Promise<Transport> {
    const t = new Transport();
    await t.open(opts);
    return t;
  }

  private open(opts: TransportOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: opts.host, port: opts.port });
      this.socket = socket;
      socket.setNoDelay(opts.noDelay ?? true);

      const timeoutMs = opts.connectTimeoutMs ?? 10_000;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection to ${opts.host}:${opts.port} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        this.fail(err);
        reject(err);
      });
      socket.on('data', (data) => this.onData(data));
      socket.once('close', () => {
        if (!this.closed) this.fail(new Error('Connection closed by remote end'));
      });
    });
  }

  /** Install a filter (e.g. Arc4 after crypt negotiation, zlib for compression). */
  addFilter(filter: WireFilter): void {
    this.filters.push(filter);
  }

  private onData(data: Buffer): void {
    for (let i = this.filters.length - 1; i >= 0; i--) {
      data = this.filters[i]!.receive(data);
    }
    this.rx.push(data);
    this.rxWaiter?.resolve();
  }

  private fail(err: Error): void {
    if (this.error) return;
    this.error = err;
    this.rxWaiter?.reject(err);
    this.rxWaiter = null;
  }

  /** Read exactly n bytes (awaiting socket data as needed). */
  async read(n: number): Promise<Buffer> {
    while (this.rx.length < n) {
      if (this.error) throw this.error;
      await new Promise<void>((resolve, reject) => {
        this.rxWaiter = { resolve, reject };
      });
      this.rxWaiter = null;
    }
    return this.rx.take(n);
  }

  /** Bytes currently buffered (readable without awaiting). */
  get buffered(): number {
    return this.rx.length;
  }

  /** Send bytes through filters in one socket write. */
  write(data: Buffer): void {
    if (this.error) throw this.error;
    for (const f of this.filters) data = f.send(data);
    this.socket.write(data);
  }

  close(): void {
    this.closed = true;
    this.socket.destroy();
  }
}
