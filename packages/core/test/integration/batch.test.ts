import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FirebirdBatchError,
  FirebirdParamError,
  ZonedDate,
  type Attachment,
  type BatchRow,
} from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

const MODERN = FB_SERVERS.filter((s) => s.version >= 4);
const LEGACY = FB_SERVERS.filter((s) => s.version === 3);

// The wire batch API (op_batch_create/msg/exec, protocol ≥ 16) sends many DML
// rows per round trip. These tests exercise the full stack on real FB4/5/6
// servers: fixed-format encoding for every type family, completion-state
// parsing (per-row counts + status vectors), chunked multi-cycle execution,
// blob registration, and the round-trip budget that is the feature's point.
describe.each(MODERN)('executeBatch on Firebird $version', ({ port, version }) => {
  let db: Attachment;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(
      db,
      `recreate table t_bulk (
        id integer not null primary key,
        name varchar(20),
        amount numeric(9,2)
      )`,
    );
    await ddl(
      db,
      `recreate table t_types (
        id integer not null primary key,
        si smallint, bi bigint, n92 numeric(9,2), n184 numeric(18,4),
        f float, d double precision,
        dt date, tm time, ts timestamp, tstz timestamp with time zone,
        ok boolean, ch char(10), vc varchar(40),
        i128 int128, df16 decfloat(16), df34 decfloat(34)
      )`,
    );
    await ddl(
      db,
      `recreate table t_blob (
        id integer not null primary key,
        data blob sub_type 0,
        memo blob sub_type text
      )`,
    );
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('inserts 1000 rows in bulk with per-row counts', async () => {
    const rows: BatchRow[] = Array.from({ length: 1000 }, (_, i) => [i, `name ${i}`, `${i}.25`]);
    const r = await db.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?)', rows);
    expect(r.rowCount).toBe(1000);
    expect(r.rowsAffected).toBe(1000);
    expect(r.errors).toEqual([]);
    expect(r.updateCounts).toHaveLength(1000);
    expect(r.updateCounts.every((c) => c === 1)).toBe(true);

    const check = await db.queryOne('select count(*) as n, sum(amount) as s from t_bulk');
    expect(check!.N).toBe(1000);
    // Σ (i + 0.25) for i in 0..999 = 499500 + 250
    expect(check!.S).toBe(499750);
    await db.execute('delete from t_bulk', []);
  });

  it('spends one data round trip for a cached bulk insert (plus tx start/commit)', async () => {
    const sql = 'insert into t_bulk (id, name, amount) values (?, ?, ?)';
    const mk = (base: number): BatchRow[] => Array.from({ length: 300 }, (_, i) => [base + i, `n${i}`, '1.00']);
    await db.executeBatch(sql, mk(10_000)); // prime the statement cache
    const before = db.roundTrips;
    const r = await db.executeBatch(sql, mk(20_000));
    const delta = db.roundTrips - before;
    expect(r.rowsAffected).toBe(300);
    // start tx + (create+msg+exec in ONE flush) + commit = 3 round trips for
    // 300 rows. The row-per-statement alternative costs 300+.
    expect(delta).toBeLessThanOrEqual(3);
    await db.execute('delete from t_bulk', []);
  });

  it('binds named-parameter object rows', async () => {
    const r = await db.executeBatch('insert into t_bulk (id, name, amount) values (@id, @name, @amount)', [
      { id: 1, name: 'Ann', amount: '10.50' },
      { amount: '20.00', id: 2, name: 'Bob' }, // key order irrelevant
    ]);
    expect(r.rowsAffected).toBe(2);
    const rows = await db.query('select id, name, amount from t_bulk order by id');
    expect(rows).toEqual([
      { ID: 1, NAME: 'Ann', AMOUNT: 10.5 },
      { ID: 2, NAME: 'Bob', AMOUNT: 20 },
    ]);
    await db.execute('delete from t_bulk', []);
  });

  it('round-trips every type family through the fixed batch format', async () => {
    const dt = new Date(2024, 4, 15); // local date
    const tm = new Date(1970, 0, 1, 13, 45, 30, 250);
    const ts = new Date(2024, 4, 15, 13, 45, 30, 250);
    const instant = new Date('2024-05-15T16:45:30.250Z');
    await db.executeBatch(
      `insert into t_types (id, si, bi, n92, n184, f, d, dt, tm, ts, tstz, ok, ch, vc, i128, df16, df34)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        [
          1,
          -5,
          9007199254740993n, // beyond 2^53 — must survive as a bigint
          '12.5', // exact decimal string → scaled int
          123456.7891,
          1.5,
          1.25,
          dt,
          tm,
          ts,
          new ZonedDate(instant, 'America/Sao_Paulo'),
          true,
          'abc',
          'héllo €uro',
          123456789012345678901234567890n,
          '1.5',
          '-42.5',
        ],
      ],
    );
    const row = (await db.queryOne('select * from t_types where id = 1'))!;
    expect(row.SI).toBe(-5);
    expect(row.BI).toBe(9007199254740993n);
    expect(row.N92).toBe(12.5);
    expect(row.N184).toBeCloseTo(123456.7891, 6);
    expect(row.F).toBe(1.5);
    expect(row.D).toBe(1.25);
    expect((row.DT as Date).getFullYear()).toBe(2024);
    expect((row.DT as Date).getMonth()).toBe(4);
    expect((row.DT as Date).getDate()).toBe(15);
    const gotTm = row.TM as Date;
    expect([gotTm.getHours(), gotTm.getMinutes(), gotTm.getSeconds(), gotTm.getMilliseconds()]).toEqual([13, 45, 30, 250]);
    expect((row.TS as Date).getTime()).toBe(ts.getTime());
    expect((row.TSTZ as Date).getTime()).toBe(instant.getTime());
    expect(row.OK).toBe(true);
    expect(row.CH).toBe('abc');
    expect(row.VC).toBe('héllo €uro');
    expect(row.I128).toBe(123456789012345678901234567890n);
    expect(row.DF16).toBe('1.5');
    expect(row.DF34).toBe('-42.5');
  });

  it('handles NULL values via the bitmap', async () => {
    await db.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?)', [
      [50, null, undefined],
      [51, 'x', null],
    ]);
    const rows = await db.query('select id, name, amount from t_bulk order by id');
    expect(rows).toEqual([
      { ID: 50, NAME: null, AMOUNT: null },
      { ID: 51, NAME: 'x', AMOUNT: null },
    ]);
    await db.execute('delete from t_bulk', []);
  });

  it('throws FirebirdBatchError with the failing row index (default mode)', async () => {
    await expect(
      db.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?)', [
        [60, 'a', '1.00'],
        [60, 'dup', '2.00'], // PK violation at index 1
        [61, 'c', '3.00'],
      ]),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(FirebirdBatchError);
      const be = err as FirebirdBatchError;
      expect(be.index).toBe(1);
      expect(be.message).toMatch(/batch row 1 failed/);
      expect(be.result.errors[0]!.error?.message).toMatch(/violation|unique|PRIMARY/i);
      return true;
    });
    // Own transaction rolled back — nothing committed.
    expect((await db.queryOne('select count(*) as n from t_bulk'))!.N).toBe(0);
  });

  it('continueOnError reports failed rows and keeps the rest', async () => {
    const r = await db.executeBatch(
      'insert into t_bulk (id, name, amount) values (?, ?, ?)',
      [
        [70, 'a', '1.00'],
        [70, 'dup', '2.00'],
        [71, 'c', '3.00'],
        [71, 'dup2', '4.00'],
        [72, 'e', '5.00'],
      ],
      { continueOnError: true },
    );
    expect(r.rowCount).toBe(5);
    expect(r.rowsAffected).toBe(3);
    expect(r.errors.map((e) => e.index)).toEqual([1, 3]);
    expect(r.errors[0]!.error?.message).toMatch(/violation|unique|PRIMARY/i);
    expect(r.updateCounts).toEqual([1, -1, 1, -1, 1]);
    const rows = await db.query('select id from t_bulk order by id');
    expect(rows.map((x) => x.ID)).toEqual([70, 71, 72]);
    await db.execute('delete from t_bulk', []);
  });

  it('splits large inputs into multiple wire cycles (chunkBytes)', async () => {
    const rows: BatchRow[] = Array.from({ length: 500 }, (_, i) => [1000 + i, `chunked ${i}`, '9.99']);
    // Tiny budget forces many create-less msg+exec cycles.
    const r = await db.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?)', rows, { chunkBytes: 2048 });
    expect(r.rowCount).toBe(500);
    expect(r.rowsAffected).toBe(500);
    expect(r.updateCounts).toHaveLength(500);
    expect((await db.queryOne('select count(*) as n from t_bulk'))!.N).toBe(500);
    await db.execute('delete from t_bulk', []);
  });

  it('indexes errors correctly across cycles', async () => {
    const rows: BatchRow[] = Array.from({ length: 200 }, (_, i) => [2000 + i, `x${i}`, '1.00']);
    rows[150] = [2000, 'dup across cycles', '1.00']; // dup of row 0
    const r = await db.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?)', rows, {
      continueOnError: true,
      chunkBytes: 2048,
    });
    expect(r.errors.map((e) => e.index)).toEqual([150]);
    expect(r.rowsAffected).toBe(199);
    await db.execute('delete from t_bulk', []);
  });

  it('uploads and registers blob parameters', async () => {
    const bin = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const r = await db.executeBatch('insert into t_blob (id, data, memo) values (?, ?, ?)', [
      [1, bin, 'mémo €1'],
      [2, null, 'plain'],
      [3, Buffer.from('tiny'), null],
    ]);
    expect(r.rowsAffected).toBe(3);
    const rows = await db.query('select id, data, memo from t_blob order by id');
    expect(rows[0]!.DATA).toEqual(bin);
    expect(rows[0]!.MEMO).toBe('mémo €1');
    expect(rows[1]!.DATA).toBeNull();
    expect(rows[1]!.MEMO).toBe('plain');
    expect(rows[2]!.DATA).toEqual(Buffer.from('tiny'));
    expect(rows[2]!.MEMO).toBeNull();
  });

  it('batches UPDATE statements with real per-row counts', async () => {
    await db.executeBatch(
      'insert into t_bulk (id, name, amount) values (?, ?, ?)',
      [
        [80, 'a', '1.00'],
        [81, 'b', '2.00'],
      ],
    );
    const r = await db.executeBatch('update t_bulk set name = @name where id = @id', [
      { id: 80, name: 'A2' },
      { id: 999, name: 'nobody' }, // matches no row
      { id: 81, name: 'B2' },
    ]);
    expect(r.updateCounts).toEqual([1, 0, 1]);
    expect(r.rowsAffected).toBe(2);
    expect(r.errors).toEqual([]);
    const rows = await db.query('select name from t_bulk order by id');
    expect(rows.map((x) => x.NAME)).toEqual(['A2', 'B2']);
    await db.execute('delete from t_bulk', []);
  });

  it('consumes an async-iterable row source', async () => {
    async function* gen(): AsyncGenerator<BatchRow> {
      for (let i = 0; i < 25; i++) {
        yield { id: 3000 + i, name: `async ${i}`, amount: null };
        if (i % 10 === 0) await new Promise((res) => setImmediate(res));
      }
    }
    const r = await db.executeBatch('insert into t_bulk (id, name, amount) values (@id, @name, @amount)', gen());
    expect(r.rowsAffected).toBe(25);
    await db.execute('delete from t_bulk', []);
  });

  it('runs inside a caller-owned transaction and obeys rollback', async () => {
    const tx = await db.startTransaction();
    const r = await tx.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?)', [
      [90, 'tx', '1.00'],
      [91, 'tx', '2.00'],
    ]);
    expect(r.rowsAffected).toBe(2);
    await tx.rollback();
    expect((await db.queryOne('select count(*) as n from t_bulk'))!.N).toBe(0);
  });

  it('reuses a PreparedStatement across batch runs', async () => {
    const stmt = await db.prepare('insert into t_bulk (id, name, amount) values (@id, @name, @amount)');
    try {
      const r1 = await stmt.executeBatch([
        { id: 100, name: 'p1', amount: '1.00' },
        { id: 101, name: 'p2', amount: '2.00' },
      ]);
      const r2 = await stmt.executeBatch([{ id: 102, name: 'p3', amount: '3.00' }]);
      expect(r1.rowsAffected).toBe(2);
      expect(r2.rowsAffected).toBe(1);
      expect((await db.queryOne('select count(*) as n from t_bulk'))!.N).toBe(3);
    } finally {
      await stmt.close();
      await db.execute('delete from t_bulk', []);
    }
  });

  it('resolves an empty row source without touching the server', async () => {
    const r = await db.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?)', []);
    expect(r).toEqual({ rowCount: 0, rowsAffected: 0, updateCounts: [], errors: [] });
  });

  it('rejects RETURNING, parameterless SQL, and mismatched named rows', async () => {
    await expect(
      db.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?) returning id', [[1, 'x', null]]),
    ).rejects.toThrow(/RETURNING/);
    await expect(db.executeBatch('delete from t_bulk', [[]])).rejects.toThrow(/requires a statement with parameters/);
    await expect(
      db.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?)', [{ id: 1 }]),
    ).rejects.toThrow(FirebirdParamError);
  });

  it('rejects oversized text and out-of-range numbers with the row index', async () => {
    // varchar(20) on a UTF8 connection is described as 80 BYTES — a 21-char
    // string fits the byte cap, so the SERVER raises the truncation (cleanly,
    // the connection survives).
    await expect(
      db.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?)', [
        [1, 'ok', null],
        [2, 'x'.repeat(21), null],
      ]),
    ).rejects.toThrow(/right truncation/);
    // A Buffer bypasses the charset, so the client byte cap catches this one
    // before anything is sent, with the row index in the message.
    await expect(
      db.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?)', [[2, Buffer.alloc(81, 0x61), null]]),
    ).rejects.toThrow(/batch row 0: Batch parameter 2.*column allows 80/);
    await expect(
      db.executeBatch('insert into t_bulk (id, name, amount) values (?, ?, ?)', [[2147483648, 'x', null]]),
    ).rejects.toThrow(/out of range/);
    expect((await db.queryOne('select count(*) as n from t_bulk'))!.N).toBe(0);
  });
});

describe.each(LEGACY)('executeBatch on Firebird $version', ({ port }) => {
  let db: Attachment;

  beforeAll(async () => {
    db = await freshDb(port);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('fails fast with a clear protocol error', async () => {
    await expect(db.executeBatch('insert into rdb$x values (?)', [[1]])).rejects.toThrow(
      /requires Firebird 4\+ \(wire protocol 16\)/,
    );
    // The connection stays usable.
    expect((await db.queryOne('select 1 as one from rdb$database'))!.ONE).toBe(1);
  });
});
