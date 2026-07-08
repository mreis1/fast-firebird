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

  it('rejects a wrong password', async () => {
    await expect(connect({ ...FB_BASE, port, password: 'wrong' })).rejects.toThrow(/user name|password|login|install|error/i);
  });

  it('rejects a nonexistent database path', async () => {
    await expect(connect({ ...FB_BASE, port, database: '/var/lib/firebird/data/nope.fdb' })).rejects.toThrow();
  });
});
