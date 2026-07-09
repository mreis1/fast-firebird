import { describe, expect, it } from 'vitest';
import { connect } from '../../src/index.js';
import { FB_BASE, FB_SERVERS } from './env.js';

describe.each(FB_SERVERS)('connect to Firebird $version', ({ port, version }) => {
  it('attaches with SRP auth and detaches cleanly', async () => {
    const db = await connect({ ...FB_BASE, port });
    expect(db.protocolVersion).toBeGreaterThanOrEqual(13);
    expect(db.wireEncrypted).toBe(true);
    await db.disconnect();
  });

  it('attaches with wireCrypt disabled', async () => {
    const db = await connect({ ...FB_BASE, port, wireCrypt: 'disabled' });
    expect(db.wireEncrypted).toBe(false);
    await db.disconnect();
  });

  it('attaches with the plain Srp (sha1) plugin', async () => {
    const db = await connect({ ...FB_BASE, port, authPlugin: 'Srp' });
    expect(db.protocolVersion).toBeGreaterThanOrEqual(13);
    await db.disconnect();
  });

  it('rejects a wrong password promptly (no auth-negotiation deadlock)', async () => {
    const start = Date.now();
    const err = await connect({ ...FB_BASE, port, password: 'wrong' }).catch((e) => e);
    expect(String(err.message)).toMatch(/user name|password|login/i);
    expect(err.gdsCode).toBe(335544472);
    expect(Date.now() - start).toBeLessThan(5000); // must not hang on plugin re-offers
  });

  it('rejects a wrong password with plain Srp too', async () => {
    // Depending on server config a bad Srp login is answered with an auth
    // error OR an outright connection drop — both are valid rejections.
    await expect(connect({ ...FB_BASE, port, password: 'nope', authPlugin: 'Srp' })).rejects.toThrow(
      /user name|password|login|closed/i,
    );
  });

  it('rejects a nonexistent database path', async () => {
    await expect(connect({ ...FB_BASE, port, database: '/var/lib/firebird/data/nope.fdb' })).rejects.toThrow();
  });
});
