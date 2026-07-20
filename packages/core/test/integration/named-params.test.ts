import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FirebirdParamError, type Attachment } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

// Named parameters (@name) are rewritten client-side to positional ? markers
// and the values reordered to match. These tests drive the full wire path
// (one-shot query/execute, streaming, and prepared statements) on every real
// server to prove the rewrite lands correct values in the right slots.
describe.each(FB_SERVERS)('named parameters on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const table = `T_NAMED_${version}`;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(
      db,
      `recreate table ${table} (
        id integer not null primary key,
        dept integer,
        sal numeric(9,2),
        name varchar(30)
      )`,
    );
    await db.execute(`insert into ${table} (id, dept, sal, name) values (@id, @dept, @sal, @name)`, {
      id: 1,
      dept: 10,
      sal: '2500.00',
      name: 'Ann',
    });
    await db.execute(`insert into ${table} (id, dept, sal, name) values (@id, @dept, @sal, @name)`, {
      id: 2,
      dept: 10,
      sal: '4000.00',
      name: 'Bob',
    });
    await db.execute(`insert into ${table} (id, dept, sal, name) values (@id, @dept, @sal, @name)`, {
      id: 3,
      dept: 20,
      sal: '9000.00',
      name: 'Cy',
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('binds a named object in query()', async () => {
    const rows = await db.query(`select name from ${table} where dept = @dept and sal > @min order by id`, {
      dept: 10,
      min: '3000',
    });
    expect(rows.map((r) => r.NAME)).toEqual(['Bob']);
  });

  it('reorders values regardless of object key order', async () => {
    // @min appears before @dept in the object, after in the SQL.
    const rows = await db.query(`select id from ${table} where sal > @min and dept = @dept order by id`, {
      min: '1000',
      dept: 10,
    });
    expect(rows.map((r) => r.ID)).toEqual([1, 2]);
  });

  it('binds a repeated name to the same value in every slot', async () => {
    const rows = await db.query(`select id from ${table} where dept = @d or sal < @d order by id`, { d: 10 });
    // dept = 10 matches ids 1,2; sal < 10 matches none.
    expect(rows.map((r) => r.ID)).toEqual([1, 2]);
  });

  it('still accepts a positional array (unchanged behavior)', async () => {
    const rows = await db.query(`select name from ${table} where id = ?`, [3]);
    expect(rows[0]!.NAME).toBe('Cy');
  });

  it('binds named params in queryStream()', async () => {
    const ids: number[] = [];
    for await (const row of db.queryStream(`select id from ${table} where dept = @dept order by id`, { dept: 10 })) {
      ids.push(row.ID as number);
    }
    expect(ids).toEqual([1, 2]);
  });

  it('binds named params in a prepared statement, re-run with different objects', async () => {
    const stmt = await db.prepare(`select name from ${table} where dept = @dept and sal >= @floor order by id`);
    try {
      const a = await stmt.query({ dept: 10, floor: '2000' });
      expect(a.map((r) => r.NAME)).toEqual(['Ann', 'Bob']);
      const b = await stmt.query({ dept: 10, floor: '3000' });
      expect(b.map((r) => r.NAME)).toEqual(['Bob']);
    } finally {
      await stmt.close();
    }
  });

  it('binds named params inside an explicit transaction', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(`update ${table} set name = @name where id = @id`, { name: 'Ann2', id: 1 });
      const rows = await tx.query(`select name from ${table} where id = @id`, { id: 1 });
      expect(rows[0]!.NAME).toBe('Ann2');
    });
  });

  it('throws a FirebirdParamError when a referenced name is missing', async () => {
    await expect(
      db.query(`select id from ${table} where dept = @dept and sal > @min`, { dept: 10 }),
    ).rejects.toBeInstanceOf(FirebirdParamError);
  });

  it('throws when a named object is passed but the SQL has only ? markers', async () => {
    await expect(db.query(`select id from ${table} where id = ?`, { id: 1 })).rejects.toBeInstanceOf(
      FirebirdParamError,
    );
  });
});

// A '@name' inside a string literal must reach the server verbatim, not be
// treated as a parameter — verified end-to-end on the default (first) server.
describe('named-parameter literal safety', () => {
  it('does not rewrite @name inside a string literal', async () => {
    const db = await freshDb(FB_SERVERS[0]!.port);
    try {
      const rows = await db.query(`select cast('user@host' as varchar(20)) as email from rdb$database where 1 = @one`, {
        one: 1,
      });
      expect(rows[0]!.EMAIL).toBe('user@host');
    } finally {
      await db.dropDatabase();
    }
  });
});
