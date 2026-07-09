import { describe, expect, it } from 'vitest';
import { connect } from '../../src/index.js';
import { generateEphemeral } from '../../src/protocol/auth/srp.js';
import { FB_BASE, FB_SERVERS } from './env.js';

/**
 * Regression: SRP scramble must hash MINIMAL key bytes (Firebird's
 * processStrippedInt), not 128-byte padded ones. With padding, any handshake
 * where the client public key A is shorter than 128 bytes (~1 in 256) failed
 * with "user name and password not defined".
 */

/** Deterministically find a seed whose public key A is < 128 bytes. */
function findShortKeySeed(): Buffer {
  for (let i = 0; ; i++) {
    const seed = Buffer.alloc(128);
    seed.writeUInt32BE(i, 0);
    seed[127] = 1; // keep a non-trivial
    const { A } = generateEphemeral(seed);
    // A's top byte zero → minimal representation is ≤ 127 bytes.
    if (A < 1n << 1016n) return seed;
    if (i > 5000) throw new Error('No short-key seed found (unexpected)');
  }
}

const shortSeed = findShortKeySeed();

describe.each(FB_SERVERS)('SRP short-key handshake on Firebird $version', ({ port }) => {
  it('authenticates when the client public key has a leading zero byte', async () => {
    const db = await connect({ ...FB_BASE, port, srpSeed: shortSeed });
    try {
      expect(await db.query('select 1 as ok from rdb$database')).toEqual([{ OK: 1 }]);
    } finally {
      await db.disconnect();
    }
  });

  it('authenticates with Srp (sha1) using the same short key', async () => {
    const db = await connect({ ...FB_BASE, port, srpSeed: shortSeed, authPlugin: 'Srp' });
    try {
      await db.disconnect();
    } catch {
      /* disconnect best-effort */
    }
  });
});

describe('SRP handshake soak (statistical, FB5)', () => {
  it('survives 150 consecutive fresh handshakes', async () => {
    const port = FB_SERVERS.find((s) => s.version === 5)!.port;
    for (let i = 0; i < 150; i++) {
      const db = await connect({ ...FB_BASE, port, wireCrypt: i % 2 === 0 ? 'enabled' : 'disabled' });
      await db.disconnect();
    }
  }, 120_000);
});
