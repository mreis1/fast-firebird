import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

// Regression: a string parameter bound to a non-text column (NUMERIC, INT, …)
// used to route through a charset codec derived from `subType`, which for
// numeric types is the numeric subtype — misread as a charset it selected
// OCTETS, whose encode() threw. Worse, that throw happened AFTER the op_execute
// header was written, so the failed encode desynced the wire and deadlocked the
// connection. Both are fixed: strings coerce to the column type, and an encode
// error surfaces cleanly while the connection stays usable.
describe.each(FB_SERVERS)('parameter coercion on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const table = `T_COERCE_${version}`;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(
      db,
      `recreate table ${table} (
        id integer not null primary key,
        price numeric(9,2),
        big bigint,
        ratio double precision,
        note varchar(20)
      )`,
    );
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('coerces string parameters into numeric/int/double columns', async () => {
    const affected = await db.execute(`insert into ${table} (id, price, big, ratio, note) values (?, ?, ?, ?, ?)`, [
      1,
      '1234.56',
      '9007199254740993',
      '3.5',
      'hello',
    ]);
    expect(affected).toBe(1);

    const rows = await db.query(`select price, big, ratio, note from ${table} where id = ?`, [1]);
    const r = rows[0]!;
    expect(Number(r.PRICE)).toBe(1234.56);
    expect(r.BIG).toBe(9007199254740993n);
    expect(r.RATIO).toBe(3.5);
    expect(r.NOTE).toBe('hello');
  });

  it('coerces a string via CAST to NUMERIC without hanging', async () => {
    const rows = await db.query('select cast(? as numeric(9,2)) as x from rdb$database', ['12.50']);
    expect(Number(rows[0]!.X)).toBe(12.5);
  });

  it('surfaces an oversized-parameter error cleanly and keeps the connection alive', async () => {
    const huge = 'x'.repeat(70000);
    await expect(db.query('select cast(? as varchar(10)) as x from rdb$database', [huge])).rejects.toThrow(
      /longer than 65535 bytes/,
    );
    // The failed encode must not have desynced the wire.
    const rows = await db.query('select 42 as n from rdb$database');
    expect(rows).toEqual([{ N: 42 }]);
  });
});
