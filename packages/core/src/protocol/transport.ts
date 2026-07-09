import { Socket, connect as netConnect } from 'node:net';
import { createDeflate, createInflate, constants as zc, type Deflate, type Inflate } from 'node:zlib';

/**
 * Symmetric byte filter for wire encryption (e.g. Arc4). Synchronous.
 * Compression is NOT a WireFilter — it is a stateful stream stage owned by
 * the transport (see pipeline order below).
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
 * TCP transport with an awaitable exact-read interface.
 *
 * Wire pipeline (matching Firebird's layering — compression beneath crypt):
 *   send:    packet → [deflate] → [encrypt] → socket
 *   receive: socket → [decrypt] → [inflate] → ByteQueue
 *
 * Encryption is split tx/rx: the rx side decrypts from the moment op_crypt is
 * sent (the response already comes back encrypted), while the tx side must
 * not engage until the compressor has flushed op_crypt itself — hence the
 * flush barrier in `installCrypt`.
 */
export class Transport {
  private socket!: Socket;
  private readonly rx = new ByteQueue();
  private rxWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private txCrypt: WireFilter | null = null;
  private rxCrypt: WireFilter | null = null;
  private deflater: Deflate | null = null;
  private inflater: Inflate | null = null;
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

  /**
   * Enable zlib wire compression (both directions), as negotiated via
   * pflag_compress. Must be called before any compressed bytes arrive —
   * i.e. immediately after parsing the accept packet.
   */
  enableCompression(): void {
    this.deflater = createDeflate({ flush: zc.Z_SYNC_FLUSH });
    this.deflater.on('data', (chunk: Buffer) => this.socketWrite(chunk));
    this.deflater.on('error', (err: Error) => this.fail(err));

    this.inflater = createInflate();
    this.inflater.on('data', (chunk: Buffer) => this.enqueue(chunk));
    this.inflater.on('error', (err: Error) => this.fail(err));
  }

  get compressionEnabled(): boolean {
    return this.deflater !== null;
  }

  /**
   * Engage wire encryption. Decryption applies to all bytes arriving after
   * this call; encryption engages once pending compressed output (the
   * op_crypt packet) has drained.
   */
  installCrypt(filter: WireFilter): Promise<void> {
    this.rxCrypt = filter;
    if (!this.deflater) {
      this.txCrypt = filter;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.deflater!.flush(zc.Z_SYNC_FLUSH, () => {
        this.txCrypt = filter;
        resolve();
      });
    });
  }

  private onData(data: Buffer): void {
    if (this.rxCrypt) data = this.rxCrypt.receive(data);
    if (this.inflater) {
      this.inflater.write(data);
    } else {
      this.enqueue(data);
    }
  }

  private enqueue(data: Buffer): void {
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

  /** True while the socket is usable (not errored, not closed). */
  get isOpen(): boolean {
    return !this.error && !this.closed;
  }

  /** Send one packet through the pipeline. */
  write(data: Buffer): void {
    if (this.error) throw this.error;
    if (this.deflater) {
      this.deflater.write(data);
    } else {
      this.socketWrite(data);
    }
  }

  private socketWrite(data: Buffer): void {
    if (this.error) return; // compressed chunks may drain after failure
    if (this.txCrypt) data = this.txCrypt.send(data);
    this.socket.write(data);
  }

  close(): void {
    this.closed = true;
    this.deflater?.destroy();
    this.inflater?.destroy();
    this.socket.destroy();
  }
}
