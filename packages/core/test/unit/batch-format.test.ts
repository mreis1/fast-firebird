import { describe, expect, it } from 'vitest';
import {
  buildBatchFormat,
  buildBatchPb,
  decimalToScaled,
  encodeBatchRow,
} from '../../src/protocol/batch.js';
import { SqlType } from '../../src/protocol/constants.js';
import type { SqlVarDesc } from '../../src/protocol/info.js';

const utf8 = (i: number, s: string): Buffer => Buffer.from(s, 'utf8');

function desc(partial: Partial<SqlVarDesc> & { type: number }): SqlVarDesc {
  return { nullable: true, subType: 0, scale: 0, length: 0, ...partial };
}

describe('decimalToScaled', () => {
  it('shifts integers by the scale', () => {
    expect(decimalToScaled('12', 2, 'p')).toBe(1200n);
    expect(decimalToScaled('-3', 4, 'p')).toBe(-30000n);
    expect(decimalToScaled('0', 2, 'p')).toBe(0n);
  });

  it('is exact for decimal fractions (no float noise)', () => {
    expect(decimalToScaled('12.5', 2, 'p')).toBe(1250n);
    expect(decimalToScaled('0.1', 2, 'p')).toBe(10n);
    expect(decimalToScaled('-99999999.99', 2, 'p')).toBe(-9999999999n);
  });

  it('pads missing fraction digits with zeros', () => {
    expect(decimalToScaled('7.3', 4, 'p')).toBe(73000n);
    expect(decimalToScaled('.5', 1, 'p')).toBe(5n);
  });

  it('rounds excess fraction digits half away from zero', () => {
    expect(decimalToScaled('1.005', 2, 'p')).toBe(101n);
    expect(decimalToScaled('1.004', 2, 'p')).toBe(100n);
    expect(decimalToScaled('-1.005', 2, 'p')).toBe(-101n);
    expect(decimalToScaled('0.005', 2, 'p')).toBe(1n);
    expect(decimalToScaled('0.004', 2, 'p')).toBe(0n);
  });

  it('handles exponent notation (JS Number stringification)', () => {
    expect(decimalToScaled('1e2', 0, 'p')).toBe(100n);
    expect(decimalToScaled('1.5e1', 0, 'p')).toBe(15n);
    expect(decimalToScaled('5e-1', 0, 'p')).toBe(1n); // 0.5 rounds up
    expect(decimalToScaled('4e-3', 0, 'p')).toBe(0n); // 0.004 rounds down
    expect(decimalToScaled('1e+21', 0, 'p')).toBe(1000000000000000000000n);
  });

  it('rejects non-decimal text', () => {
    expect(() => decimalToScaled('abc', 2, 'p')).toThrow(/cannot convert/);
    expect(() => decimalToScaled('', 2, 'p')).toThrow(/cannot convert/);
    expect(() => decimalToScaled('.', 2, 'p')).toThrow(/cannot convert/);
  });
});

describe('buildBatchFormat msglen (engine layout rules)', () => {
  it('varchar: len+2, align 2, plus null short', () => {
    // varying(10) = 12 bytes at offset 0, then null short aligned 2 → 14.
    const f = buildBatchFormat([desc({ type: SqlType.VARYING, length: 10 })]);
    expect(f.msglen).toBe(14);
    expect(f.alignedStride).toBe(16);
  });

  it('integer + null short', () => {
    // long: 4 → null short at 4..6 = 6
    expect(buildBatchFormat([desc({ type: SqlType.LONG })]).msglen).toBe(6);
    // short is emitted as long, same layout
    expect(buildBatchFormat([desc({ type: SqlType.SHORT })]).msglen).toBe(6);
  });

  it('int64 aligns to 8 after a preceding int', () => {
    // long 0..4, null 4..6, int64 aligns 6→8..16, null 16..18 = 18
    const f = buildBatchFormat([desc({ type: SqlType.LONG }), desc({ type: SqlType.INT64 })]);
    expect(f.msglen).toBe(18);
    expect(f.alignedStride).toBe(24);
  });

  it('mixed row mirrors PARSE_msg_format offsets', () => {
    // varying(5): 0..7, null 8..10 (7 aligned to 2 → 8)
    // timestamp: aligns 10→12..20, null 20..22
    // bool: 22..23, null aligned 24..26
    // double: aligns 26→32..40, null 40..42
    const f = buildBatchFormat([
      desc({ type: SqlType.VARYING, length: 5 }),
      desc({ type: SqlType.TIMESTAMP }),
      desc({ type: SqlType.BOOLEAN }),
      desc({ type: SqlType.DOUBLE }),
    ]);
    expect(f.msglen).toBe(42);
  });

  it('tz/blob/decfloat internal lengths', () => {
    // TZ types use the PADDED struct sizes (sizeof, not sum of members).
    expect(buildBatchFormat([desc({ type: SqlType.TIMESTAMP_TZ })]).msglen).toBe(14); // 12 + null
    expect(buildBatchFormat([desc({ type: SqlType.TIME_TZ })]).msglen).toBe(10); // 8 + null
    expect(buildBatchFormat([desc({ type: SqlType.BLOB })]).msglen).toBe(10); // 8 + null
    expect(buildBatchFormat([desc({ type: SqlType.DEC34 })]).msglen).toBe(18); // 16 + null
    expect(buildBatchFormat([desc({ type: SqlType.INT128 })]).msglen).toBe(18);
  });

  it('collects blob parameter indices', () => {
    const f = buildBatchFormat([desc({ type: SqlType.LONG }), desc({ type: SqlType.BLOB }), desc({ type: SqlType.BLOB, subType: 1 })]);
    expect(f.blobIndices).toEqual([1, 2]);
  });
});

describe('buildBatchFormat BLR', () => {
  it('emits blr message header, per-field type + null short, footer', () => {
    const f = buildBatchFormat([desc({ type: SqlType.VARYING, length: 300 }), desc({ type: SqlType.LONG, scale: -2 })]);
    expect([...f.blr]).toEqual([
      5, // blr_version5
      2, // blr_begin
      4, // blr_message
      0, // message 0
      4, 0, // 2 fields × 2 (value + null indicator)
      37, 44, 1, // blr_varying 300 (LE word)
      7, 0, // null short
      8, 0xfe, // blr_long scale -2 (byte)
      7, 0, // null short
      255, 76, // blr_end, blr_eoc
    ]);
  });
});

describe('encodeBatchRow', () => {
  const intText = buildBatchFormat([desc({ type: SqlType.LONG }), desc({ type: SqlType.VARYING, length: 20 })]);

  it('writes the null bitmap padded to 4 then values', () => {
    const row = encodeBatchRow(intText, [7, 'ab'], utf8);
    expect([...row]).toEqual([
      0, 0, 0, 0, // bitmap (1 byte) + pad
      0, 0, 0, 7, // int32
      0, 0, 0, 2, 0x61, 0x62, 0, 0, // varying: count + bytes + pad
    ]);
  });

  it('skips NULL values and sets bitmap bits', () => {
    const row = encodeBatchRow(intText, [null, undefined], utf8);
    expect([...row]).toEqual([0b11, 0, 0, 0]);
  });

  it('scales numeric values exactly', () => {
    const f = buildBatchFormat([desc({ type: SqlType.LONG, scale: -2 })]);
    expect([...encodeBatchRow(f, ['12.5', null], utf8).subarray(4)]).toEqual([0, 0, 4, 226]); // 1250
    expect([...encodeBatchRow(f, [12.5], utf8).subarray(4)]).toEqual([0, 0, 4, 226]);
  });

  it('rejects text longer than the column', () => {
    expect(() => encodeBatchRow(intText, [1, 'x'.repeat(21)], utf8)).toThrow(/column allows 20/);
  });

  it('rejects out-of-range integers', () => {
    expect(() => encodeBatchRow(intText, [2147483648, 'x'], utf8)).toThrow(/out of range/);
  });

  it('encodes booleans as a padded byte', () => {
    const f = buildBatchFormat([desc({ type: SqlType.BOOLEAN })]);
    expect([...encodeBatchRow(f, [true], utf8)]).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
  });
});

describe('buildBatchPb', () => {
  it('starts with the version tag and appends LE int clumplets', () => {
    const pb = buildBatchPb({ multiError: true, recordCounts: true, blobPolicy: 2, detailedErrors: 10 });
    expect([...pb]).toEqual([
      1, // IBatch::VERSION1
      1, 4, 0, 0, 0, 1, 0, 0, 0, // TAG_MULTIERROR = 1
      2, 4, 0, 0, 0, 1, 0, 0, 0, // TAG_RECORD_COUNTS = 1
      4, 4, 0, 0, 0, 2, 0, 0, 0, // TAG_BLOB_POLICY = BLOB_ID_USER
      5, 4, 0, 0, 0, 10, 0, 0, 0, // TAG_DETAILED_ERRORS = 10
    ]);
  });

  it('omits unset tags', () => {
    expect([...buildBatchPb({ multiError: false, recordCounts: true })]).toEqual([1, 2, 4, 0, 0, 0, 1, 0, 0, 0]);
  });
});
