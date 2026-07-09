import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl } from './env.js';

describe.each(FB_SERVERS)('executeScript on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const proc = `sp_fill_${version}`;
  const log = `script_log_${version}`;

  beforeAll(async () => {
    db = await connect({ ...FB_BASE, port });
    // A prior run leaves sp_fill_* depending on the log table; drop it first
    // so the table can be recreated.
    await db.execute(`drop procedure ${proc}`).catch(() => undefined);
    await ddl(db, `recreate table ${log} (id integer, note varchar(50))`);
  }, HOOK_TIMEOUT);
  afterAll(async () => {
    await db?.disconnect();
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
});
