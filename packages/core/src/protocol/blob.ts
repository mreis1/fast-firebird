import { BLOB_SEGSTR_EOF_HANDLE, MAX_SEGMENT_SIZE, Op } from './constants.js';
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
