import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Attachment } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

/**
 * Nested transactions via SAVEPOINT: `tx.transaction(fn)` releases on
 * success, rolls back to the savepoint on error — the outer transaction
 * survives either way.
 */
describe.each(FB_SERVERS)('savepoints (nested transactions) on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_SP_${version}`;
  let nextId = 1;
  const id = () => nextId++;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer not null primary key, val varchar(20))`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  const ids = async () => (await db.query(`select id from ${t} order by id`)).map((r) => r.ID);

  it('inner failure rolls back ONLY the savepoint scope; outer work commits', async () => {
    const keep = id();
    const drop = id();
    await db.transaction(async (tx) => {
      await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [keep, 'keep']);
      await expect(
        tx.transaction(async () => {
          await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [drop, 'drop']);
          throw new Error('undo inner');
        }),
      ).rejects.toThrow('undo inner');
      // Outer tx is still alive and its work intact.
      expect(tx.isFinished).toBe(false);
      const seen = await tx.query(`select id from ${t} where id in (?, ?)`, [keep, drop]);
      expect(seen).toEqual([{ ID: keep }]);
    });
    expect(await ids()).toContain(keep);
    expect(await ids()).not.toContain(drop);
  });

  it('inner success is released and commits with the outer transaction', async () => {
    const a = id();
    const b = id();
    await db.transaction(async (tx) => {
      await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [a, 'outer']);
      const result = await tx.transaction(async () => {
        await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [b, 'inner']);
        return 'inner-result';
      });
      expect(result).toBe('inner-result');
    });
    const got = await ids();
    expect(got).toEqual(expect.arrayContaining([a, b]));
  });

  it('nests two levels deep with independent rollback scopes', async () => {
    const l1 = id();
    const l2keep = id();
    const l2drop = id();
    await db.transaction(async (tx) => {
      await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [l1, 'L1']);
      await tx.transaction(async () => {
        await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [l2keep, 'L2']);
        await tx
          .transaction(async () => {
            await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [l2drop, 'L3']);
            throw new Error('undo level 3');
          })
          .catch(() => undefined);
      });
    });
    const got = await ids();
    expect(got).toEqual(expect.arrayContaining([l1, l2keep]));
    expect(got).not.toContain(l2drop);
  });

  it('sequential savepoint scopes in one transaction reuse depth-based names', async () => {
    const a = id();
    const b = id();
    const c = id();
    await db.transaction(async (tx) => {
      for (const [rowId, ok] of [
        [a, true],
        [b, false],
        [c, true],
      ] as const) {
        await tx
          .transaction(async () => {
            await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [rowId, 'seq']);
            if (!ok) throw new Error('drop this one');
          })
          .catch(() => undefined);
      }
    });
    const got = await ids();
    expect(got).toEqual(expect.arrayContaining([a, c]));
    expect(got).not.toContain(b);
  });

  it('outer rollback discards released savepoint work too', async () => {
    const a = id();
    const tx = await db.startTransaction();
    await tx.transaction(async () => {
      await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [a, 'gone']);
    });
    await tx.rollback();
    expect(await ids()).not.toContain(a);
  });

  it('a failed statement inside the scope leaves the outer tx usable', async () => {
    const a = id();
    await db.transaction(async (tx) => {
      await expect(
        tx.transaction(async () => {
          await tx.execute(`insert into nonexistent_table_${version} (x) values (1)`);
        }),
      ).rejects.toThrow(/Table unknown/i);
      // Outer continues normally after the savepoint rollback.
      await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [a, 'after']);
    });
    expect(await ids()).toContain(a);
  });
});
