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

/** Read a whole blob by id. Round trips: 1 open + N segments + 1 close (deferred). */
export async function readBlob(
  wire: WireConnection,
  txHandle: number,
  blobId: Buffer,
  chunkSize: number,
): Promise<Buffer> {
  const blobHandle = await openBlob(wire, txHandle, blobId);
  const parts: Buffer[] = [];
  for (;;) {
    const seg = await getBlobSegment(wire, blobHandle, chunkSize);
    if (seg.data.length > 0) parts.push(seg.data);
    if (seg.eof) break;
  }
  closeBlobDeferred(wire, blobHandle);
  return Buffer.concat(parts);
}

/** Create a blob and write `data` in segment batches. Returns the 8-byte blob id. */
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
  for (let off = 0; off < data.length || off === 0; off += segSize) {
    const chunk = data.subarray(off, off + segSize);
    const framed = Buffer.allocUnsafe(chunk.length + 2);
    framed.writeUInt16LE(chunk.length, 0);
    chunk.copy(framed, 2);
    // P_SGMT = blob handle, p_sgmt_length, then the segment data as cstring.
    wire.writer.int32(Op.batch_segments).int32(blobHandle).int32(framed.length).opaque(framed);
    wire.flush();
    await wire.readResponse();
    if (data.length === 0) break;
  }

  wire.writer.int32(Op.close_blob).int32(blobHandle);
  wire.flush();
  await wire.readResponse();

  return blobId;
}
