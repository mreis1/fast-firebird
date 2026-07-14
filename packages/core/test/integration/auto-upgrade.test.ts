import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

/**
 * Deferred backlog #7: opt-in RO→RW transaction auto-upgrade with statement
 * replay (`autoUpgradeReadOnly`), in core's own API. Off by default — a write
 * in a read-only transaction stays an error unless opted in per transaction
 * or per connection.
 */
describe.each(FB_SERVERS)('autoUpgradeReadOnly on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_UPG_${version}`;
  let nextId = 1;
  const id = () => nextId++;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer not null primary key, val varchar(20))`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('default: a write in a read-only tx throws and does NOT upgrade', async () => {
    const tx = await db.startTransaction({ readOnly: true });
    try {
      await expect(tx.execute(`insert into ${t} (id, val) values (?, ?)`, [id(), 'no'])).rejects.toThrow(
        /read-only transaction/i,
      );
      expect(tx.autoUpgraded).toBe(false);
      // The transaction stays alive and readable after the refused write.
      const rows = await tx.query(`select count(*) as n from ${t}`);
      expect(rows[0]!.N).toBe(0);
    } finally {
      await tx.rollback();
    }
  });

  it('per-tx opt-in: the write replays on a read-write tx and commits', async () => {
    const rowId = id();
    const tx = await db.startTransaction({ readOnly: true, autoUpgradeReadOnly: true });
    const affected = await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [rowId, 'up']);
    expect(affected).toBe(1);
    expect(tx.autoUpgraded).toBe(true);
    // Same transaction object keeps working read-write.
    const rows = await tx.query(`select val from ${t} where id = ?`, [rowId]);
    expect(rows).toEqual([{ VAL: 'up' }]);
    await tx.commit();
    const persisted = await db.query(`select val from ${t} where id = ?`, [rowId]);
    expect(persisted).toEqual([{ VAL: 'up' }]);
  });

  it('reads before the write are fine; later writes need no second upgrade', async () => {
    const a = id();
    const b = id();
    const tx = await db.startTransaction({ readOnly: true, autoUpgradeReadOnly: true });
    expect((await tx.query(`select 1 as one from rdb$database`))[0]!.ONE).toBe(1);
    expect(tx.autoUpgraded).toBe(false); // reads alone never upgrade
    await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [a, 'first']);
    expect(tx.autoUpgraded).toBe(true);
    await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [b, 'second']); // already RW
    await tx.commit();
    const n = await db.query(`select count(*) as n from ${t} where id in (?, ?)`, [a, b]);
    expect(n[0]!.N).toBe(2);
  });

  it('connection-level default applies to every read-only tx', async () => {
    const rowId = id();
    const conn = await connect({ ...FB_BASE, port, database: (db as any).options.database, autoUpgradeReadOnly: true });
    try {
      await conn.transaction(
        async (tx) => {
          await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [rowId, 'conn']);
          expect(tx.autoUpgraded).toBe(true);
        },
        { readOnly: true },
      );
      expect(await conn.query(`select val from ${t} where id = ?`, [rowId])).toEqual([{ VAL: 'conn' }]);
    } finally {
      await conn.disconnect();
    }
  });

  it('per-tx false overrides a connection-level true', async () => {
    const conn = await connect({ ...FB_BASE, port, database: (db as any).options.database, autoUpgradeReadOnly: true });
    try {
      const tx = await conn.startTransaction({ readOnly: true, autoUpgradeReadOnly: false });
      try {
        await expect(tx.execute(`insert into ${t} (id, val) values (?, ?)`, [id(), 'no'])).rejects.toThrow(
          /read-only transaction/i,
        );
        expect(tx.autoUpgraded).toBe(false);
      } finally {
        await tx.rollback();
      }
    } finally {
      await conn.disconnect();
    }
  });

  it('other errors are never treated as an upgrade trigger', async () => {
    const rowId = id();
    await db.execute(`insert into ${t} (id, val) values (?, ?)`, [rowId, 'dup']);
    const tx = await db.startTransaction({ autoUpgradeReadOnly: true }); // read-write
    try {
      // PK violation on a RW tx: propagates untouched, no restart happened.
      await expect(tx.execute(`insert into ${t} (id, val) values (?, ?)`, [rowId, 'dup2'])).rejects.toThrow(
        /violation|unique|PRIMARY/i,
      );
      expect(tx.autoUpgraded).toBe(false);
    } finally {
      await tx.rollback();
    }
  });

  it('rollback after an upgrade discards the replayed write', async () => {
    const rowId = id();
    const tx = await db.startTransaction({ readOnly: true, autoUpgradeReadOnly: true });
    await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [rowId, 'gone']);
    expect(tx.autoUpgraded).toBe(true);
    await tx.rollback();
    expect(await db.query(`select 1 as x from ${t} where id = ?`, [rowId])).toEqual([]);
  });
});
