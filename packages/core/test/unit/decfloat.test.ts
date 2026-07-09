import { describe, expect, it } from 'vitest';
import { decodeDecFloat } from '../../src/types/decfloat.js';

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
});
