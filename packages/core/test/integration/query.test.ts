import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, withRetry } from './env.js';

describe.each(FB_SERVERS)('queries on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const table = `T_QUERY_${version}`;

  beforeAll(async () => {
    db = await connect({ ...FB_BASE, port });
    await withRetry(() =>
      db.execute(`recreate table ${table} (
      id integer not null primary key,
      name varchar(60),
      fixed char(10),
      qty bigint,
      price numeric(9,2),
      ratio double precision,
      flag boolean,
      born date,
      wake time,
      created timestamp,
      notes blob sub_type text,
      payload blob
    )`),
    );
  });

  afterAll(async () => {
    await db?.disconnect();
  });

  it('selects simple expressions', async () => {
    const rows = await db.query('select 1 as a, cast(2 as bigint) as b from rdb$database');
    expect(rows).toEqual([{ A: 1, B: 2 }]);
  });

  it('inserts with parameters and reads every type back', async () => {
    const created = new Date(2024, 5, 15, 12, 34, 56, 789);
    const born = new Date(1985, 2, 3);
    const notes = 'blob text with unicode: ação é € — ok';
    const payload = Buffer.from([0, 1, 2, 250, 251, 252]);

    const affected = await db.execute(
      `insert into ${table} (id, name, fixed, qty, price, ratio, flag, born, wake, created, notes, payload)
       values (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [1, 'Alice é €', 'FIX', 9007199254740991n, 1234.56, 0.5, true, born, created, created, notes, payload],
    );
    expect(affected).toBe(1);

    const rows = await db.query(`select * from ${table} where id = ?`, [1]);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.ID).toBe(1);
    expect(r.NAME).toBe('Alice é €');
    expect(r.FIXED).toBe('FIX');
    expect(r.QTY).toBe(9007199254740991);
    expect(r.PRICE).toBe(1234.56);
    expect(r.RATIO).toBe(0.5);
    expect(r.FLAG).toBe(true);
    expect((r.BORN as Date).getFullYear()).toBe(1985);
    expect((r.BORN as Date).getMonth()).toBe(2);
    expect((r.CREATED as Date).toISOString()).toBe(created.toISOString());
    const wake = r.WAKE as Date;
    expect([wake.getHours(), wake.getMinutes(), wake.getSeconds(), wake.getMilliseconds()]).toEqual([12, 34, 56, 789]);
    expect(r.NOTES).toBe(notes);
    expect(Buffer.isBuffer(r.PAYLOAD)).toBe(true);
    expect(Buffer.compare(r.PAYLOAD as Buffer, payload)).toBe(0);
  });

  it('handles NULLs in params and results', async () => {
    await db.execute(`insert into ${table} (id, name, qty) values (?,?,?)`, [2, null, null]);
    const [r] = await db.query(`select name, qty, price from ${table} where id = 2`);
    expect(r).toEqual({ NAME: null, QTY: null, PRICE: null });
  });

  it('roundtrips negative scaled numerics', async () => {
    await db.execute(`insert into ${table} (id, price) values (?,?)`, [3, -0.01]);
    const [r] = await db.query(`select price from ${table} where id = 3`);
    expect(r!.PRICE).toBe(-0.01);
  });

  it('supports transactions with rollback', async () => {
    const tx = await db.startTransaction();
    await tx.execute(`insert into ${table} (id, name) values (?,?)`, [100, 'ghost']);
    await tx.rollback();
    const rows = await db.query(`select id from ${table} where id = 100`);
    expect(rows).toHaveLength(0);
  });

  it('transaction() commits on success and rolls back on error', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(`insert into ${table} (id, name) values (?,?)`, [101, 'kept']);
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(`insert into ${table} (id, name) values (?,?)`, [102, 'doomed']);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await db.query(`select id from ${table} where id in (101, 102) order by id`);
    expect(rows).toEqual([{ ID: 101 }]);
  });

  it('update/delete report affected rows', async () => {
    expect(await db.execute(`update ${table} set name = 'renamed' where id in (1,2)`)).toBe(2);
    expect(await db.execute(`delete from ${table} where id = 3`)).toBe(1);
  });

  it('fetches multi-batch result sets (5000 rows)', async () => {
    // (cross join instead of a recursive CTE — recursion depth is capped at 1024)
    const rows = await db.query(
      `select first 5000 cast(row_number() over() as integer) as i from rdb$types a, rdb$types b`,
    );
    expect(rows).toHaveLength(5000);
    expect(rows[4999]!.I).toBe(5000);
  });

  it('reports SQL errors with real messages and SQLSTATE', async () => {
    const err = await db.query('select * from no_such_table').catch((e) => e);
    expect(String(err.message)).toMatch(/Table unknown|Dynamic SQL Error/i);
    expect(err.sqlState).toBeTruthy();
  });

  it('executes stored procedures via execute procedure (op_execute2)', async () => {
    await withRetry(() =>
      db.execute(`recreate procedure sp_double_${version} (x integer) returns (y integer) as
      begin y = x * 2; end`),
    );
    const rows = await db.query(`execute procedure sp_double_${version}(21)`);
    expect(rows).toEqual([{ Y: 42 }]);
  });

  it('honors lowercaseKeys', async () => {
    const db2 = await connect({ ...FB_BASE, port, lowercaseKeys: true });
    try {
      const rows = await db2.query('select 1 as answer from rdb$database');
      expect(rows).toEqual([{ answer: 1 }]);
    } finally {
      await db2.disconnect();
    }
  });
});
