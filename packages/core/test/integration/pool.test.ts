import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createPool, type Pool } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, nextDatabasePath, dropDatabaseAt } from './env.js';

const fb5 = FB_SERVERS.find((s) => s.version === 5)!;

describe('connection pool (Firebird 5)', () => {
  let pool: Pool;
  let dbPath: string;
  beforeAll(async () => {
    // Isolated database so the pool's DDL never contends with other suites.
    dbPath = nextDatabasePath(fb5.port);
    const seed = await createDatabase({ ...FB_BASE, port: fb5.port, database: dbPath });
    await seed.execute('create table t_pool (id integer primary key, v varchar(20))');
    await seed.disconnect();
    pool = await createPool({ ...FB_BASE, port: fb5.port, database: dbPath, min: 1, max: 3, idleTimeoutMs: 500 });
  }, HOOK_TIMEOUT);
  afterAll(async () => {
    await pool.close();
    await dropDatabaseAt(fb5.port, dbPath);
  });

  it('runs queries via the pool convenience methods', async () => {
    const rows = await pool.query('select 1 as v from rdb$database');
    expect(rows).toEqual([{ V: 1 }]);
  });

  it('warmup created the minimum connections', () => {
    const s = pool.stats();
    expect(s.total).toBeGreaterThanOrEqual(1);
  });

  it('reuses connections (total stays within max under sequential load)', async () => {
    for (let i = 0; i < 20; i++) {
      await pool.execute('update or insert into t_pool (id, v) values (?, ?) matching (id)', [i % 3, `v${i}`]);
    }
    expect(pool.stats().total).toBeLessThanOrEqual(3);
  });

  it('serves concurrent borrowers without exceeding max simultaneously', async () => {
    let concurrent = 0;
    let peak = 0;
    const tasks = Array.from({ length: 12 }, () =>
      pool.use(async (c) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await c.query('select 1 from rdb$database');
        concurrent--;
      }),
    );
    await Promise.all(tasks);
    // The ceiling of 3 was never exceeded at any instant.
    expect(peak).toBeGreaterThan(1); // genuinely ran in parallel
    expect(peak).toBeLessThanOrEqual(3);
    expect(pool.stats().inUse).toBe(0);
  });

  it('acquire/release exposes the same warm statement cache per connection', async () => {
    const c = await pool.acquire();
    try {
      await c.query('select 2 as v from rdb$database');
      const before = c.roundTrips;
      await c.transaction(async (tx) => {
        await tx.query('select 2 as v from rdb$database'); // cold in this tx
        const mid = c.roundTrips;
        await tx.query('select 2 as v from rdb$database'); // warm → 1 RT
        expect(c.roundTrips - mid).toBe(1);
      });
      expect(c.roundTrips).toBeGreaterThan(before);
    } finally {
      pool.release(c);
    }
  });

  it('times out when the pool is exhausted and nothing releases', async () => {
    const small = await createPool({ ...FB_BASE, port: fb5.port, max: 1, acquireTimeoutMs: 300 });
    const held = await small.acquire();
    try {
      await expect(small.acquire()).rejects.toThrow(/Timed out acquiring/);
    } finally {
      small.release(held);
      await small.close();
    }
  });

  it('evicts idle connections down to min', async () => {
    const p = await createPool({ ...FB_BASE, port: fb5.port, min: 1, max: 4, idleTimeoutMs: 300 });
    try {
      // Fan out to open several physical connections.
      await Promise.all(Array.from({ length: 4 }, () => p.use((c) => c.query('select 1 from rdb$database'))));
      expect(p.stats().total).toBeGreaterThan(1);
      await new Promise((r) => setTimeout(r, 1200)); // let the sweeper run
      expect(p.stats().total).toBeLessThanOrEqual(1);
    } finally {
      await p.close();
    }
  });

  it('replaces a dead connection on acquire (validation)', async () => {
    const p = await createPool({ ...FB_BASE, port: fb5.port, max: 2 });
    try {
      const c = await p.acquire();
      // Kill the socket underneath the pool, then release it back.
      c.wire.transport.close();
      expect(c.isAlive).toBe(false);
      p.release(c); // unhealthy → discarded
      // Next acquire must yield a working connection.
      const rows = await p.query('select 7 as v from rdb$database');
      expect(rows).toEqual([{ V: 7 }]);
    } finally {
      await p.close();
    }
  });

  it('map runs work across connections in order with bounded concurrency', async () => {
    let concurrent = 0;
    let peak = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = await pool.map(
      items,
      async (conn, n) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        const [r] = await conn.query('select cast(? as integer) * 10 as v from rdb$database', [n]);
        await new Promise((res) => setTimeout(res, 20));
        concurrent--;
        return r!.V as number;
      },
      { concurrency: 3 },
    );
    expect(out).toEqual(items.map((n) => n * 10)); // in input order
    expect(peak).toBeGreaterThan(1); // genuinely parallel
    expect(peak).toBeLessThanOrEqual(3); // respected concurrency cap
  });

  it('rejects use after close', async () => {
    const p = await createPool({ ...FB_BASE, port: fb5.port });
    await p.close();
    await expect(p.acquire()).rejects.toThrow(/closed/);
  });

  it('clearStatementCaches releases metadata pins so DDL can recreate a table', async () => {
    await pool.use((c) => c.execute('recreate table t_ddl_pin (id integer primary key, v varchar(10))'));
    // Warm the statement cache on TWO different connections — each cached
    // prepared statement pins t_ddl_pin's metadata server-side.
    const a = await pool.acquire();
    const b = await pool.acquire();
    try {
      await a.query('select v from t_ddl_pin where id = ?', [1]);
      await b.query('select v from t_ddl_pin where id = ?', [1]);
    } finally {
      pool.release(a);
      pool.release(b);
    }
    // Without eviction the recreate hits "object ... is in use" on nowait.
    await expect(
      pool.use((c) => c.transaction((tx) => tx.execute('recreate table t_ddl_pin (id integer primary key)'), { wait: false })),
    ).rejects.toThrow(/in use|lock conflict/i);

    await pool.clearStatementCaches();
    // wait (not nowait): right after the failed commit's rollback the server
    // can still hold the metadata lock for a beat while it cleans up.
    await pool.use((c) =>
      c.transaction((tx) => tx.execute('recreate table t_ddl_pin (id integer primary key)'), { wait: 10 }),
    );
    const rows = await pool.query('select count(*) as n from t_ddl_pin');
    expect(rows[0]!.N).toBe(0);
  });

  it('a refused commit leaves the transaction rollback-able (no server-side leak)', async () => {
    await pool.use((c) => c.execute('recreate table t_commit_fail (id integer primary key)'));
    // Pin the table from another connection so the DDL commit is refused
    // (Firebird takes DDL metadata locks at COMMIT time, not execute time).
    const pinner = await pool.acquire();
    try {
      await pinner.query('select id from t_commit_fail where id = ?', [1]);
      await pool.use(async (c) => {
        const tx = await c.startTransaction({ wait: false });
        await tx.execute('recreate table t_commit_fail (id integer primary key, v varchar(5))');
        await expect(tx.commit()).rejects.toThrow(/in use|lock conflict/i);
        // The failed commit must NOT mark the tx finished — the server tx is
        // still alive and has to be rolled back or it blocks all later DDL.
        expect(tx.isFinished).toBe(false);
        await tx.rollback();
        expect(tx.isFinished).toBe(true);
      });
    } finally {
      pool.release(pinner);
    }
    // With the leak rolled back (and pins cleared), DDL works again.
    await pool.clearStatementCaches();
    await pool.use((c) =>
      c.transaction((tx) => tx.execute('recreate table t_commit_fail (id integer primary key, v varchar(5))'), { wait: 10 }),
    );
  });
});
