import { BLOB_SEGSTR_EOF_HANDLE, MAX_SEGMENT_SIZE, Op } from './constants.js';
import type { WireConnection } from './wire.js';

/**
 * Blob wire operations. Segments inside op_get_segment/op_batch_segments
 * buffers are framed as `UInt16LE length + bytes`.
 */

/** Read a whole blob by id. Round trips: 1 open + N segments + 1 close (deferred). */
export async function readBlob(
  wire: WireConnection,
  txHandle: number,
  blobId: Buffer,
  chunkSize: number,
): Promise<Buffer> {
  wire.writer.int32(Op.open_blob).int32(txHandle).raw(blobId);
  wire.flush();
  const open = await wire.readResponse();
  const blobHandle = open.handle;

  const parts: Buffer[] = [];
  const bufferLength = Math.min(Math.max(chunkSize, 1), MAX_SEGMENT_SIZE);
  for (;;) {
    wire.writer.int32(Op.get_segment).int32(blobHandle).int32(bufferLength).int32(0);
    wire.flush();
    const resp = await wire.readResponse();
    // The response buffer holds one or more UInt16LE-framed segments.
    const data = resp.data;
    let pos = 0;
    while (pos + 2 <= data.length) {
      const len = data.readUInt16LE(pos);
      pos += 2;
      parts.push(Buffer.from(data.subarray(pos, pos + len)));
      pos += len;
    }
    if (resp.handle === BLOB_SEGSTR_EOF_HANDLE) break;
  }

  wire.writer.int32(Op.close_blob).int32(blobHandle);
  wire.markDeferred(); // response rides with the next round trip

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
