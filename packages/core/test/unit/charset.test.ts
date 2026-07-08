import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { CS_NONE, CS_OCTETS, resolveCharset } from '../../src/charset/charsets.js';
import { resolveTextCodec } from '../../src/charset/decoder.js';

// Includes win1252-only characters: €, smart quotes, em dash.
const WIN1252_SAMPLES = ['€', 'Olá “mundo”', 'd’água', 'em—dash', 'café ± 20°'];

describe('charset resolution', () => {
  it('resolves names and aliases', () => {
    expect(resolveCharset('UTF8').id).toBe(4);
    expect(resolveCharset('utf-8').id).toBe(4);
    expect(resolveCharset('WIN1252').id).toBe(53);
    expect(resolveCharset('latin1').name).toBe('ISO8859_1');
    expect(() => resolveCharset('KLINGON')).toThrow();
  });
});

describe('CHARSET NONE with charsetNoneEncoding=win1252 (legacy Delphi data)', () => {
  const codec = resolveTextCodec(
    { charsetId: CS_NONE, fieldName: 'MEMO', relationName: 'HISTORY' },
    { connectionCharset: 'NONE', charsetNoneEncoding: 'win1252' },
  );

  it('round-trips every win1252-only character', () => {
    for (const s of WIN1252_SAMPLES) {
      const bytes = codec.encode(s);
      expect(codec.decode(bytes as Buffer)).toBe(s);
    }
  });

  it('euro sign is the single byte 0x80 on disk', () => {
    expect([...codec.encode('€')]).toEqual([0x80]);
    expect(codec.decode(Buffer.from([0x80]))).toBe('€');
  });
});

describe('transcodeAdapter (node-firebird2 compatibility)', () => {
  it('adapter wins over everything else', () => {
    const codec = resolveTextCodec(
      { charsetId: 4 /* UTF8 declared */, fieldName: 'NAME' },
      {
        connectionCharset: 'UTF8',
        transcodeAdapter: {
          text: {
            fromDb: (buf) => iconv.decode(buf, 'win1252'),
            toDb: (v) => iconv.encode(v, 'win1252'),
          },
        },
      },
    );
    expect(codec.decode(Buffer.from([0x80]))).toBe('€');
    expect([...codec.encode('€')]).toEqual([0x80]);
  });
});

describe('charsetOverrides (field-level)', () => {
  const opts = {
    connectionCharset: 'NONE',
    charsetOverrides: { 'HISTORY.MEMO': 'win1252', NOTE: 'win1251' },
  };

  it('qualified REL.FIELD override applies', () => {
    const codec = resolveTextCodec({ charsetId: CS_NONE, fieldName: 'MEMO', relationName: 'HISTORY' }, opts);
    expect(codec.decode(Buffer.from([0x80]))).toBe('€');
  });

  it('bare field override applies', () => {
    const codec = resolveTextCodec({ charsetId: CS_NONE, fieldName: 'NOTE', relationName: 'X' }, opts);
    // 0xC0 is 'А' in win1251
    expect(codec.decode(Buffer.from([0xc0]))).toBe('А');
  });

  it('unmatched fields fall back to byte-preserving latin1', () => {
    const codec = resolveTextCodec({ charsetId: CS_NONE, fieldName: 'OTHER' }, opts);
    const bytes = Buffer.from([0x80, 0x41]);
    const decoded = codec.decode(bytes) as string;
    expect(Buffer.from(decoded, 'latin1').equals(bytes)).toBe(true);
  });
});

describe('OCTETS', () => {
  it('always returns Buffers and refuses string encode', () => {
    const codec = resolveTextCodec({ charsetId: CS_OCTETS }, { connectionCharset: 'UTF8' });
    const out = codec.decode(Buffer.from([1, 2, 3]));
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(() => codec.encode('x')).toThrow();
  });
});

describe('declared column charset beats connection charset', () => {
  it('WIN1252-declared column on a UTF8 connection decodes as win1252', () => {
    const codec = resolveTextCodec({ charsetId: 53 }, { connectionCharset: 'UTF8' });
    // 0x93/0x94 are the win1252 smart quotes U+201C / U+201D
    expect(codec.decode(Buffer.from([0x93, 0x94]))).toBe('“”');
  });
});
