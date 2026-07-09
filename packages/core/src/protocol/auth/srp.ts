import { createHash, randomBytes } from 'node:crypto';

/**
 * Firebird SRP-6a client (plugins Srp / Srp256).
 *
 * Firebird deviates from RFC 5054 in ways that MUST be preserved
 * (see plans/research/node-firebird-notes.md §4 and firebird
 * src/auth/SecureRemotePassword/srp.cpp):
 *  - client proof M1 uses `H(N) ^ H(g) mod N` (modular exponentiation!),
 *    not the RFC's XOR;
 *  - the S exponent is reduced: (a + u·x) mod N;
 *  - the session key K = SHA1(S) regardless of plugin — always 20 bytes;
 *  - only the final proof hash differs per plugin (Srp→SHA1, Srp256→SHA256);
 *  - the user name is uppercased inside hashes;
 *  - public keys travel as ASCII hex; the salt is used exactly as received.
 */

const N = BigInt(
  '0xE67D2E994B2F900C3F41F08F5BB2627ED0D49EE1FE767A52EFCD565CD6E76881' +
    '2C3E1E9CE8F0A8BEA6CB13CD29DDEBF7A96D4A93B55D488DF099A15C89DCB064' +
    '0738EB2CBDD9A8F7BAB561AB1B0DC1C6CDABF303264A08D1BCA932D1F1EE428B' +
    '619D970F342ABA9A65793B8B2F041AE5364350C16F735F56ECBCA87BD57B29E7',
);
const g = 2n;
const KEY_BYTES = 128; // 1024-bit group

export type SrpHash = 'sha1' | 'sha256';

export function proofHashFor(plugin: string): SrpHash {
  switch (plugin) {
    case 'Srp':
      return 'sha1';
    case 'Srp256':
      return 'sha256';
    default:
      throw new Error(`Unsupported SRP plugin: ${plugin}`);
  }
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  base %= mod;
  if (base < 0n) base += mod;
  let result = 1n;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

/** Minimal-length big-endian bytes of a BigInt (odd hex zero-prefixed). */
export function bigIntToBuffer(v: bigint): Buffer {
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

export function bufferToBigInt(buf: Buffer): bigint {
  return buf.length === 0 ? 0n : BigInt('0x' + buf.toString('hex'));
}

/** Left-pad to the group size (128 bytes) for the scramble hash. */
function pad(v: bigint): Buffer {
  const b = bigIntToBuffer(v);
  if (b.length >= KEY_BYTES) return b.subarray(b.length - KEY_BYTES);
  return Buffer.concat([Buffer.alloc(KEY_BYTES - b.length), b]);
}

function sha1(...parts: Buffer[]): Buffer {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest();
}

function hashBigInt(...parts: Buffer[]): bigint {
  return bufferToBigInt(sha1(...parts));
}

export interface SrpEphemeral {
  /** Private key a. */
  a: bigint;
  /** Public key A = g^a mod N. */
  A: bigint;
  /** A as lowercase ASCII hex — the exact bytes sent in CNCT_specific_data. */
  publicHex: string;
}

export function generateEphemeral(seed?: Buffer): SrpEphemeral {
  for (;;) {
    // Reduce mod N: without this a fraction of handshakes fail (research §4.3).
    const a = bufferToBigInt(seed ?? randomBytes(KEY_BYTES)) % N;
    const A = modPow(g, a, N);
    // Server-mirrored guard (srp.cpp genClientKey): regenerate if A ≤ 1.
    if (A > 1n) return { a, A, publicHex: A.toString(16) };
    if (seed) throw new Error('Provided SRP seed produces a trivial public key');
  }
}

export interface SrpProof {
  /** Client proof M, lowercase hex — sent as auth data. */
  proofHex: string;
  /** 20-byte session key (SHA1(S)) — keys wire encryption. */
  sessionKey: Buffer;
}

export function computeProof(
  plugin: string,
  user: string,
  password: string,
  salt: Buffer,
  ephemeral: SrpEphemeral,
  serverKeyHex: string,
): SrpProof {
  const B = BigInt('0x' + serverKeyHex);
  if (B % N === 0n) throw new Error('Invalid SRP server key (B ≡ 0 mod N)');
  const userUpper = Buffer.from(user.toUpperCase(), 'utf8');

  // Scramble hashes the MINIMAL (leading-zero-stripped) key bytes — the
  // server uses processStrippedInt (srp.cpp computeScramble). Hashing
  // 128-byte padded keys instead fails ~1/128 of logins (short A or B).
  const u = hashBigInt(bigIntToBuffer(ephemeral.A), bigIntToBuffer(B));
  // k = SHA1(N ‖ g padded to N's length) — RemoteGroup ctor pads here (only here).
  const k = hashBigInt(pad(N), pad(g));
  const x = bufferToBigInt(sha1(salt, sha1(Buffer.concat([userUpper, Buffer.from(':'), Buffer.from(password, 'utf8')]))));

  const gx = modPow(g, x, N);
  let base = (B - ((k * gx) % N)) % N;
  if (base < 0n) base += N;
  const exp = (ephemeral.a + u * x) % N; // Firebird quirk: exponent reduced mod N
  const S = modPow(base, exp, N);

  const K = sha1(bigIntToBuffer(S)); // session key: always SHA1, 20 bytes

  // n1 = H(N)^H(g) mod N — Firebird quirk (modPow, not XOR).
  const n1 = modPow(hashBigInt(bigIntToBuffer(N)), hashBigInt(bigIntToBuffer(g)), N);
  // n2 = H(user) fed through BigInteger — minimal bytes, leading zeros stripped.
  const n2 = bufferToBigInt(sha1(userUpper));

  const h = createHash(proofHashFor(plugin));
  h.update(bigIntToBuffer(n1));
  h.update(bigIntToBuffer(n2));
  h.update(salt);
  h.update(bigIntToBuffer(ephemeral.A));
  h.update(bigIntToBuffer(B));
  h.update(K);
  const M = bufferToBigInt(h.digest());

  return { proofHex: M.toString(16), sessionKey: K };
}

/**
 * Parse the server auth data (from op_accept_data / op_cont_auth):
 * UInt16LE saltLen | salt | UInt16LE keyLen | server public key as ASCII hex.
 */
export function parseServerAuthData(data: Buffer): { salt: Buffer; serverKeyHex: string } {
  if (data.length < 4) throw new Error('SRP server data too short');
  const saltLen = data.readUInt16LE(0);
  const salt = data.subarray(2, 2 + saltLen);
  let off = 2 + saltLen;
  let keyLen = data.readUInt16LE(off);
  if (off + 2 + keyLen !== data.length) {
    // Some servers/clients align the key field; fall back to 4-byte alignment
    // (node-firebird reads from (saltLen+2+3)&~3 to end).
    const aligned = (saltLen + 2 + 3) & ~3;
    if (aligned + 2 <= data.length) {
      off = aligned;
      keyLen = data.readUInt16LE(off);
    }
  }
  const end = Math.min(off + 2 + keyLen, data.length);
  const serverKeyHex = data.toString('latin1', off + 2, end);
  if (!/^[0-9a-fA-F]+$/.test(serverKeyHex)) {
    throw new Error('SRP server public key is not valid hex');
  }
  return { salt, serverKeyHex };
}
