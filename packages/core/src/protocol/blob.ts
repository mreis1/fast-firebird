import { BLOB_SEGSTR_EOF_HANDLE, MAX_SEGMENT_SIZE, Op } from './constants.js';
import { FirebirdError } from '../api/errors.js';
import type { WireConnection } from './wire.js';

/**
 * Blob wire operations. Segments inside op_get_segment/op_batch_segments
 * buffers are framed as `UInt16LE length + bytes`.
 */

const ISC_INFO_BLOB_TOTAL_LENGTH = 6;

/** op_open_blob → blob handle. One round trip. */
export async function openBlob(wire: WireConnection, txHandle: number, blobId: Buffer): Promise<number> {
  wire.writer.int32(Op.open_blob).int32(txHandle).raw(blobId);
  wire.flush();
  return (await wire.readResponse()).handle;
}

/** One op_get_segment. Returns the segment bytes and whether the blob is exhausted. */
export async function getBlobSegment(
  wire: WireConnection,
  blobHandle: number,
  chunkSize: number,
): Promise<{ data: Buffer; eof: boolean }> {
  // The wire buffer must hold the 2-byte segment length prefix PLUS data, so
  // request chunkSize + framing — otherwise a tiny chunkSize yields 0 data and
  // the read never progresses.
  const bufferLength = Math.min(Math.max(chunkSize, 1) + 2, MAX_SEGMENT_SIZE);
  wire.writer.int32(Op.get_segment).int32(blobHandle).int32(bufferLength).int32(0);
  wire.flush();
  const resp = await wire.readResponse();
  const raw = resp.data;
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos + 2 <= raw.length) {
    const len = raw.readUInt16LE(pos);
    pos += 2;
    parts.push(Buffer.from(raw.subarray(pos, pos + len)));
    pos += len;
  }
  return { data: parts.length === 1 ? parts[0]! : Buffer.concat(parts), eof: resp.handle === BLOB_SEGSTR_EOF_HANDLE };
}

/** op_close_blob, deferred (rides with the next packet). */
export function closeBlobDeferred(wire: WireConnection, blobHandle: number): void {
  wire.writer.int32(Op.close_blob).int32(blobHandle);
  wire.markDeferred();
}

/** Total blob length in bytes via op_info_blob. One round trip (blob must be open). */
export async function blobTotalLength(wire: WireConnection, blobHandle: number): Promise<number> {
  wire.writer
    .int32(Op.info_blob)
    .int32(blobHandle)
    .int32(0)
    .opaque(Buffer.from([ISC_INFO_BLOB_TOTAL_LENGTH]))
    .int32(32);
  wire.flush();
  const info = (await wire.readResponse()).data;
  // Clumplet: item(1) + UInt16LE len + LE integer.
  if (info.length < 3 || info[0] !== ISC_INFO_BLOB_TOTAL_LENGTH) return 0;
  const len = info.readUInt16LE(1);
  let value = 0;
  for (let k = 0; k < len; k++) value += info[3 + k]! * 2 ** (8 * k);
  return value;
}

/**
 * How many blob segment ops ride the wire before we start awaiting their
 * responses. Serial segment I/O is round-trip-bound on remote links (a 1.8 MB
 * blob = ~28 × RTT); a 32-deep window (~2 MiB in flight) covers such a blob
 * in one burst. Measured at 30 ms RTT: 5×1.8 MB blobs went 6.0 s → 0.9 s
 * insert and 5.5 s → 0.9 s fetch. Over-reading past EOF is safe: the server
 * answers each extra op_get_segment with a clean empty EOF response
 * (verified on FB 3/4/5).
 */
const PIPELINE_DEPTH = 32;

/** Parse one op_get_segment response body (segments framed UInt16LE len + bytes). */
async function readSegmentResponse(wire: WireConnection): Promise<{ data: Buffer; eof: boolean }> {
  const resp = await wire.readResponse();
  const raw = resp.data;
  const parts: Buffer[] = [];
  let pos = 0;
  while (pos + 2 <= raw.length) {
    const len = raw.readUInt16LE(pos);
    pos += 2;
    parts.push(Buffer.from(raw.subarray(pos, pos + len)));
    pos += len;
  }
  return {
    data: parts.length === 1 ? parts[0]! : Buffer.concat(parts),
    eof: resp.handle === BLOB_SEGSTR_EOF_HANDLE,
  };
}

/**
 * Read a whole blob by id, with pipelined segment requests: keep
 * PIPELINE_DEPTH op_get_segments in flight instead of one round trip per
 * segment. Round trips ≈ 1 open + N/depth + 1 close (deferred).
 */
export async function readBlob(
  wire: WireConnection,
  txHandle: number,
  blobId: Buffer,
  chunkSize: number,
): Promise<Buffer> {
  const blobHandle = await openBlob(wire, txHandle, blobId);
  const bufferLength = Math.min(Math.max(chunkSize, 1) + 2, MAX_SEGMENT_SIZE);
  const parts: Buffer[] = [];
  let inFlight = 0;
  let eof = false;
  const request = () => {
    wire.writer.int32(Op.get_segment).int32(blobHandle).int32(bufferLength).int32(0);
    inFlight++;
  };
  for (let i = 0; i < PIPELINE_DEPTH; i++) request();
  wire.flush();
  try {
    while (inFlight > 0) {
      inFlight--; // the await below consumes this response even when it throws
      const seg = await readSegmentResponse(wire);
      if (eof) continue; // draining post-EOF over-reads (clean empty responses)
      if (seg.data.length > 0) parts.push(seg.data);
      if (seg.eof) {
        eof = true;
      } else {
        request(); // top the window back up
        wire.flush();
      }
    }
  } catch (err) {
    // Keep the connection usable: consume the responses still in flight.
    while (inFlight > 0) {
      inFlight--;
      await wire.readResponse().catch(() => undefined);
    }
    closeBlobDeferred(wire, blobHandle);
    throw err;
  }
  closeBlobDeferred(wire, blobHandle);
  return Buffer.concat(parts);
}

/**
 * One pipelined window on an OPEN blob: `count` op_get_segments in a single
 * flush, then all `count` responses (1 RTT per window instead of per
 * segment). Over-reading past EOF is safe (clean empty EOF responses).
 * Used by the read-ahead prefetcher, whose lock slices must stay bounded.
 */
export async function readBlobWindow(
  wire: WireConnection,
  blobHandle: number,
  chunkSize: number,
  count: number,
): Promise<{ chunks: Buffer[]; eof: boolean }> {
  const bufferLength = Math.min(Math.max(chunkSize, 1) + 2, MAX_SEGMENT_SIZE);
  for (let k = 0; k < count; k++) {
    wire.writer.int32(Op.get_segment).int32(blobHandle).int32(bufferLength).int32(0);
  }
  wire.flush();
  const chunks: Buffer[] = [];
  let eof = false;
  let remaining = count;
  try {
    while (remaining > 0) {
      remaining--; // the await consumes this response even when it throws
      const seg = await readSegmentResponse(wire);
      if (eof) continue; // post-EOF over-reads
      if (seg.data.length > 0) chunks.push(seg.data);
      if (seg.eof) eof = true;
    }
  } catch (err) {
    while (remaining > 0) {
      remaining--;
      await wire.readResponse().catch(() => undefined);
    }
    throw err;
  }
  return { chunks, eof };
}

/**
 * Blob opens kept in flight ahead of the earliest unfinished blob — enough
 * that small blobs (whose windows start at RAMP_START) can fill the whole
 * segment window across many blobs at once.
 */
const OPEN_AHEAD = 10;

/**
 * Cross-blob pipelining: read MANY blobs with their open/read/close phases
 * overlapped on one connection. Serially, every blob pays ~2–3 RTTs of dead
 * air around its transfer (open, first-window latency, tail); here the next
 * blob's op_open_blob and first segment window ride BEHIND the current
 * blob's in-flight segment requests, and closes stay deferred — the wire
 * never idles between blobs. Responses are strictly FIFO per request order,
 * so a single pending-descriptor queue keeps the accounting exact.
 *
 * Total in-flight stays ≤ PIPELINE_DEPTH segment requests (same ~2 MiB
 * ceiling as single-blob reads) plus OPEN_AHEAD opens.
 */
export async function readBlobs(
  wire: WireConnection,
  txHandle: number,
  blobIds: Buffer[],
  chunkSize: number,
): Promise<Buffer[]> {
  if (blobIds.length === 0) return [];
  if (blobIds.length === 1) return [await readBlob(wire, txHandle, blobIds[0]!, chunkSize)];

  const bufferLength = Math.min(Math.max(chunkSize, 1) + 2, MAX_SEGMENT_SIZE);
  interface BlobState {
    handle: number | null;
    parts: Buffer[];
    eof: boolean;
    inFlight: number; // outstanding op_get_segment requests
    /**
     * Per-blob window cap, ramped RAMP_START → PIPELINE_DEPTH only when a
     * full window comes back as data with no EOF (the blob proved big). A
     * fixed deep window would waste ~depth post-EOF over-reads on SMALL
     * blobs; the ramp caps that at ~RAMP_START while big blobs still reach
     * full depth within a few windows.
     */
    cap: number;
    /** Data segments received (drives the cap ramp). */
    dataSegs: number;
  }
  const RAMP_START = 4;
  const blobs: BlobState[] = blobIds.map(() => ({ handle: null, parts: [], eof: false, inFlight: 0, cap: RAMP_START, dataSegs: 0 }));
  // NOTE: closes are tracked as pending descriptors, NOT closeBlobDeferred —
  // the deferred mechanism discards the FIRST response that arrives, which is
  // only correct when nothing else is outstanding. Here seg/open responses
  // are in flight, so every close consumes its own in-order response.
  type Pending = { kind: 'open'; idx: number } | { kind: 'seg'; idx: number } | { kind: 'close' };
  /** Requests flushed to the server, awaiting responses (strict FIFO). */
  const pending: Pending[] = [];
  /** Requests written to the buffer but NOT yet flushed — never awaitable. */
  let unflushed: Pending[] = [];
  let nextToOpen = 0;
  let head = 0; // first blob not yet at EOF — the "current" one

  const flushNow = (): void => {
    if (unflushed.length === 0) return;
    wire.flush();
    pending.push(...unflushed);
    unflushed = [];
  };

  let totalInFlight = 0;

  /** Write the next round of requests (opens ahead + a GLOBAL segment window). */
  const pump = (): void => {
    while (nextToOpen < blobIds.length && nextToOpen < head + OPEN_AHEAD) {
      wire.writer.int32(Op.open_blob).int32(txHandle).raw(blobIds[nextToOpen]!);
      unflushed.push({ kind: 'open', idx: nextToOpen });
      nextToOpen++;
    }
    // One shared PIPELINE_DEPTH window across as many blobs (in order) as it
    // takes to fill it — small blobs stream several per round trip, a big
    // blob's grown cap lets it hog the window when it needs to.
    for (let i = head; i < blobs.length && totalInFlight < PIPELINE_DEPTH; i++) {
      const b = blobs[i]!;
      if (b.eof || b.handle === null) continue;
      const cap = Math.min(b.cap, b.inFlight + (PIPELINE_DEPTH - totalInFlight));
      while (b.inFlight < cap) {
        wire.writer.int32(Op.get_segment).int32(b.handle).int32(bufferLength).int32(0);
        b.inFlight++;
        totalInFlight++;
        unflushed.push({ kind: 'seg', idx: i });
      }
    }
  };

  try {
    for (;;) {
      pump();
      // Batch writes: flush when a packet's worth accumulated, or when
      // nothing is outstanding (deadlock guard). While pending > 0, responses
      // keep arriving regardless, so holding up to 7 requests never stalls —
      // it just coalesces them into fewer packets.
      if (unflushed.length >= 8) flushNow();
      if (pending.length === 0) {
        if (unflushed.length === 0) break; // all done
        flushNow();
      }
      const p = pending.shift()!; // shifted BEFORE the await — a throwing read already consumed it
      if (p.kind === 'open') {
        blobs[p.idx]!.handle = (await wire.readResponse()).handle;
      } else if (p.kind === 'close') {
        await wire.readResponse().catch(() => undefined); // close errors dropped, like deferred closes
      } else {
        const b = blobs[p.idx]!;
        b.inFlight--;
        totalInFlight--;
        const seg = await readSegmentResponse(wire);
        if (!b.eof) {
          if (seg.data.length > 0) b.parts.push(seg.data);
          if (seg.eof) {
            b.eof = true;
            wire.writer.int32(Op.close_blob).int32(b.handle!);
            unflushed.push({ kind: 'close' });
            while (head < blobs.length && blobs[head]!.eof) head++;
          } else if (++b.dataSegs >= b.cap) {
            // A whole window of pure data — the blob is big; widen its share.
            b.cap = Math.min(b.cap * 2, PIPELINE_DEPTH);
          }
        }
        // post-EOF over-reads answer with clean empty EOFs — ignore
      }
    }
  } catch (err) {
    // Keep the connection in sync: `unflushed` request BYTES already sit in
    // the writer buffer and would ride the next flush regardless — send them
    // now so their responses can be drained along with everything pending.
    try {
      flushNow();
    } catch {
      unflushed = []; // transport dead — nothing further will be readable anyway
    }
    while (pending.length > 0) {
      pending.shift();
      await wire.readResponse().catch(() => undefined);
    }
    for (const b of blobs) {
      if (b.handle !== null && !b.eof) closeBlobDeferred(wire, b.handle);
    }
    throw err;
  }
  return blobs.map((b) => Buffer.concat(b.parts));
}

/**
 * Create a blob and stream `source` into it without ever materializing the
 * whole value: chunks are re-framed into wire-max segments (an accumulator
 * merges small chunks, big chunks are sliced) and uploaded with the same
 * PIPELINE_DEPTH op_batch_segments window as `writeBlob`. String chunks go
 * through `encodeText` (the column's charset codec). Returns the blob id.
 *
 * On any error — source or wire — in-flight responses are drained and the
 * abandoned blob handle is released, so the connection stays usable.
 */
export async function writeBlobStream(
  wire: WireConnection,
  txHandle: number,
  source: AsyncIterable<Buffer | string>,
  chunkSize: number,
  encodeText: (s: string) => Buffer,
): Promise<Buffer> {
  wire.writer.int32(Op.create_blob2).uint32(0).int32(txHandle).int32(0).int32(0);
  wire.flush();
  const created = await wire.readResponse();
  const blobHandle = created.handle;
  const blobId = created.oid;

  const segSize = Math.min(Math.max(chunkSize, 1), MAX_SEGMENT_SIZE - 2);
  let inFlight = 0; // unconsumed responses on the wire (segments + close)
  let closeSent = false;

  const sendSegment = async (chunk: Buffer): Promise<void> => {
    const framed = Buffer.allocUnsafe(chunk.length + 2);
    framed.writeUInt16LE(chunk.length, 0);
    chunk.copy(framed, 2);
    wire.writer.int32(Op.batch_segments).int32(blobHandle).int32(framed.length).opaque(framed);
    inFlight++;
    if (inFlight >= PIPELINE_DEPTH) {
      wire.flush();
      inFlight--; // the await consumes this response even when it throws
      await wire.readResponse(); // oldest in-flight segment
    }
  };

  try {
    // Accumulate arbitrary chunk sizes into full wire segments.
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    for await (const raw of source) {
      const buf = typeof raw === 'string' ? encodeText(raw) : raw;
      if (!Buffer.isBuffer(buf)) {
        throw new FirebirdError('Streaming blob source must yield Buffers or strings');
      }
      if (buf.length === 0) continue;
      pending.push(buf);
      pendingBytes += buf.length;
      while (pendingBytes >= segSize) {
        const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
        await sendSegment(all.subarray(0, segSize));
        const rest = all.subarray(segSize);
        pending = rest.length > 0 ? [rest] : [];
        pendingBytes = rest.length;
      }
    }
    if (pendingBytes > 0) {
      await sendSegment(pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes));
    }
    wire.writer.int32(Op.close_blob).int32(blobHandle);
    closeSent = true;
    inFlight++;
    wire.flush();
    while (inFlight > 0) {
      inFlight--;
      await wire.readResponse();
    }
  } catch (err) {
    // The SOURCE can throw between writes, leaving segments written but not
    // yet flushed — send them now so every counted in-flight op actually has
    // a response to drain (otherwise the drain below hangs forever).
    try {
      wire.flush();
    } catch {
      /* transport dead — drain reads will fail fast below */
    }
    while (inFlight > 0) {
      inFlight--;
      await wire.readResponse().catch(() => undefined);
    }
    if (!closeSent) closeBlobDeferred(wire, blobHandle);
    throw err;
  }
  return blobId;
}

/**
 * Create a blob and write `data` in pipelined segment batches (PIPELINE_DEPTH
 * op_batch_segments in flight — errors still surface in order). Returns the
 * 8-byte blob id. Round trips ≈ 1 create + N/depth + 1 close.
 */
export async function writeBlob(
  wire: WireConnection,
  txHandle: number,
  data: Buffer,
  chunkSize: number,
): Promise<Buffer> {
  wire.writer.int32(Op.create_blob2).uint32(0).int32(txHandle).int32(0).int32(0);
  wire.flush();
  const created = await wire.readResponse();
  const blobHandle = created.handle;
  const blobId = created.oid;

  const segSize = Math.min(Math.max(chunkSize, 1), MAX_SEGMENT_SIZE - 2);
  let inFlight = 0; // unconsumed responses on the wire (segments + close)
  let closeSent = false;
  try {
    for (let off = 0; off < data.length || off === 0; off += segSize) {
      const chunk = data.subarray(off, off + segSize);
      const framed = Buffer.allocUnsafe(chunk.length + 2);
      framed.writeUInt16LE(chunk.length, 0);
      chunk.copy(framed, 2);
      // P_SGMT = blob handle, p_sgmt_length, then the segment data as cstring.
      wire.writer.int32(Op.batch_segments).int32(blobHandle).int32(framed.length).opaque(framed);
      inFlight++;
      if (inFlight >= PIPELINE_DEPTH) {
        wire.flush();
        inFlight--; // the await consumes this response even when it throws
        await wire.readResponse(); // oldest in-flight segment
      }
      if (data.length === 0) break;
    }
    wire.writer.int32(Op.close_blob).int32(blobHandle);
    closeSent = true;
    inFlight++;
    wire.flush();
    while (inFlight > 0) {
      inFlight--;
      await wire.readResponse();
    }
  } catch (err) {
    // Keep the connection usable: every op we wrote was flushed by the time a
    // response could throw — drain the responses still in flight, and close
    // the abandoned blob handle (deferred; the rollback cleans the blob up).
    while (inFlight > 0) {
      inFlight--;
      await wire.readResponse().catch(() => undefined);
    }
    if (!closeSent) closeBlobDeferred(wire, blobHandle);
    throw err;
  }

  return blobId;
}
