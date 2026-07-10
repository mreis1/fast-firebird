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

// Server-initiated fallback: the client does NOT force authPlugin — the server
// walks its AuthServer list (Srp256 → Srp → Legacy_Auth) and the driver must
// follow the switch mid-handshake, exactly like fbclient's default AuthClient.
describe('Legacy_Auth server-initiated fallback', () => {
  let admin: Attachment;

  const authMethod = async (db: Attachment) => {
    const [r] = await db.query(
      'select MON$AUTH_METHOD as M from MON$ATTACHMENTS where MON$ATTACHMENT_ID = current_connection',
    );
    return String((r as any).M ?? '').trim();
  };

  beforeAll(async () => {
    admin = await connect({ ...FB_BASE, port: LEGACY_PORT, wireCrypt: 'disabled' });
    // LEGDRIFT exists in BOTH managers with DIFFERENT passwords — the classic
    // gsec-managed server: the SRP verifier is stale, the legacy one current.
    await admin.execute(`create or alter user LEGDRIFT password 'srp-stale' using plugin Srp`);
    await admin.execute(`create or alter user LEGDRIFT password 'leg-current' using plugin Legacy_UserManager`);
    // LEGSOLO exists ONLY in the legacy security database.
    await admin.execute(`create or alter user LEGSOLO password 'legsolo1' using plugin Legacy_UserManager`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await admin?.execute('drop user LEGDRIFT using plugin Srp').catch(() => undefined);
    await admin?.execute('drop user LEGDRIFT using plugin Legacy_UserManager').catch(() => undefined);
    await admin?.execute('drop user LEGSOLO using plugin Legacy_UserManager').catch(() => undefined);
    await admin?.disconnect();
  });

  it('falls back to Legacy_Auth when the SRP password is stale (drifted account)', async () => {
    const db = await connect({
      ...FB_BASE,
      port: LEGACY_PORT,
      user: 'LEGDRIFT',
      password: 'leg-current', // matches legacy only; Srp256+Srp proofs fail first
      wireCrypt: 'disabled',
    });
    try {
      expect(await authMethod(db)).toBe('Legacy_Auth');
      expect(db.wireEncrypted).toBe(false);
    } finally {
      await db.disconnect();
    }
  });

  it('authenticates a legacy-only account without authPlugin', async () => {
    const db = await connect({
      ...FB_BASE,
      port: LEGACY_PORT,
      user: 'LEGSOLO',
      password: 'legsolo1',
      wireCrypt: 'disabled',
    });
    try {
      expect(await authMethod(db)).toBe('Legacy_Auth');
    } finally {
      await db.disconnect();
    }
  });

  it('still prefers SRP when the SRP password matches', async () => {
    const db = await connect({ ...FB_BASE, port: LEGACY_PORT, wireCrypt: 'disabled' });
    try {
      expect(await authMethod(db)).toMatch(/^Srp/);
    } finally {
      await db.disconnect();
    }
  });

  it('rejects a password wrong in every manager (no hang, proper login error)', async () => {
    await expect(
      connect({ ...FB_BASE, port: LEGACY_PORT, user: 'LEGDRIFT', password: 'nope', wireCrypt: 'disabled' }),
    ).rejects.toThrow(/user name and password are not defined/i);
  }, 15_000);
});
