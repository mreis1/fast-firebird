import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Attachment } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

// DECFLOAT/INT128 exist since Firebird 4.
const SERVERS = FB_SERVERS.filter((s) => s.version >= 4);

describe.each(SERVERS)('DECFLOAT/INT128 write path on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const table = `T_DECW_${version}`;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${table} (id integer not null primary key, d34 decfloat(34), d16 decfloat(16), big int128)`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('binds a JS number to DECFLOAT exactly (no double-rounding noise)', async () => {
    await db.execute(`insert into ${table} (id, d34, d16) values (?, ?, ?)`, [1, 0.1, 0.1]);
    const [r] = await db.query(`select d34, d16 from ${table} where id = 1`);
    expect(r!.D34).toBe('0.1'); // a lossy double would read back 0.1000000000000000055511151231257827
    expect(r!.D16).toBe('0.1');
  });

  it('binds a 34-digit decimal string exactly', async () => {
    const v = '0.3333333333333333333333333333333333';
    await db.execute(`insert into ${table} (id, d34) values (?, ?)`, [2, v]);
    const [r] = await db.query(`select d34 from ${table} where id = 2`);
    expect(r!.D34).toBe(v);
  });

  it('binds INT128 from bigint and from an integer string', async () => {
    const max = 170141183460469231731687303715884105727n;
    await db.execute(`insert into ${table} (id, big) values (?, ?)`, [3, max]);
    await db.execute(`insert into ${table} (id, big) values (?, ?)`, [4, '-170141183460469231731687303715884105728']);
    const rows = await db.query(`select id, big from ${table} where id in (3, 4) order by id`);
    expect(rows[0]!.BIG).toBe(max);
    expect(rows[1]!.BIG).toBe(-170141183460469231731687303715884105728n);
  });

  it('binds negative and exponent-form decimals', async () => {
    await db.execute(`insert into ${table} (id, d34) values (?, ?)`, [5, '-0.000001']);
    await db.execute(`insert into ${table} (id, d34) values (?, ?)`, [6, '1E10']);
    const rows = await db.query(`select id, d34 from ${table} where id in (5, 6) order by id`);
    expect(rows[0]!.D34).toBe('-0.000001');
    expect(rows[1]!.D34).toBe('10000000000');
  });
});

describe.each(SERVERS)('DECFLOAT special values (Inf/NaN) on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const table = `T_DECS_${version}`;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${table} (id integer not null primary key, d34 decfloat(34), d16 decfloat(16))`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('decodes server-side Infinity/-Infinity/NaN literals', async () => {
    const [r] = await db.query(
      `select cast('Infinity' as decfloat(34)) as pos,
              cast('-Infinity' as decfloat(34)) as neg,
              cast('NaN' as decfloat(34)) as nn,
              cast('Infinity' as decfloat(16)) as pos16
         from rdb$database`,
    );
    expect(r!.POS).toBe('Infinity');
    expect(r!.NEG).toBe('-Infinity');
    expect(r!.NN).toBe('NaN');
    expect(r!.POS16).toBe('Infinity');
  });

  it('round-trips special values as string params through a table', async () => {
    await db.execute(`insert into ${table} (id, d34, d16) values (?, ?, ?)`, [1, 'Infinity', '-Infinity']);
    await db.execute(`insert into ${table} (id, d34, d16) values (?, ?, ?)`, [2, 'NaN', 'NaN']);
    const rows = await db.query(`select d34, d16 from ${table} order by id`);
    expect(rows).toEqual([
      { D34: 'Infinity', D16: '-Infinity' },
      { D34: 'NaN', D16: 'NaN' },
    ]);
  });

  it('binds JS Infinity/NaN numbers to DECFLOAT columns', async () => {
    await db.execute(`insert into ${table} (id, d34, d16) values (?, ?, ?)`, [3, Infinity, -Infinity]);
    await db.execute(`insert into ${table} (id, d34) values (?, ?)`, [4, NaN]);
    const rows = await db.query(`select d34, d16 from ${table} where id in (3, 4) order by id`);
    expect(rows).toEqual([
      { D34: 'Infinity', D16: '-Infinity' },
      { D34: 'NaN', D16: null },
    ]);
  });

  it('specials sort in Firebird total order (…< +Inf < NaN) — encodings are canonical', async () => {
    // Equality comparisons on NaN would raise Firebird's DECFLOAT trap; the
    // ORDER BY total order is trap-free and proves the server accepted our
    // canonical special encodings. Rows: 1=Inf, 2=NaN, 3=Inf, 4=NaN.
    const rows = await db.query(`select id from ${table} order by d34, id`);
    expect(rows.map((r) => r.ID)).toEqual([1, 3, 2, 4]);
  });
});
