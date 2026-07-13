import { parseSegmentFrames } from '../protocol/blob.js';

/**
 * Client-side store for FB 5.0.2+ inline blobs (protocol ≥ 19).
 *
 * The server volunteers blobs smaller than the negotiated inline size along
 * with the row data (`op_inline_blob` ahead of each fetch/sql response);
 * `wire.readOp()` dispatches them here. Blob reads consult `take()` FIRST —
 * a hit costs zero round trips.
 *
 * Semantics mirror fbclient's Rtr cache: entries are transaction-scoped
 * (blob ids only mean something inside their tx), `take()` is single-shot
 * (a re-read of the same id falls back to the wire — correct, just slower),
 * incoming blobs beyond `capacity` bytes are dropped (the wire already
 * carried them; we just don't hold them), and a tx's entries vanish when the
 * tx finishes.
 */
export class InlineBlobCache {
  private readonly byTx = new Map<number, Map<string, Buffer>>();
  private usedBytes = 0;

  constructor(private readonly capacity: number) {}

  /** Store an incoming inline blob (raw segment-framed payload). */
  store(txId: number, blobId: Buffer, data: Buffer): void {
    if (this.usedBytes + data.length > this.capacity) return; // over budget — drop
    const key = blobId.toString('hex');
    const tx = this.byTx.get(txId) ?? new Map<string, Buffer>();
    this.byTx.set(txId, tx);
    const prev = tx.get(key);
    if (prev !== undefined) this.usedBytes -= prev.length; // same id re-sent — replace
    tx.set(key, data);
    this.usedBytes += data.length;
  }

  /** Single-shot claim: unframed blob bytes, or null (→ normal wire read). */
  take(txId: number, idHex: string): Buffer | null {
    const tx = this.byTx.get(txId);
    const framed = tx?.get(idHex);
    if (framed === undefined) return null;
    tx!.delete(idHex);
    this.usedBytes -= framed.length;
    return parseSegmentFrames(framed);
  }

  /** Drop everything belonging to a finished transaction. */
  clearTx(txId: number): void {
    const tx = this.byTx.get(txId);
    if (!tx) return;
    for (const data of tx.values()) this.usedBytes -= data.length;
    this.byTx.delete(txId);
  }

  clear(): void {
    this.byTx.clear();
    this.usedBytes = 0;
  }

  /** @internal test hook */
  get size(): number {
    return this.usedBytes;
  }
}
