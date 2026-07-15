/**
 * Builder for Firebird "tagged parameter buffers": DPB (database), TPB
 * (transaction), BPB (blob), SPB (service). All share the same shape —
 * a version byte followed by `tag [len data]` clusters with little-endian
 * numeric arguments and 1-byte length prefixes.
 */
export class ParamBuffer {
  private parts: number[] = [];

  constructor(version?: number) {
    if (version !== undefined) this.parts.push(version);
  }

  /** Bare tag with no argument (common in TPBs). */
  tag(tag: number): this {
    this.parts.push(tag);
    return this;
  }

  /** tag + len + raw bytes. */
  bytes(tag: number, data: Buffer | Uint8Array): this {
    if (data.length > 255) throw new Error(`Parameter buffer item too long: ${data.length}`);
    this.parts.push(tag, data.length);
    for (const b of data) this.parts.push(b);
    return this;
  }

  string(tag: number, value: string, encode: (s: string) => Buffer = (s) => Buffer.from(s, 'utf8')): this {
    return this.bytes(tag, encode(value));
  }

  /** tag + 2-byte little-endian length + bytes (SpbStart "StringSpb" clumplets). */
  string2(tag: number, value: string, encode: (s: string) => Buffer = (s) => Buffer.from(s, 'utf8')): this {
    const data = encode(value);
    if (data.length > 0xffff) throw new Error(`Parameter buffer item too long: ${data.length}`);
    this.parts.push(tag, data.length & 0xff, (data.length >> 8) & 0xff);
    for (const b of data) this.parts.push(b);
    return this;
  }

  /** tag + len=1 + unsigned byte. */
  byte(tag: number, value: number): this {
    this.parts.push(tag, 1, value & 0xff);
    return this;
  }

  /** tag + len=4 + little-endian int32. */
  int32(tag: number, value: number): this {
    this.parts.push(tag, 4, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
    return this;
  }

  /** tag + raw little-endian int32, NO length byte (SpbStart "IntSpb"). */
  rawInt32(tag: number, value: number): this {
    this.parts.push(tag, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
    return this;
  }

  get length(): number {
    return this.parts.length;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.parts);
  }
}
