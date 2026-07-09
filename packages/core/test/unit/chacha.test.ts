import { describe, expect, it } from 'vitest';
import { createCipheriv } from 'node:crypto';
import { createHash } from 'node:crypto';
import { ChaChaFilter } from '../../src/protocol/crypt/chacha.js';

describe('ChaChaFilter', () => {
  const sessionKey = Buffer.alloc(20, 0x5a); // stand-in 20-byte SRP session key

  it('send then receive is identity (symmetric keystream)', () => {
    // Two independent filters keyed identically model client & server.
    const iv = Buffer.alloc(16);
    for (let i = 0; i < 12; i++) iv[i] = i + 1; // 12-byte nonce, counter bytes zero
    const client = new ChaChaFilter(sessionKey, iv);
    const server = new ChaChaFilter(sessionKey, iv);

    const msg = Buffer.from('SELECT * FROM history WHERE memo LIKE ? -- € ção', 'utf8');
    const onWire = client.send(msg);
    expect(onWire.equals(msg)).toBe(false); // actually encrypted
    expect(server.receive(onWire).equals(msg)).toBe(true); // server decrypts
  });

  it('keys with SHA-256 of the session key (matches Firebird ChaCha.cpp)', () => {
    const iv = Buffer.alloc(16);
    iv[0] = 0xaa;
    const filter = new ChaChaFilter(sessionKey, iv);
    const data = Buffer.from('hello chacha');
    const got = filter.send(data);

    // Reproduce the expected keystream directly: key = SHA256(sessionKey),
    // openssl IV = [counter LE(4) | nonce(12)] with counter from iv[12..16].
    const key = createHash('sha256').update(sessionKey).digest();
    const osslIv = Buffer.alloc(16);
    iv.copy(osslIv, 4, 0, 12); // iv[12..16] are zero → counter 0
    const ref = createCipheriv('chacha20', key, osslIv).update(data);
    expect(got.equals(ref)).toBe(true);
  });

  it('accepts 8-byte (ChaCha64) and 12-byte IVs', () => {
    for (const len of [8, 12, 16]) {
      const iv = Buffer.alloc(len, 0x11);
      const a = new ChaChaFilter(sessionKey, iv);
      const b = new ChaChaFilter(sessionKey, iv);
      const m = Buffer.from('roundtrip payload');
      expect(b.receive(a.send(m)).equals(m)).toBe(true);
    }
  });

  it('rejects unsupported IV lengths', () => {
    expect(() => new ChaChaFilter(sessionKey, Buffer.alloc(10))).toThrow(/IV length/);
  });
});
