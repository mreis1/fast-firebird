import { createCipheriv, createDecipheriv, createHash, type Cipher, type Decipher } from 'node:crypto';
import type { WireFilter } from '../transport.js';

/**
 * ChaCha20 wire encryption (Firebird 4+, plugins "ChaCha" and "ChaCha64").
 *
 * Key = SHA-256(SRP session key) — 32 bytes (ChaCha.cpp createCypher).
 * The server generates the IV/nonce and returns it in the op_crypt response;
 * both directions share key+IV (symmetric XOR keystream, counter starts at 0).
 *
 * Node's `chacha20` cipher wants a 16-byte IV laid out as
 * [4-byte little-endian counter | 12-byte nonce]. We reassemble the server IV
 * into that shape exactly as fbclient does (see node-firebird socket.js):
 *   - ivlen 16 ("ChaCha"):   counter = big-endian(iv[12..16]) → LE at [0..4];
 *                            nonce = iv[0..12] at [4..16].
 *   - ivlen 8  ("ChaCha64"): 8-byte IV copied to [8..16] (64-bit counter form).
 *   - ivlen 12:              nonce = iv[0..12] at [4..16], counter 0.
 */
function toOpenSslIv(iv: Buffer): Buffer {
  const out = Buffer.alloc(16);
  switch (iv.length) {
    case 16: {
      const ctr = ((iv[12]! << 24) | (iv[13]! << 16) | (iv[14]! << 8) | iv[15]!) >>> 0;
      out.writeUInt32LE(ctr, 0);
      iv.copy(out, 4, 0, 12);
      break;
    }
    case 12:
      iv.copy(out, 4, 0, 12);
      break;
    case 8:
      iv.copy(out, 8, 0, 8);
      break;
    default:
      throw new Error(`Unsupported ChaCha IV length ${iv.length} (expected 8, 12 or 16)`);
  }
  return out;
}

export class ChaChaFilter implements WireFilter {
  private readonly tx: Cipher;
  private readonly rx: Decipher;

  constructor(sessionKey: Buffer, iv: Buffer) {
    const key = createHash('sha256').update(sessionKey).digest();
    const opensslIv = toOpenSslIv(iv);
    this.tx = createCipheriv('chacha20', key, opensslIv);
    this.rx = createDecipheriv('chacha20', key, opensslIv);
  }

  send(data: Buffer): Buffer {
    return this.tx.update(data);
  }

  receive(data: Buffer): Buffer {
    return this.rx.update(data);
  }
}
