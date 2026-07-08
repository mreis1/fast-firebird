import { describe, expect, it } from 'vitest';
import { XdrReader, XdrWriter, opaqueSize } from '../../src/protocol/xdr.js';

describe('XdrWriter / XdrReader', () => {
  it('round-trips integers big-endian', () => {
    const w = new XdrWriter(8); // force growth
    w.int32(-1).uint32(0xdeadbeef).bigInt64(-42n).int32(123456);
    const buf = w.finish();
    expect(buf.length).toBe(20);
    const r = new XdrReader(buf);
    expect(r.int32()).toBe(-1);
    expect(r.uint32()).toBe(0xdeadbeef);
    expect(r.bigInt64()).toBe(-42n);
    expect(r.int32()).toBe(123456);
    expect(r.remaining).toBe(0);
  });

  it('pads opaque data to 4-byte boundaries', () => {
    const w = new XdrWriter();
    w.opaque(Buffer.from([1, 2, 3, 4, 5]));
    const buf = w.finish();
    // 4 length + 5 data + 3 pad
    expect(buf.length).toBe(12);
    expect(buf.readUInt32BE(0)).toBe(5);
    expect([...buf.subarray(9)]).toEqual([0, 0, 0]);

    const r = new XdrReader(buf);
    expect([...r.opaque()]).toEqual([1, 2, 3, 4, 5]);
    expect(r.remaining).toBe(0);
  });

  it('handles exact multiples of 4 without padding', () => {
    const w = new XdrWriter();
    w.opaque(Buffer.from('abcd'));
    expect(w.length).toBe(8);
    const r = new XdrReader(w.finish());
    expect(r.opaque().toString()).toBe('abcd');
  });

  it('opaqueFixed consumes padding on read', () => {
    const w = new XdrWriter();
    w.opaqueFixed(Buffer.from([9, 9, 9]));
    const buf = w.finish();
    expect(buf.length).toBe(4);
    const r = new XdrReader(buf);
    expect([...r.opaqueFixed(3)]).toEqual([9, 9, 9]);
    expect(r.remaining).toBe(0);
  });

  it('strings round-trip', () => {
    const w = new XdrWriter();
    w.string('héllo €');
    const r = new XdrReader(w.finish());
    expect(r.string()).toBe('héllo €');
  });

  it('opaqueSize computes wire footprint', () => {
    expect(opaqueSize(0)).toBe(4);
    expect(opaqueSize(1)).toBe(8);
    expect(opaqueSize(4)).toBe(8);
    expect(opaqueSize(5)).toBe(12);
  });
});
