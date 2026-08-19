import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

describe.each(FB_SERVERS)('executeScript on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const proc = `sp_fill_${version}`;
  const log = `script_log_${version}`;

  beforeAll(async () => {
    db = await freshDb(port);
    // A prior run leaves sp_fill_* depending on the log table; drop it first
    // so the table can be recreated.
    await db.execute(`drop procedure ${proc}`).catch(() => undefined);
    await ddl(db, `recreate table ${log} (id integer, note varchar(50))`);
  }, HOOK_TIMEOUT);
  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('runs a SET TERM / PSQL / DML script atomically (perScript)', async () => {
    const script = `
      delete from ${log};
      set term ^ ;
      create or alter procedure ${proc} (n integer) as
        declare i integer;
      begin
        i = 0;
        while (i < n) do
        begin
          insert into ${log} (id, note) values (:i, 'row; with ; semicolons');
          i = i + 1;
        end
      end^
      set term ; ^
      execute procedure ${proc}(4);
    `;
    const result = await db.executeScript(script);
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(3); // delete, create proc, execute proc
    const [c] = await db.query(`select count(*) as n from ${log}`);
    expect(Number(c!.N)).toBe(4);
    const [r] = await db.query(`select note from ${log} where id = 0`);
    expect(r!.NOTE).toBe('row; with ; semicolons');
  });

  it('rolls back the whole script on error (perScript, default)', async () => {
    await db.execute(`delete from ${log}`);
    const script = `
      insert into ${log} (id) values (1);
      insert into ${log} (id) values (2);
      insert into nonexistent_table_xyz (id) values (3);
      insert into ${log} (id) values (4);
    `;
    await expect(db.executeScript(script)).rejects.toThrow(/Table unknown|Dynamic SQL Error/i);
    const [c] = await db.query(`select count(*) as n from ${log}`);
    expect(Number(c!.N)).toBe(0); // first two inserts rolled back
  });

  it('continueOnError collects failures and keeps going (perStatement)', async () => {
    await db.execute(`delete from ${log}`);
    const progress: number[] = [];
    const result = await db.executeScript(
      `
        insert into ${log} (id) values (10);
        insert into bad_table_abc (id) values (11);
        insert into ${log} (id) values (12);
      `,
      {
        transaction: 'perStatement',
        continueOnError: true,
        onProgress: (r) => progress.push(r.index),
      },
    );
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.statements[1]!.error).toBeDefined();
    expect(progress).toEqual([0, 1, 2]);
    const [c] = await db.query(`select count(*) as n from ${log}`);
    expect(Number(c!.N)).toBe(2); // 10 and 12 committed, 11 failed
  });

  it('reports rowsAffected per statement', async () => {
    await db.execute(`delete from ${log}`);
    const result = await db.executeScript(`
      insert into ${log} (id) values (1);
      insert into ${log} (id) values (2);
      update ${log} set note = 'x';
    `);
    expect(result.statements.map((s) => s.rowsAffected)).toEqual([1, 1, 2]);
  });

  it('failed statements carry gdsCode + sqlState for classification', async () => {
    const result = await db.executeScript(`insert into no_such_table_qq (id) values (1);`, {
      continueOnError: true,
    });
    const failed = result.statements[0]!;
    expect(failed.error).toBeDefined();
    expect(typeof failed.gdsCode).toBe('number');
    expect(failed.sqlState).toMatch(/^\w{5}$/);
  });

  it('transactionOptions reaches the perScript transaction (nowait fails fast)', async () => {
    await db.execute(`delete from ${log}`);
    await db.execute(`insert into ${log} (id, note) values (99, 'held')`);
    const other = await connect({ ...FB_BASE, port, database: db.options.database });
    const holder = await other.startTransaction();
    try {
      await holder.execute(`update ${log} set note = 'locked' where id = 99`);
      const started = Date.now();
      await expect(
        db.executeScript(`update ${log} set note = 'blocked' where id = 99;`, {
          transactionOptions: { isolation: 'readCommitted', wait: false },
        }),
      ).rejects.toThrow(/update conflicts|lock conflict/i);
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await holder.rollback();
      await other.disconnect();
    }
  });

  it('runs on a caller-supplied Transaction and never finishes it', async () => {
    await db.execute(`delete from ${log}`);
    const tx = await db.startTransaction();
    const result = await db.executeScript(
      `insert into ${log} (id) values (201);
       insert into ${log} (id) values (202);`,
      { transaction: tx },
    );
    expect(result.succeeded).toBe(2);
    expect(tx.isFinished).toBe(false);
    // Composes atomically with the caller's own statement…
    await tx.execute(`insert into ${log} (id) values (203)`);
    await tx.rollback(); // …and the CALLER decides the outcome.
    const [c] = await db.query(`select count(*) as n from ${log}`);
    expect(Number(c!.N)).toBe(0);
  });

  it('caller tx: a failing statement propagates and leaves the tx alive', async () => {
    await db.execute(`delete from ${log}`);
    const tx = await db.startTransaction();
    try {
      await expect(
        db.executeScript(
          `insert into ${log} (id) values (301);
           insert into no_such_table_zz (id) values (1);`,
          { transaction: tx },
        ),
      ).rejects.toThrow(/Table unknown|Dynamic SQL Error/i);
      expect(tx.isFinished).toBe(false); // caller owns the outcome
      await tx.commit(); // keep the statement that DID run
    } catch (err) {
      if (!tx.isFinished) await tx.rollback();
      throw err;
    }
    const rows = await db.query(`select id from ${log}`);
    expect(rows).toEqual([{ ID: 301 }]);
  });

  it('rejects transactionOptions with none / a caller Transaction', async () => {
    await expect(
      db.executeScript('select 1 from rdb$database;', { transaction: 'none', transactionOptions: { wait: false } }),
    ).rejects.toThrow(/transactionOptions is invalid with transaction: 'none'/);
    const tx = await db.startTransaction();
    try {
      await expect(
        db.executeScript('select 1 from rdb$database;', { transaction: tx, transactionOptions: { wait: false } }),
      ).rejects.toThrow(/transactionOptions is invalid with a caller-supplied Transaction/);
    } finally {
      await tx.rollback();
    }
  });

  it('parsed statements expose kind through the result', async () => {
    const result = await db.executeScript(
      `recreate table kind_probe_${version} (id int);
       insert into kind_probe_${version} (id) values (1);
       select * from kind_probe_${version};`,
      { transaction: 'perStatement' },
    );
    expect(result.statements.map((s) => s.statement.kind)).toEqual(['ddl', 'dml', 'other']);
  });
});
