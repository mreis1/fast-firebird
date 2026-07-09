import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS } from './env.js';

describe.each(FB_SERVERS)('adaptive fetch on Firebird $version', ({ port }) => {
  let db: Attachment;
  beforeAll(async () => {
    db = await connect({ ...FB_BASE, port });
  });
  afterAll(async () => {
    await db?.disconnect();
  });

  it('returns every row of a large narrow scan and ramps batches (fewer RTs than fixed-40)', async () => {
    const N = 6000;
    const sql = `select first ${N} cast(row_number() over() as integer) i from rdb$types a, rdb$types b`;
    await db.transaction(async (tx) => {
      const before = db.roundTrips;
      const rows = await tx.query(sql);
      const rts = db.roundTrips - before;
      expect(rows).toHaveLength(N);
      expect(rows[N - 1]!.I).toBe(N);
      // Ramp 40,80,160,320,400,400… covers 6000 rows in ~18 fetches;
      // a fixed batch of 40 would need 150. Assert we did far better.
      expect(rts).toBeLessThan(30);
    });
  });

  it('a tiny result set does not over-fetch', async () => {
    await db.transaction(async (tx) => {
      const before = db.roundTrips;
      const rows = await tx.query('select 1 as v from rdb$database');
      expect(rows).toEqual([{ V: 1 }]);
      // Single coalesced execute+fetch, cursor closes deferred → 1 RT warm.
      expect(db.roundTrips - before).toBeLessThanOrEqual(2);
    });
  });

  it('honors a small explicit fetchSize', async () => {
    const small = await connect({ ...FB_BASE, port, fetchSize: 5 });
    try {
      const rows = await small.query(
        'select first 23 cast(row_number() over() as integer) i from rdb$types a, rdb$types b',
      );
      expect(rows).toHaveLength(23);
    } finally {
      await small.disconnect();
    }
  });

  it('wide rows round-trip correctly under the byte-budget cap', async () => {
    const rows = await db.query(
      `select first 50 cast(lpad('', 4000, 'x') as varchar(4000)) as wide,
              cast(row_number() over() as integer) as n
       from rdb$types a, rdb$types b`,
    );
    expect(rows).toHaveLength(50);
    expect((rows[0]!.WIDE as string).length).toBe(4000);
    expect(rows[49]!.N).toBe(50);
  });
});
