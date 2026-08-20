import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, dropDatabaseAt, freshDb, nextDatabasePath } from './env.js';

const connId = async (db: Attachment): Promise<number> => {
  const row = await db.queryOne<{ C: unknown }>('select current_connection as c from rdb$database');
  return Number(row!.C);
};

describe.each(FB_SERVERS)('Attachment.reconnect on Firebird $version', ({ port }) => {
  let db: Attachment;

  beforeAll(async () => {
    db = await freshDb(port);
  }, HOOK_TIMEOUT);
  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('re-attaches the SAME object to a new server connection', async () => {
    const before = await connId(db);
    await db.reconnect();
    expect(db.isAlive).toBe(true);
    const after = await connId(db);
    expect(after).not.toBe(before);
  });

  it('keeps roundTrips cumulative across the reconnect', async () => {
    const before = db.roundTrips;
    await db.reconnect();
    await db.query('select 1 from rdb$database');
    expect(db.roundTrips).toBeGreaterThan(before);
  });

  it('invalidates a pre-reconnect transaction with a clear error', async () => {
    const tx = await db.startTransaction();
    await tx.query('select 1 from rdb$database');
    await db.reconnect();
    await expect(tx.query('select 1 from rdb$database')).rejects.toThrow(/attachment was reconnected/);
    await expect(tx.commit()).rejects.toThrow(/attachment was reconnected/);
    // The attachment itself is fine — only the stale handle is dead.
    expect(await db.query('select 1 as one from rdb$database')).toEqual([{ ONE: 1 }]);
  });

  it('invalidates a pre-reconnect prepared statement; close() is a safe no-op', async () => {
    const stmt = await db.prepare('select 2 as two from rdb$database');
    expect((await stmt.query())[0]).toEqual({ TWO: 2 });
    await db.reconnect();
    await expect(stmt.query()).rejects.toThrow(/reconnected — prepare it again/);
    await stmt.close(); // server handle died with the old connection — must not throw
    const again = await db.prepare('select 3 as three from rdb$database');
    expect((await again.query())[0]).toEqual({ THREE: 3 });
    await again.close();
  });

  it('notifies event listeners with an error and drops the subscriptions', async () => {
    const ev = await db.events(['recon_evt']);
    const errP = new Promise<Error>((resolve) => ev.on('error', resolve));
    await db.reconnect();
    const err = await errP;
    expect(String(err.message)).toMatch(/reconnected/);
    // Re-subscribing on the fresh connection works.
    const ev2 = await db.events(['recon_evt2']);
    await ev2.close();
  });
});

describe('reconnect is pool-safe (Firebird 5)', () => {
  const fb5 = FB_SERVERS.find((s) => s.version === 5)!;

  it('a pooled connection that reconnects stays usable through the pool', async () => {
    const dbPath = nextDatabasePath(fb5.port);
    const seed = await (await import('../../src/index.js')).createDatabase({
      ...FB_BASE,
      port: fb5.port,
      database: dbPath,
    });
    await seed.disconnect();
    const pool = await createPool({ ...FB_BASE, port: fb5.port, database: dbPath, min: 1, max: 1 });
    try {
      const idBefore = await pool.use((c) => connId(c));
      await pool.use((c) => c.reconnect());
      // max: 1 → this is the SAME Attachment object, now on a new connection.
      const idAfter = await pool.use((c) => connId(c));
      expect(idAfter).not.toBe(idBefore);
      expect(await pool.query('select 1 as one from rdb$database')).toEqual([{ ONE: 1 }]);
    } finally {
      await pool.close();
      await dropDatabaseAt(fb5.port, dbPath);
    }
  }, HOOK_TIMEOUT);
});
