import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, withRetry, HOOK_TIMEOUT } from './env.js';

describe.each(FB_SERVERS)('statement cache & round trips on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const table = `T_CACHE_${version}`;

  beforeAll(async () => {
    db = await connect({ ...FB_BASE, port });
    await withRetry(() => db.execute(`recreate table ${table} (id integer not null primary key, name varchar(40))`));
    await db.execute(`insert into ${table} values (1, 'one')`);
    await db.execute(`insert into ${table} values (2, 'two')`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.disconnect();
  });

  it('a warm cached select costs exactly ONE round trip inside a transaction', async () => {
    const sql = `select name from ${table} where id = ?`;
    await db.transaction(async (tx) => {
      await tx.query(sql, [1]); // cold: prepare + execute
      const before = db.roundTrips;
      const rows = await tx.query(sql, [2]); // warm: execute+fetch coalesced
      expect(rows).toEqual([{ NAME: 'two' }]);
      expect(db.roundTrips - before).toBe(1);
    });
  });

  it('a cold select costs exactly TWO round trips (prepare, execute+fetch)', async () => {
    const sql = `select id from ${table} where name = ? /* cold ${Math.PI} */`;
    await db.transaction(async (tx) => {
      const before = db.roundTrips;
      await tx.query(sql, ['one']);
      expect(db.roundTrips - before).toBe(2);
    });
  });

  it('warm DML costs exactly ONE round trip (execute + record counts coalesced)', async () => {
    const sql = `update ${table} set name = ? where id = ?`;
    await db.transaction(async (tx) => {
      await tx.execute(sql, ['uno', 1]); // cold
      const before = db.roundTrips;
      const n = await tx.execute(sql, ['dos', 2]); // warm
      expect(n).toBe(1);
      expect(db.roundTrips - before).toBe(1);
    });
  });

  it('a one-shot warm query costs three round trips (tx start, work, commit)', async () => {
    const sql = `select name from ${table} where id = ?`;
    await db.query(sql, [1]); // ensure cached
    const before = db.roundTrips;
    await db.query(sql, [2]);
    expect(db.roundTrips - before).toBe(3);
  });

  it('cached statements return fresh data across transactions', async () => {
    const sql = `select name from ${table} where id = ?`;
    const [before] = await db.query(sql, [1]);
    await db.execute(`update ${table} set name = 'changed' where id = 1`);
    const [after] = await db.query(sql, [1]);
    expect(before!.NAME).not.toBe('changed');
    expect(after!.NAME).toBe('changed');
  });

  it('interleaving two cached selects keeps cursors independent', async () => {
    const a = `select name from ${table} where id = ?`;
    const b = `select id from ${table} where name = ?`;
    await db.transaction(async (tx) => {
      expect(await tx.query(a, [1])).toEqual([{ NAME: 'changed' }]);
      expect(await tx.query(b, ['dos'])).toEqual([{ ID: 2 }]);
      expect(await tx.query(a, [2])).toEqual([{ NAME: 'dos' }]);
      expect(await tx.query(b, ['changed'])).toEqual([{ ID: 1 }]);
    });
  });

  it('evicts beyond capacity and still works (LRU)', async () => {
    const small = await connect({ ...FB_BASE, port, statementCacheSize: 2 });
    try {
      const queries = [
        `select 1 as v from rdb$database`,
        `select 2 as v from rdb$database`,
        `select 3 as v from rdb$database`,
      ];
      for (let round = 0; round < 3; round++) {
        for (const [i, sql] of queries.entries()) {
          const [row] = await small.query(sql);
          expect(row!.V).toBe(i + 1);
        }
      }
    } finally {
      await small.disconnect();
    }
  });

  it('DDL on this connection clears the cache and re-prepares transparently', async () => {
    const sql = `select * from ${table} where id = ?`;
    const [r1] = await db.query(sql, [1]);
    expect(Object.keys(r1!)).toEqual(['ID', 'NAME']);
    await withRetry(() => db.execute(`alter table ${table} add extra integer default 7`));
    const [r2] = await db.query(sql, [1]);
    expect(Object.keys(r2!)).toEqual(['ID', 'NAME', 'EXTRA']);
  });

  // NOTE: a white-box "stale handle" test is deliberately absent. Executing an
  // unknown statement handle makes the server close the connection outright
  // (verified on FB3/4/5), so the re-prepare retry in session.ts is a safety
  // net for format-change errors (gds 335544343) only. External DDL cannot
  // create that situation either: cached statements hold metadata existence
  // locks, so foreign DDL blocks instead (see README).

  it('insert ... returning yields the row via op_execute2 plus the count', async () => {
    const result = await db.run(`insert into ${table} (id, name) values (?, ?) returning id, name`, [50, 'fifty']);
    expect(result.rows).toEqual([{ ID: 50, NAME: 'fifty' }]);
    expect(result.rowsAffected).toBe(1);
  });

  it('update ... returning works on a cached statement', async () => {
    const sql = `update ${table} set name = ? where id = ? returning name`;
    expect((await db.run(sql, ['A', 50])).rows).toEqual([{ NAME: 'A' }]);
    expect((await db.run(sql, ['B', 50])).rows).toEqual([{ NAME: 'B' }]);
  });

  describe('PreparedStatement API', () => {
    it('prepares once, executes many times at one round trip each', async () => {
      const stmt = await db.prepare(`select name from ${table} where id = ?`);
      try {
        expect(stmt.inputs).toHaveLength(1);
        expect(stmt.outputs.map((o) => o.alias)).toEqual(['NAME']);
        await db.transaction(async (tx) => {
          await stmt.query([1], tx); // first use in this tx
          const before = db.roundTrips;
          const rows = await stmt.query([2], tx);
          expect(rows).toEqual([{ NAME: 'dos' }]);
          expect(db.roundTrips - before).toBe(1);
        });
        // Auto-transaction mode works too.
        expect(await stmt.query([1])).toEqual([{ NAME: 'changed' }]);
      } finally {
        await stmt.close();
      }
    });

    it('rejects use after close', async () => {
      const stmt = await db.prepare(`select 1 from rdb$database`);
      await stmt.close();
      await expect(stmt.query()).rejects.toThrow(/already closed/);
      await stmt.close(); // idempotent
    });

    it('statementCacheSize: 0 disables caching but everything still works', async () => {
      const raw = await connect({ ...FB_BASE, port, statementCacheSize: 0 });
      try {
        const sql = `select name from ${table} where id = ?`;
        await raw.transaction(async (tx) => {
          await tx.query(sql, [1]);
          const before = raw.roundTrips;
          await tx.query(sql, [2]); // no cache: prepare + execute again
          expect(raw.roundTrips - before).toBe(2);
        });
      } finally {
        await raw.disconnect();
      }
    });
  });
});
