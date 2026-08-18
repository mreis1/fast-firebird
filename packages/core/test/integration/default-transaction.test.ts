import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

/**
 * Connection-level `defaultTransaction`: a baseline TransactionOptions merged
 * under every transaction the connection starts — explicit and implicit alike
 * (backlog: high-concurrency defaults without per-call repetition).
 */
describe.each(FB_SERVERS)('defaultTransaction on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  let dbPath: string;
  const t = `T_DEFTX_${version}`;
  let nextId = 1000;
  const id = () => nextId++;

  const attach = (extra: Record<string, unknown>) =>
    connect({ ...FB_BASE, port, database: dbPath, ...extra });

  beforeAll(async () => {
    db = await freshDb(port);
    dbPath = db.options.database;
    await ddl(db, `recreate table ${t} (id integer not null primary key, val varchar(20))`);
    await db.execute(`insert into ${t} (id, val) values (1, 'base')`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('applies to explicit transactions: readCommitted default sees concurrent commits', async () => {
    const rc = await attach({ defaultTransaction: { isolation: 'readCommitted' } });
    try {
      const tx = await rc.startTransaction(); // no per-call options — default kicks in
      try {
        const rowId = id();
        await db.execute(`insert into ${t} (id, val) values (?, ?)`, [rowId, 'after']);
        // Snapshot would NOT see this row; read committed does.
        const rows = await tx.query(`select val from ${t} where id = ?`, [rowId]);
        expect(rows).toEqual([{ VAL: 'after' }]);
      } finally {
        await tx.rollback();
      }
    } finally {
      await rc.disconnect();
    }
  });

  it('per-call options override the default field-by-field', async () => {
    const rc = await attach({ defaultTransaction: { isolation: 'readCommitted' } });
    try {
      const tx = await rc.startTransaction({ isolation: 'snapshot' });
      try {
        const rowId = id();
        await db.execute(`insert into ${t} (id, val) values (?, ?)`, [rowId, 'hidden']);
        // Snapshot override: the concurrently committed row is invisible.
        const rows = await tx.query(`select val from ${t} where id = ?`, [rowId]);
        expect(rows).toEqual([]);
      } finally {
        await tx.rollback();
      }
    } finally {
      await rc.disconnect();
    }
  });

  it('applies to implicit transactions: nowait default fails fast on a held lock', async () => {
    const nowait = await attach({ defaultTransaction: { isolation: 'readCommitted', wait: false } });
    const holder = await db.startTransaction();
    try {
      await holder.execute(`update ${t} set val = 'held' where id = 1`);
      // db.execute opens its own transaction — the nowait default must reach
      // it. A record-level conflict on an uncommitted version surfaces as
      // "update conflicts with concurrent update"; the point is it fails FAST.
      const started = Date.now();
      await expect(nowait.execute(`update ${t} set val = 'blocked' where id = 1`)).rejects.toThrow(
        /update conflicts|lock conflict/i,
      );
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await holder.rollback();
      await nowait.disconnect();
    }
  });

  it('numeric wait default becomes a lock timeout', async () => {
    const bounded = await attach({ defaultTransaction: { isolation: 'readCommitted', wait: 1 } });
    const holder = await db.startTransaction();
    try {
      await holder.execute(`update ${t} set val = 'held2' where id = 1`);
      const started = Date.now();
      // After the 1s lock timeout, the still-uncommitted competing version
      // surfaces as an update conflict — the timing proves the bounded wait.
      await expect(bounded.execute(`update ${t} set val = 'blocked2' where id = 1`)).rejects.toThrow(
        /update conflicts|lock time-out/i,
      );
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      await holder.rollback();
      await bounded.disconnect();
    }
  }, 15_000);

  it('readOnly default without upgrade: one-shot writes are refused', async () => {
    const ro = await attach({ defaultTransaction: { readOnly: true } });
    try {
      await expect(ro.execute(`insert into ${t} (id, val) values (?, ?)`, [id(), 'no'])).rejects.toThrow(
        /read-only transaction/i,
      );
      expect(await ro.queryOne(`select count(*) as n from ${t}`)).toBeDefined(); // reads still fine
    } finally {
      await ro.disconnect();
    }
  });

  it('the node-firebird2 pattern: readOnly + autoUpgradeReadOnly replays one-shot writes', async () => {
    const legacyDefaults = await attach({
      defaultTransaction: { isolation: 'readCommitted', readOnly: true, wait: 5, autoUpgradeReadOnly: true },
    });
    try {
      const rowId = id();
      // db.execute starts read-only, hits isc_read_only_trans, upgrades, replays.
      expect(await legacyDefaults.execute(`insert into ${t} (id, val) values (?, ?)`, [rowId, 'up'])).toBe(1);
      expect(await legacyDefaults.queryOne(`select val from ${t} where id = ?`, [rowId])).toEqual({ VAL: 'up' });
    } finally {
      await legacyDefaults.disconnect();
    }
  });

  it('executeBatch ignores a readOnly default (batch is DML by contract)', async () => {
    if (version < 4) return; // wire batch API needs FB4+
    const ro = await attach({ defaultTransaction: { readOnly: true } });
    try {
      const a = id();
      const b = id();
      const r = await ro.executeBatch(`insert into ${t} (id, val) values (?, ?)`, [
        [a, 'b1'],
        [b, 'b2'],
      ]);
      expect(r.rowsAffected).toBe(2);
    } finally {
      await ro.disconnect();
    }
  });

  it('pool + drizzle paths inherit via connect options (smoke: transaction helper)', async () => {
    const rc = await attach({ defaultTransaction: { isolation: 'readCommitted', wait: false } });
    try {
      const holder = await db.startTransaction();
      try {
        await holder.execute(`update ${t} set val = 'held3' where id = 1`);
        await expect(
          rc.transaction((tx) => tx.execute(`update ${t} set val = 'blocked3' where id = 1`)),
        ).rejects.toThrow(/update conflicts|lock conflict/i);
      } finally {
        await holder.rollback();
      }
    } finally {
      await rc.disconnect();
    }
  });
});
