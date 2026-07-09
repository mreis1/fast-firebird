import { describe, expect, it } from 'vitest';
import { unixCrypt, legacyHash } from '../../src/protocol/auth/legacy.js';

describe('unix DES crypt(3) — Firebird Legacy_Auth', () => {
  // Known-answer vectors (cross-checked against Apache Commons Codec UnixCrypt
  // via node-firebird). The masterkey value is the canonical Firebird SYSDBA
  // legacy hash.
  it('matches known crypt(password, "9z") vectors', () => {
    expect(unixCrypt('masterkey', '9z')).toBe('9zQP3LMZ/MJh.');
    expect(unixCrypt('SYSDBA', '9z')).toBe('9z1S6DteszQU.');
    expect(unixCrypt('a', '9z')).toBe('9zsMhH1U05.Ck');
    expect(unixCrypt('', '9z')).toBe('9zretK2Kk/GLk');
    expect(unixCrypt('Test1234', '9z')).toBe('9zpp5dGqTJhmE');
  });

  it('only the first 8 bytes of the password matter (DES key limit)', () => {
    expect(unixCrypt('masterke', '9z')).toBe(unixCrypt('masterkey', '9z'));
    expect(unixCrypt('12345678', '9z')).toBe(unixCrypt('123456789', '9z'));
  });

  it('hashes non-ASCII passwords as UTF-8 bytes', () => {
    expect(unixCrypt('ção€pw', '9z')).toBe('9zcJ5u.SgZoOw');
  });

  it('legacyHash drops the 2 salt chars (11-char Firebird hash)', () => {
    expect(legacyHash('masterkey')).toBe('QP3LMZ/MJh.');
    expect(legacyHash('masterkey')).toHaveLength(11);
  });

  it('rejects a too-short salt', () => {
    expect(() => unixCrypt('x', 'z')).toThrow(/salt/i);
  });
});
