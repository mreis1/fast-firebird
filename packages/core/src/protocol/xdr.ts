/**
 * XDR (RFC 4506 subset) encoding as used by the Firebird wire protocol.
 * All integers are big-endian; everything is aligned to 4-byte boundaries.
 */

const PAD = Buffer.alloc(4);

/** Growable big-endian writer used to build outgoing packets. */
export class XdrWriter {
  private buf: Buffer;
  private pos = 0;

  constructor(initialSize = 1024) {
    this.buf = Buffer.allocUnsafe(initialSize);
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.pos);
    this.buf = next;
  }

  get length(): number {
    return this.pos;
  }

  int32(v: number): this {
    this.ensure(4);
    this.buf.writeInt32BE(v | 0, this.pos);
    this.pos += 4;
    return this;
  }

  uint32(v: number): this {
    this.ensure(4);
    this.buf.writeUInt32BE(v >>> 0, this.pos);
    this.pos += 4;
    return this;
  }

  bigInt64(v: bigint): this {
    this.ensure(8);
    this.buf.writeBigInt64BE(v, this.pos);
    this.pos += 8;
    return this;
  }

  /** Raw bytes, NO length prefix, padded to a 4-byte boundary. */
  opaqueFixed(data: Buffer): this {
    const padded = (data.length + 3) & ~3;
    this.ensure(padded);
    data.copy(this.buf, this.pos);
    if (padded > data.length) {
      PAD.copy(this.buf, this.pos + data.length, 0, padded - data.length);
    }
    this.pos += padded;
    return this;
  }

  /** 4-byte length prefix + bytes + padding (XDR variable-length opaque / p_cnct string). */
  opaque(data: Buffer): this {
    this.uint32(data.length);
    return this.opaqueFixed(data);
  }

  string(s: string, encoding: BufferEncoding = 'utf8'): this {
    return this.opaque(Buffer.from(s, encoding));
  }

  raw(data: Buffer): this {
    this.ensure(data.length);
    data.copy(this.buf, this.pos);
    this.pos += data.length;
    return this;
  }

  finish(): Buffer {
    // Return a copy so the writer can be reused/pooled safely.
    const out = Buffer.allocUnsafe(this.pos);
    this.buf.copy(out, 0, 0, this.pos);
    this.pos = 0;
    return out;
  }
}

/** Synchronous big-endian reader over a fully buffered region. */
export class XdrReader {
  pos = 0;

  constructor(readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  int32(): number {
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  uint32(): number {
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  bigInt64(): bigint {
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    return v;
  }

  /** Raw bytes without length prefix; consumes padding to 4 bytes. */
  opaqueFixed(len: number): Buffer {
    const v = this.buf.subarray(this.pos, this.pos + len);
    this.pos += (len + 3) & ~3;
    return v;
  }

  /** 4-byte length prefix + bytes + padding. Returns a view, not a copy. */
  opaque(): Buffer {
    return this.opaqueFixed(this.uint32());
  }

  string(encoding: BufferEncoding = 'utf8'): string {
    return this.opaque().toString(encoding);
  }

  skip(n: number): void {
    this.pos += n;
  }
}

/** Number of bytes `opaque` occupies on the wire (prefix + payload + pad). */
export function opaqueSize(len: number): number {
  return 4 + ((len + 3) & ~3);
}
