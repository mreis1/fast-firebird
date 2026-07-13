import { closeBlobDeferred, openBlob, readBlobWindow } from '../protocol/blob.js';
import type { WireConnection } from '../protocol/wire.js';
import type { ResolvedReadAhead } from './options.js';
import type { OpLock } from './session.js';

/**
 * Lazy-blob read-ahead for `queryStream` (Part B of cross-blob pipelining).
 *
 * While the consumer processes row N (e.g. an fs write), this prefetches the
 * blob contents of rows up to N + depth in background op-lock slices, so the
 * consumer's `.buffer()/.text()/.stream()` resolve without wire round trips.
 *
 * Contract with `Blob`: `take(idHex)` hands over the (possibly future)
 * bytes exactly once and frees the budget; `null` means "not tracked — use
 * the on-demand path". Everything here is best-effort: errors are stored and
 * only surface if the consumer actually asks for that blob; `close()` simply
 * stops tracking (handles stay valid via the normal on-demand path).
 *
 * Memory: `maxBytes` bounds prefetched-but-unconsumed bytes. Blob sizes are
 * unknown upfront, so one in-flight blob may overshoot the budget; the next
 * blob only starts when consumption brings usage back under the cap.
 * Skipped rows' buffers count against the budget until stream close.
 */
export class BlobPrefetcher {
  private readonly entries = new Map<string, PrefetchEntry>();
  private readonly queue: PrefetchEntry[] = [];
  private usedBytes = 0;
  private watermark = -1; // prefetch blobs of rows ≤ watermark
  private running = false;
  private closed = false;

  constructor(
    private readonly lock: OpLock,
    private readonly wire: WireConnection,
    private readonly txHandle: number,
    private readonly chunkSize: number,
    private readonly cfg: ResolvedReadAhead,
  ) {}

  /** Register a fetched row's lazy blob ids (in row order). */
  addRow(rowIdx: number, ids: Buffer[]): void {
    if (this.closed) return;
    for (const id of ids) {
      const idHex = id.toString('hex');
      if (this.entries.has(idHex)) continue; // duplicate id — first row wins
      const e: PrefetchEntry = { idHex, id, rowIdx, state: 'queued', chunks: [], bytes: 0, claimed: false };
      this.entries.set(idHex, e);
      this.queue.push(e);
    }
  }

  /** The consumer is now at `rowIdx` — move the prefetch window. */
  advance(rowIdx: number): void {
    this.watermark = rowIdx + this.cfg.depth;
    this.kick();
  }

  /** True when `take()` would return a promise (used for stream shortcuts). */
  has(idHex: string): boolean {
    const e = this.entries.get(idHex);
    return e !== undefined && e.state !== 'aborted';
  }

  /**
   * Claim a blob's bytes (single-shot). Returns null when untracked or
   * already handed over — the caller then reads on demand.
   */
  take(idHex: string): Promise<Buffer> | null {
    const e = this.entries.get(idHex);
    if (!e || e.state === 'aborted') return null;
    e.claimed = true;
    if (e.state === 'done') {
      const buf = Buffer.concat(e.chunks);
      this.release(e);
      return Promise.resolve(buf);
    }
    if (e.state === 'error') {
      this.entries.delete(e.idHex);
      return Promise.reject(e.error);
    }
    if (!e.promise) {
      e.promise = new Promise<Buffer>((resolve, reject) => {
        e.resolve = resolve;
        e.reject = reject;
      });
    }
    this.kick(); // claimed entries bypass watermark/budget checks
    return e.promise;
  }

  /**
   * Stop tracking and abort unclaimed work. Claimed in-flight fetches run to
   * completion (their consumer is awaiting); unclaimed buffers are dropped.
   */
  close(): void {
    this.closed = true;
    for (const e of [...this.entries.values()]) {
      if (e.state === 'queued' || (e.state === 'done' && !e.claimed)) {
        e.state = 'aborted';
        e.chunks = [];
        this.entries.delete(e.idHex);
      }
    }
  }

  private release(e: PrefetchEntry): void {
    this.usedBytes -= e.bytes;
    e.chunks = [];
    this.entries.delete(e.idHex);
    this.kick(); // freed budget may unblock the queue
  }

  private eligible(e: PrefetchEntry): boolean {
    if (e.state !== 'queued') return false;
    if (e.claimed) return true; // consumer is waiting right now
    if (this.closed) return false;
    if (e.rowIdx > this.watermark) return false; // beyond the depth window
    return this.usedBytes < this.cfg.maxBytes;
  }

  private kick(): void {
    if (this.running) return;
    const next = this.queue.find((e) => this.eligible(e));
    if (!next) return;
    this.running = true;
    void this.fetch(next)
      .catch(() => undefined)
      .finally(() => {
        this.running = false;
        this.kick();
      });
  }

  /** Fetch one blob in bounded op-lock slices (other ops interleave between slices). */
  private async fetch(e: PrefetchEntry): Promise<void> {
    e.state = 'fetching';
    let handle: number | null = null;
    try {
      let eof = false;
      while (!eof) {
        if (this.closed && !e.claimed) {
          // Abandoned mid-fetch: free the handle and forget the bytes.
          await this.lock(async () => {
            if (handle !== null) closeBlobDeferred(this.wire, handle);
          });
          this.usedBytes -= e.bytes;
          e.chunks = [];
          e.state = 'aborted';
          this.entries.delete(e.idHex);
          return;
        }
        // One slice: open on first pass, then one pipelined 8-segment window
        // (~512 KB, 1 RTT). Bounded, so consumer ops interleave between slices.
        await this.lock(async () => {
          const h = handle ?? (await openBlob(this.wire, this.txHandle, e.id));
          handle = h;
          const w = await readBlobWindow(this.wire, h, this.chunkSize, 8);
          for (const c of w.chunks) {
            e.chunks.push(c);
            e.bytes += c.length;
            this.usedBytes += c.length;
          }
          if (w.eof) {
            eof = true;
            closeBlobDeferred(this.wire, h);
            handle = null;
          }
        });
      }
      e.state = 'done';
      if (e.claimed && e.resolve) {
        const buf = Buffer.concat(e.chunks);
        this.release(e);
        e.resolve(buf);
      }
    } catch (err) {
      // The throwing op consumed its own response — the wire stays in sync.
      // Free the handle (deferred) and surface the error only on take().
      await this.lock(async () => {
        if (handle !== null) closeBlobDeferred(this.wire, handle);
      }).catch(() => undefined);
      this.usedBytes -= e.bytes;
      e.chunks = [];
      e.state = 'error';
      e.error = err as Error;
      if (e.claimed && e.reject) {
        this.entries.delete(e.idHex);
        e.reject(err as Error);
      }
    }
  }
}

interface PrefetchEntry {
  idHex: string;
  id: Buffer;
  rowIdx: number;
  state: 'queued' | 'fetching' | 'done' | 'error' | 'aborted';
  chunks: Buffer[];
  bytes: number;
  claimed: boolean;
  error?: Error;
  promise?: Promise<Buffer>;
  resolve?: (b: Buffer) => void;
  reject?: (e: Error) => void;
}
