import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Attachment } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

/**
 * expandStar: `select *` rewritten server-side so excluded columns are
 * genuinely never fetched. The wire-truth observable: rowMode 'array'
 * IGNORES decode-time exclude — if the column still vanishes, it was
 * removed from the statement itself.
 */
describe.each(FB_SERVERS)('expandStar on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_STAR_${version}`;
  const u = `U_STAR_${version}`;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer not null primary key, name varchar(20), "weird col" varchar(10), big blob)`);
    await ddl(db, `recreate table ${u} (id integer not null primary key, t_id integer, note varchar(20))`);
    await db.execute(`insert into ${t} (id, name, "weird col", big) values (?,?,?,?)`, [1, 'alice', 'w1', Buffer.alloc(4000, 0x41)]);
    await db.execute(`insert into ${u} values (?,?,?)`, [10, 1, 'note-1']);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('truly removes an excluded scalar from the wire (array mode ignores decode exclude)', async () => {
    // Control: without expandStar, array mode returns every column.
    const plain = await db.run(`select * from ${t}`, [], { rowMode: 'array' });
    expect(plain.columns.map((c) => c.name)).toEqual(['ID', 'NAME', 'weird col', 'BIG']);

    const res = await db.run(`select * from ${t}`, [], { rowMode: 'array', exclude: ['NAME', 'BIG'], expandStar: true });
    expect(res.columns.map((c) => c.name)).toEqual(['ID', 'weird col']); // quoted exotic name survives
    expect((res.rows[0] as unknown as unknown[]).length).toBe(2);
    expect((res.rows[0] as unknown as unknown[])[1]).toBe('w1');
  });

  it('expands alias.* per table in a join, with qualified exclude', async () => {
    const res = await db.run(
      `select a.*, b.* from ${t} a join ${u} b on b.t_id = a.id`,
      [],
      { rowMode: 'array', exclude: ['A.BIG', 'B.T_ID'], expandStar: true },
    );
    expect(res.columns.map((c) => `${c.relation}.${c.name}`)).toEqual([
      `${t}.ID`, `${t}.NAME`, `${t}.weird col`, `${u}.ID`, `${u}.NOTE`,
    ]);
  });

  it('handles self-joins: same table, different aliases, one-sided exclude', async () => {
    const res = await db.run(
      `select t1.*, t2.* from ${t} t1 join ${t} t2 on t1.id = t2.id`,
      [],
      { rowMode: 'array', exclude: ['T2.BIG', 'T2.NAME'], expandStar: true },
    );
    expect(res.columns.map((c) => c.name)).toEqual(['ID', 'NAME', 'weird col', 'BIG', 'ID', 'weird col']);
  });

  it('qualified star mixed with expressions; object mode; only filter', async () => {
    // (a BARE * cannot mix with other select items — Firebird rejects that at
    // prepare, so it never reaches the rewriter)
    const [row] = await db.query(`select id * 2 as dbl, x.* from ${t} x`, [], { expandStar: true, only: ['DBL', 'ID', 'NAME'] });
    expect(row).toEqual({ DBL: 2, ID: 1, NAME: 'alice' });
  });

  it('count(*) and star-free selects pass through untouched', async () => {
    const [c] = await db.query(`select count(*) as n from ${t}`, [], { expandStar: true });
    expect(Number((c as any).N)).toBe(1);
    const [r] = await db.query(`select id from ${t}`, [], { expandStar: true, exclude: ['NAME'] });
    expect(r).toEqual({ ID: 1 });
  });

  it('rewrite cache: repeat runs stay correct and cheap', async () => {
    const run = () => db.run(`select * from ${t}`, [], { rowMode: 'array', exclude: ['BIG'], expandStar: true });
    await run();
    const before = db.roundTrips;
    // Rewrite cached + rewritten statement cached: only db.run's own
    // transaction remains (start + execute&fetch + commit = 3 flushes).
    const res = await run();
    expect(db.roundTrips - before).toBeLessThanOrEqual(3);
    expect(res.columns.map((c) => c.name)).toEqual(['ID', 'NAME', 'weird col']);
  });

  it('DDL invalidates the rewrite cache (new column appears)', async () => {
    const q = () => db.run(`select * from ${t}`, [], { rowMode: 'array', exclude: ['BIG'], expandStar: true });
    await q(); // populate rewrite cache
    await ddl(db, `alter table ${t} add extra integer`);
    const res = await q();
    expect(res.columns.map((c) => c.name)).toEqual(['ID', 'NAME', 'weird col', 'EXTRA']);
    await ddl(db, `alter table ${t} drop extra`);
  });

  it('works with queryStream', async () => {
    await db.transaction(async (tx) => {
      const names: string[][] = [];
      for await (const row of tx.queryStream(`select * from ${t}`, [], { expandStar: true, exclude: ['BIG'] })) {
        names.push(Object.keys(row));
      }
      expect(names[0]).toEqual(['ID', 'NAME', 'weird col']);
    });
  });

  it('rejects excluding every column with a clear error', async () => {
    await expect(
      db.query(`select * from ${t}`, [], { expandStar: true, exclude: ['ID', 'NAME', 'weird col', 'BIG', 'EXTRA'] }),
    ).rejects.toThrow(/nothing left/);
  });
});
