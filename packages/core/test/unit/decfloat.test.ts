import { describe, expect, it } from 'vitest';
import { decodeDecFloat, encodeDecFloat } from '../../src/types/decfloat.js';

// Vectors captured from live Firebird 5 (`cast('<v>' as decfloat(34|16))`), so
// they pin the real DPD wire encoding, not a reimplementation of it.
describe('decodeDecFloat — IEEE 754-2008 decimal (DPD)', () => {
  const dec128: Array<[string, string]> = [
    ['22080000000000000000000000000000', '0'],
    ['22080000000000000000000000000001', '1'],
    ['22080000000000000000000000000002', '2'],
    ['22080000000000000000000000000010', '10'],
    ['220780000000000000000000000049c5', '123.45'],
    ['a2080000000000000000000000000001', '-1'],
    ['2207c000000000000000000000000001', '0.1'],
    ['2207c000000000000000000000000015', '1.5'],
    ['220a8000000000000000000000000001', '10000000000'],
    ['6e080ff3fcff3fcff3fcff3fcff3fcff', '9999999999999999999999999999999999'],
  ];
  const dec64: Array<[string, string]> = [
    ['2238000000000001', '1'],
    ['22300000000049c5', '123.45'],
    ['a238000000000001', '-1'],
    ['2234000000000001', '0.1'],
  ];

  it.each(dec128)('decimal128 %s → %s', (hex, expected) => {
    expect(decodeDecFloat(Buffer.from(hex, 'hex'))).toBe(expected);
  });

  it.each(dec64)('decimal64 %s → %s', (hex, expected) => {
    expect(decodeDecFloat(Buffer.from(hex, 'hex'))).toBe(expected);
  });

  // Encoding must reproduce Firebird's canonical bytes for the same literals.
  // (Decimal FP is unnormalized — a literal's coefficient/exponent split is
  // preserved, so '1E10' and '10000000000' are the same value but different
  // members of the cohort; vectors use the literal Firebird saw.)
  const enc128: Array<[string, string]> = [
    ['1', '22080000000000000000000000000001'],
    ['123.45', '220780000000000000000000000049c5'],
    ['-1', 'a2080000000000000000000000000001'],
    ['0.1', '2207c000000000000000000000000001'],
    ['1.5', '2207c000000000000000000000000015'],
    ['1E10', '220a8000000000000000000000000001'],
    ['9999999999999999999999999999999999', '6e080ff3fcff3fcff3fcff3fcff3fcff'],
  ];
  it.each(enc128)('encode decimal128 %s → %s', (value, hex) => {
    expect(encodeDecFloat(value, 16).toString('hex')).toBe(hex);
  });

  it.each([
    ['1', '2238000000000001'],
    ['123.45', '22300000000049c5'],
    ['0.1', '2234000000000001'],
  ] as Array<[string, string]>)('encode decimal64 %s → %s', (value, hex) => {
    expect(encodeDecFloat(value, 8).toString('hex')).toBe(hex);
  });

  it('round-trips values beyond double precision', () => {
    for (const v of ['0.1', '12345678901234567890123456789012.34', '-0.000001', '0.3333333333333333333333333333333333']) {
      expect(decodeDecFloat(encodeDecFloat(v, 16))).toBe(v);
    }
  });

  it('rounds an over-long coefficient half-up to fit', () => {
    // 35 digits into decimal128 (34-digit precision): last digit 5 rounds up.
    const rt = decodeDecFloat(encodeDecFloat('12345678901234567890123456789012345', 16));
    expect(rt).toBe('12345678901234567890123456789012350');
  });
});
