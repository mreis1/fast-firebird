import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from '../../src/index.js';
import { FB_BASE, FB_SERVERS } from './env.js';

const fb5 = FB_SERVERS.find((s) => s.version === 5)!;

describe('connection pool (Firebird 5)', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = await createPool({ ...FB_BASE, port: fb5.port, min: 1, max: 3, idleTimeoutMs: 500 });
    await pool.use((c) => c.execute('recreate table t_pool (id integer primary key, v varchar(20))'));
  });
  afterAll(async () => {
    await pool.close();
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

  it('rejects use after close', async () => {
    const p = await createPool({ ...FB_BASE, port: fb5.port });
    await p.close();
    await expect(p.acquire()).rejects.toThrow(/closed/);
  });
});
