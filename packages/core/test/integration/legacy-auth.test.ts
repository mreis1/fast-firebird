import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '../../src/index.js';
import { FB_BASE, HOOK_TIMEOUT } from './env.js';

// Dedicated Legacy_Auth server (SRP kept only to provision SYSDBA + create the
// legacy user; WireCrypt disabled — mirrors the user's migration environment).
const LEGACY_PORT = 30506;
const LEGACY_USER = 'LEGBOB';
const LEGACY_PW = 'legpw123';

describe('Legacy_Auth (migration path)', () => {
  let admin: Attachment;

  beforeAll(async () => {
    admin = await connect({ ...FB_BASE, port: LEGACY_PORT, wireCrypt: 'disabled' });
    await admin.execute(`create or alter user ${LEGACY_USER} password '${LEGACY_PW}' using plugin Legacy_UserManager`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await admin?.execute(`drop user ${LEGACY_USER} using plugin Legacy_UserManager`).catch(() => undefined);
    await admin?.disconnect();
  });

  it('authenticates a legacy user via Legacy_Auth (unencrypted wire)', async () => {
    const db = await connect({
      ...FB_BASE,
      port: LEGACY_PORT,
      user: LEGACY_USER,
      password: LEGACY_PW,
      authPlugin: 'Legacy_Auth',
      wireCrypt: 'disabled',
    });
    try {
      expect(db.wireEncrypted).toBe(false);
      const [r] = await db.query('select current_user as u, cast(2 as integer) as v from rdb$database');
      expect(r!.U).toBe(LEGACY_USER);
      expect(r!.V).toBe(2);
    } finally {
      await db.disconnect();
    }
  });

  it('runs real queries over a Legacy_Auth connection', async () => {
    const db = await connect({
      ...FB_BASE,
      port: LEGACY_PORT,
      user: LEGACY_USER,
      password: LEGACY_PW,
      authPlugin: 'Legacy_Auth',
      wireCrypt: 'disabled',
    });
    try {
      const rows = await db.query('select first 3 rdb$relation_id as id from rdb$relations order by rdb$relation_id');
      expect(rows).toHaveLength(3);
    } finally {
      await db.disconnect();
    }
  });

  it('rejects a wrong Legacy_Auth password', async () => {
    await expect(
      connect({
        ...FB_BASE,
        port: LEGACY_PORT,
        user: LEGACY_USER,
        password: 'nope',
        authPlugin: 'Legacy_Auth',
        wireCrypt: 'disabled',
      }),
    ).rejects.toThrow(/login|password|user name|error occurred during login/i);
  });

  it('SRP still works on the same (mixed-auth) server', async () => {
    const db = await connect({ ...FB_BASE, port: LEGACY_PORT, wireCrypt: 'disabled' });
    try {
      expect(db.protocolVersion).toBeGreaterThanOrEqual(13);
      const [r] = await db.query('select 1 as v from rdb$database');
      expect(r!.V).toBe(1);
    } finally {
      await db.disconnect();
    }
  });
});
