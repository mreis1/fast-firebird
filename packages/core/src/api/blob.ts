import { Readable } from 'node:stream';
import { blobTotalLength, closeBlobDeferred, getBlobSegment, openBlob, readBlob, readBlobWindow } from '../protocol/blob.js';
import { FirebirdBlobError } from './errors.js';
import type { WireConnection } from '../protocol/wire.js';
import type { TextCodec } from '../charset/decoder.js';

/**
 * Everything a lazy Blob needs to fetch itself later: the wire, the
 * connection op-lock, its owning transaction handle, and a liveness check.
 * @internal
 */
export interface BlobScope {
  wire: WireConnection;
  lock: <T>(fn: () => Promise<T>) => Promise<T>;
  txHandle: number;
  chunkSize: number;
  /** True while the owning transaction + connection are still usable. */
  isAlive(): boolean;
  /** Optional read-ahead store (queryStream blobReadAhead). */
  prefetch?: {
    take(idHex: string): Promise<Buffer> | null;
    has(idHex: string): boolean;
  };
}

/**
 * A lazy handle to a Firebird blob. Nothing is fetched until you call a
 * method. VALID ONLY until its transaction closes — Firebird blob ids are
 * transaction-scoped; reading one after commit throws `FirebirdBlobError`.
 *
 * `head(n)` reads just the first bytes (magic-number sniffing) and KEEPS the
 * server handle open at its position — a later `buffer()`/`stream()` resumes
 * from there instead of re-transferring (segmented blobs are forward-only).
 */
export class Blob {
  private cached: Buffer | null = null;
  // Forward cursor (head()/resume): everything read so far + the open handle.
  private consumed: Buffer[] = [];
  private consumedBytes = 0;
  private cursorHandle: number | null = null;
  private atEof = false;

  /** @internal */
  constructor(
    private readonly id: Buffer,
    /** Blob subtype: 0 = binary, 1 = text. */
    readonly subType: number,
    private readonly scope: BlobScope,
    private readonly textCodec: TextCodec | null,
  ) {}

  private assertAlive(): void {
    if (!this.scope.isAlive()) {
      throw new FirebirdBlobError(
        "blob handle used after its transaction closed — read lazy blobs before commit, or use blobs:'eager'",
      );
    }
  }

  /**
   * Read the first `n` bytes (e.g. a file's magic number) and keep the
   * server handle open at its position: a later `buffer()`, `stream()` or
   * `head(m > n)` RESUMES the transfer instead of starting over. Returns raw
   * bytes (no charset decode); fewer than `n` when the blob is shorter.
   * Release an unfinished cursor early with `close()` (otherwise it's freed
   * with the transaction).
   */
  async head(n: number): Promise<Buffer> {
    if (n <= 0) return Buffer.alloc(0);
    if (this.cached) return this.cached.subarray(0, Math.min(n, this.cached.length));
    this.assertAlive();
    // Prefetched bytes are already on their way — just materialize.
    if (this.scope.prefetch?.has(this.id.toString('hex'))) {
      const full = await this.buffer();
      return full.subarray(0, Math.min(n, full.length));
    }
    if (!this.atEof && this.consumedBytes < n) {
      await this.scope.lock(async () => {
        if (this.atEof) return;
        if (this.cursorHandle === null) this.cursorHandle = await openBlob(this.scope.wire, this.scope.txHandle, this.id);
        while (!this.atEof && this.consumedBytes < n) {
          const count = Math.max(1, Math.ceil((n - this.consumedBytes) / this.scope.chunkSize));
          const w = await readBlobWindow(this.scope.wire, this.cursorHandle, this.scope.chunkSize, Math.min(count, 32));
          for (const c of w.chunks) {
            this.consumed.push(c);
            this.consumedBytes += c.length;
          }
          if (w.eof) this.finishCursor();
        }
      });
    }
    this.promoteIfComplete();
    const have = this.cached ?? Buffer.concat(this.consumed, this.consumedBytes);
    return have.subarray(0, Math.min(n, have.length));
  }

  /** EOF reached on the cursor: the handle is done — close it (deferred). */
  private finishCursor(): void {
    this.atEof = true;
    if (this.cursorHandle !== null) {
      closeBlobDeferred(this.scope.wire, this.cursorHandle);
      this.cursorHandle = null;
    }
  }

  /** A cursor that consumed the whole blob becomes the cache. */
  private promoteIfComplete(): void {
    if (this.atEof && this.cached === null) {
      this.cached = Buffer.concat(this.consumed, this.consumedBytes);
      this.consumed = [];
    }
  }

  /**
   * Release an open `head()` cursor without finishing the read. Resets the
   * cursor entirely — a later read starts from byte 0 again. No-op when
   * nothing is open.
   */
  async close(): Promise<void> {
    const h = this.cursorHandle;
    this.cursorHandle = null;
    this.consumed = [];
    this.consumedBytes = 0;
    this.atEof = false;
    if (h === null) return;
    await this.scope
      .lock(async () => {
        if (this.scope.isAlive()) closeBlobDeferred(this.scope.wire, h);
      })
      .catch(() => void 0);
  }

  /** Materialize the full blob as a Buffer (cached; subsequent calls are free). */
  async buffer(): Promise<Buffer> {
    if (this.cached) return this.cached;
    this.assertAlive();
    // Read-ahead may already hold (or be fetching) this blob's bytes.
    const prefetched = this.scope.prefetch?.take(this.id.toString('hex'));
    if (prefetched) {
      this.cached = await prefetched;
      return this.cached;
    }
    const data = await this.scope.lock(async () => {
      // No cursor: plain whole-blob read (own open + pipelined segments).
      if (this.cursorHandle === null && this.consumedBytes === 0 && !this.atEof) {
        return readBlob(this.scope.wire, this.scope.txHandle, this.id, this.scope.chunkSize);
      }
      // Resume: continue from the head() cursor — no re-transfer, no re-open.
      while (!this.atEof) {
        const w = await readBlobWindow(this.scope.wire, this.cursorHandle!, this.scope.chunkSize, 32);
        for (const c of w.chunks) {
          this.consumed.push(c);
          this.consumedBytes += c.length;
        }
        if (w.eof) this.finishCursor();
      }
      return Buffer.concat(this.consumed, this.consumedBytes);
    });
    this.cached = data;
    this.consumed = [];
    return data;
  }

  /**
   * Materialize as a decoded string. Subtype-1 (text) blobs use the column's
   * charset codec; binary blobs use `encoding` (default utf8).
   */
  async text(encoding?: BufferEncoding): Promise<string> {
    const buf = await this.buffer();
    if (this.subType === 1 && this.textCodec && !encoding) {
      const decoded = this.textCodec.decode(buf);
      return typeof decoded === 'string' ? decoded : decoded.toString('utf8');
    }
    return buf.toString(encoding ?? 'utf8');
  }

  /** Total byte length via op_info_blob (one round trip; opens + closes the blob). */
  async size(): Promise<number> {
    if (this.cached) return this.cached.length;
    this.assertAlive();
    return this.scope.lock(async () => {
      const handle = await openBlob(this.scope.wire, this.scope.txHandle, this.id);
      try {
        return await blobTotalLength(this.scope.wire, handle);
      } finally {
        closeBlobDeferred(this.scope.wire, handle);
      }
    });
  }

  /**
   * Stream the blob in backpressured chunks (one op_get_segment per pull).
   * One-shot: consume once. Prefer this for large blobs to avoid buffering.
   * Abandoning the stream early (`destroy()`, `break` out of for-await, or an
   * error) closes the server-side blob handle — nothing leaks until tx end.
   */
  stream(opts: { chunkSize?: number } = {}): Readable {
    this.assertAlive();
    this.promoteIfComplete();
    // Cached or prefetched bytes stream straight from memory.
    if (this.cached || this.scope.prefetch?.has(this.id.toString('hex'))) {
      const self = this;
      return Readable.from(
        (async function* () {
          yield await self.buffer();
        })(),
      );
    }
    const scope = this.scope;
    const id = this.id;
    const chunkSize = opts.chunkSize ?? scope.chunkSize;
    // Resume from a head() cursor: the stream takes over the open handle and
    // emits the already-consumed bytes first (the blob's cursor resets — a
    // stream is one-shot).
    let preamble: Buffer | null = this.consumedBytes > 0 ? Buffer.concat(this.consumed, this.consumedBytes) : null;
    let handle: number | null = this.cursorHandle;
    this.cursorHandle = null;
    this.consumed = [];
    this.consumedBytes = 0;
    this.atEof = false;
    let finished = false;
    let pulling = false;

    // Pull segments until the Readable's buffer is satisfied (push returns
    // false) or the blob is exhausted. Empty-but-not-eof segments loop here
    // rather than via this.read(), avoiding paused-mode re-entrancy.
    const pull = (readable: Readable): void => {
      if (pulling || finished) return;
      pulling = true;
      void scope
        .lock(async () => {
          if (finished) return null; // destroyed while queued for the op-lock
          if (!scope.isAlive()) throw new FirebirdBlobError('blob stream used after its transaction closed');
          if (handle === null) handle = await openBlob(scope.wire, scope.txHandle, id);
          return getBlobSegment(scope.wire, handle, chunkSize);
        })
        .then((seg) => {
          pulling = false;
          if (!seg || finished) return; // destroy() owns the handle close now
          if (seg.eof) {
            finished = true;
            if (seg.data.length > 0) readable.push(seg.data);
            if (handle !== null) void scope.lock(async () => closeBlobDeferred(scope.wire, handle!));
            readable.push(null);
            return;
          }
          // Keep pulling while the consumer still wants more (push → true).
          if (seg.data.length === 0 || readable.push(seg.data)) pull(readable);
        })
        .catch((err) => {
          pulling = false;
          readable.destroy(err as Error);
        });
    };

    return new Readable({
      read(): void {
        if (preamble) {
          const p = preamble;
          preamble = null;
          if (!this.push(p)) return; // consumer backpressure — pull on next read()
        }
        pull(this);
      },
      // Early destroy (explicit, error, or breaking out of for-await): close
      // the server-side handle instead of leaking it until the tx ends. The
      // close rides the op-lock, so it serializes after any in-flight pull.
      destroy(err, cb): void {
        const abandoned = !finished;
        finished = true;
        if (abandoned) {
          void scope
            .lock(async () => {
              if (handle !== null && scope.isAlive()) closeBlobDeferred(scope.wire, handle);
            })
            .catch(() => void 0);
        }
        cb(err);
      },
    });
  }
}
