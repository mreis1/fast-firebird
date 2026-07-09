import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, FirebirdBlobError, type Attachment, type Blob } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

describe.each(FB_SERVERS)('tx.restart on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_RESTART_${version}`;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer, memo blob sub_type text)`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db.execute(`delete from ${t}`).catch(() => undefined);
    await db?.dropDatabase();
  });

  it('restart() commits the current work and reopens (same object, new handle)', async () => {
    await db.execute(`delete from ${t}`);
    const tx = await db.startTransaction();
    await tx.execute(`insert into ${t} (id) values (1)`);
    await tx.restart(); // commit + reopen (handle may be recycled by the server)
    expect(tx.isFinished).toBe(false);
    // The insert was committed, visible to a fresh read.
    const [c] = await db.query(`select count(*) as n from ${t}`);
    expect(Number(c!.N)).toBe(1);
    await tx.execute(`insert into ${t} (id) values (2)`);
    await tx.commit();
    const [c2] = await db.query(`select count(*) as n from ${t}`);
    expect(Number(c2!.N)).toBe(2);
  });

  it("restart({ action: 'rollback' }) discards the current work and reopens", async () => {
    await db.execute(`delete from ${t}`);
    const tx = await db.startTransaction();
    await tx.execute(`insert into ${t} (id) values (10)`);
    await tx.restart({ action: 'rollback' });
    expect(tx.isFinished).toBe(false);
    // The insert was rolled back.
    await tx.execute(`insert into ${t} (id) values (11)`);
    await tx.commit();
    const rows = await db.query(`select id from ${t} order by id`);
    expect(rows.map((r) => r.ID)).toEqual([11]);
  });

  it('restart with new options changes the strategy (read-only → read-write)', async () => {
    const tx = await db.startTransaction({ readOnly: true });
    // A read-only transaction cannot write.
    await expect(tx.execute(`insert into ${t} (id) values (20)`)).rejects.toThrow(/read.?only|read-only/i);
    await tx.restart({ action: 'rollback', readOnly: false });
    // Now writable.
    await tx.execute(`insert into ${t} (id) values (21)`);
    await tx.commit();
    const rows = await db.query(`select id from ${t} where id = 21`);
    expect(rows).toHaveLength(1);
    await db.execute(`delete from ${t} where id = 21`);
  });

  it('restart reuses the stored strategy when no options are given', async () => {
    const tx = await db.startTransaction({ readOnly: true });
    try {
      await tx.restart(); // still read-only
      await expect(tx.execute(`insert into ${t} (id) values (30)`)).rejects.toThrow(/read.?only|read-only/i);
    } finally {
      await tx.rollback();
    }
  });

  it('restart invalidates lazy blob handles from the previous cycle', async () => {
    await db.execute(`delete from ${t}`);
    await db.execute(`insert into ${t} (id, memo) values (1, ?)`, ['before restart']);
    const tx = await db.startTransaction();
    let handle: Blob | undefined;
    for await (const row of tx.queryStream(`select memo from ${t} where id = 1`, [], { blobs: 'lazy' })) {
      handle = row.MEMO as Blob;
    }
    await tx.restart();
    // The handle belonged to the pre-restart transaction — now dead.
    await expect(handle!.text()).rejects.toBeInstanceOf(FirebirdBlobError);
    await tx.commit();
  });

  it('supports many restarts in a loop', async () => {
    await db.execute(`delete from ${t}`);
    const tx = await db.startTransaction();
    for (let i = 0; i < 5; i++) {
      await tx.execute(`insert into ${t} (id) values (?)`, [i]);
      await tx.restart();
    }
    await tx.commit();
    const [c] = await db.query(`select count(*) as n from ${t}`);
    expect(Number(c!.N)).toBe(5);
  });
});
