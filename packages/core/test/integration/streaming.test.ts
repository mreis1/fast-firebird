import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl } from './env.js';

describe.each(FB_SERVERS)('streaming on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const table = `T_STREAM_${version}`;

  beforeAll(async () => {
    db = await connect({ ...FB_BASE, port });
    await ddl(db, `recreate table ${table} (id integer primary key, note blob sub_type text)`);
    await db.transaction(async (tx) => {
      for (let i = 1; i <= 2500; i++) {
        await tx.execute(`insert into ${table} (id, note) values (?, ?)`, [i, `note #${i} — ção €`]);
      }
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.disconnect();
  });

  it('async-iterates every row of a large set', async () => {
    let count = 0;
    let last = 0;
    for await (const row of db.queryStream(`select id from ${table} order by id`)) {
      count++;
      last = row.ID as number;
    }
    expect(count).toBe(2500);
    expect(last).toBe(2500);
  });

  it('fetches lazily — an early break stops after few round trips', async () => {
    const before = db.roundTrips;
    const collected: number[] = [];
    for await (const row of db.queryStream(`select id from ${table} order by id`)) {
      collected.push(row.ID as number);
      if (collected.length === 15) break; // abandon the rest
    }
    const rts = db.roundTrips - before;
    expect(collected).toHaveLength(15);
    expect(collected[0]).toBe(1);
    // Only the first adaptive batch(es) were fetched + a deferred close —
    // nowhere near the ~2500 rows that exist.
    expect(rts).toBeLessThan(8);
  });

  it('materializes blobs while streaming', async () => {
    let seen = 0;
    for await (const row of db.queryStream(`select id, note from ${table} where id <= 5 order by id`)) {
      expect(row.NOTE).toBe(`note #${row.ID} — ção €`);
      seen++;
    }
    expect(seen).toBe(5);
  });

  it('streams within an explicit transaction (no auto-commit)', async () => {
    await db.transaction(async (tx) => {
      const ids: number[] = [];
      for await (const row of tx.queryStream(`select id from ${table} where id <= 3 order by id`)) {
        ids.push(row.ID as number);
      }
      expect(ids).toEqual([1, 2, 3]);
      // Transaction still usable afterwards.
      const [r] = await tx.query(`select count(*) as c from ${table}`);
      expect(Number(r!.C)).toBe(2500);
    });
  });

  it('propagates SQL errors from the stream', async () => {
    const iterate = async () => {
      for await (const _row of db.queryStream('select * from no_such_table_stream')) void _row;
    };
    await expect(iterate()).rejects.toThrow(/Table unknown|Dynamic SQL Error/i);
  });

  it('subsequent queries work after a stream (connection left clean)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _row of db.queryStream(`select id from ${table} where id <= 100`)) break;
    const [r] = await db.query('select 42 as v from rdb$database');
    expect(r!.V).toBe(42);
  });

  it('works with Node Readable.from (object mode)', async () => {
    const stream = Readable.from(db.queryStream(`select id from ${table} where id <= 10 order by id`));
    const ids: number[] = [];
    for await (const row of stream) ids.push((row as { ID: number }).ID);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
