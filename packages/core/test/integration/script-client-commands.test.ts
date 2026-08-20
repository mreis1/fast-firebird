import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Attachment } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

describe.each(FB_SERVERS)('executeScript client commands on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const log = `cc_log_${version}`;
  const iso = `cc_iso_${version}`;
  const conns = `cc_conn_${version}`;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${log} (id integer)`);
    await ddl(db, `recreate table ${iso} (v varchar(30))`);
    await ddl(db, `recreate table ${conns} (c bigint)`);
  }, HOOK_TIMEOUT);
  afterAll(async () => {
    await db?.dropDatabase();
  });

  const count = async (table: string): Promise<number> => {
    const [row] = await db.query<{ N: unknown }>(`select count(*) as n from ${table}`);
    return Number(row!.N);
  };

  it('perScript: COMMIT is a checkpoint — work before it survives a later failure', async () => {
    await db.execute(`delete from ${log}`);
    const script = `
      insert into ${log} (id) values (1);
      insert into ${log} (id) values (2);
      commit;
      insert into ${log} (id) values (3);
      insert into no_such_table_cc (id) values (4);
    `;
    await expect(db.executeScript(script)).rejects.toThrow(/Table unknown|Dynamic SQL Error/i);
    expect(await count(log)).toBe(2); // 1,2 committed; 3 rolled back
  });

  it('perScript: ROLLBACK discards work before it; the script keeps going', async () => {
    await db.execute(`delete from ${log}`);
    const result = await db.executeScript(`
      insert into ${log} (id) values (1);
      rollback;
      insert into ${log} (id) values (2);
    `);
    expect(result.failed).toBe(0);
    expect(result.statements[1]!.statement.kind).toBe('client');
    expect(result.statements[1]!.statement.client).toEqual({ op: 'rollback', retain: false });
    const rows = await db.query<{ ID: number }>(`select id from ${log}`);
    expect(rows).toEqual([{ ID: 2 }]);
  });

  it('perScript: COMMIT RETAIN persists work while keeping the context open', async () => {
    await db.execute(`delete from ${log}`);
    const script = `
      insert into ${log} (id) values (1);
      commit work retain;
      insert into ${log} (id) values (2);
      insert into no_such_table_cc (id) values (3);
    `;
    await expect(db.executeScript(script)).rejects.toThrow(/Table unknown|Dynamic SQL Error/i);
    const rows = await db.query<{ ID: number }>(`select id from ${log}`);
    expect(rows).toEqual([{ ID: 1 }]); // retained; 2 rolled back with the failure
  });

  it('perScript: RECONNECT re-attaches mid-script and keeps prior work', async () => {
    await db.execute(`delete from ${conns}`);
    const result = await db.executeScript(`
      insert into ${conns} (c) values (current_connection);
      reconnect;
      insert into ${conns} (c) values (current_connection);
    `);
    expect(result.failed).toBe(0);
    const [row] = await db.query<{ N: unknown }>(`select count(distinct c) as n from ${conns}`);
    expect(Number(row!.N)).toBe(2); // two different server connections
    expect(await count(conns)).toBe(2); // pre-reconnect insert was committed
  });

  it('perScript: SET TRANSACTION switches isolation for subsequent work', async () => {
    await db.execute(`delete from ${iso}`);
    const result = await db.executeScript(`
      set transaction read committed record_version;
      insert into ${iso} (v) values (rdb$get_context('SYSTEM', 'ISOLATION_LEVEL'));
      commit;
      set transaction snapshot;
      insert into ${iso} (v) values (rdb$get_context('SYSTEM', 'ISOLATION_LEVEL'));
    `);
    expect(result.failed).toBe(0);
    const rows = await db.query<{ V: string }>(`select v from ${iso} order by v`);
    expect(rows.map((r) => r.V)).toEqual(['READ COMMITTED', 'SNAPSHOT']);
  });

  it('perScript: SET TRANSACTION on a dirty transaction demands COMMIT/ROLLBACK first', async () => {
    await expect(
      db.executeScript(`
        insert into ${log} (id) values (9);
        set transaction snapshot;
      `),
    ).rejects.toThrow(/COMMIT or ROLLBACK first/);
  });

  it('wire guard: an unmappable SET TRANSACTION is rejected BY NAME, never sent', async () => {
    await expect(db.executeScript(`set transaction reserving ${log} for protected write;`)).rejects.toThrow(
      /RESERVING/,
    );
    await expect(db.executeScript('set transaction no auto undo;')).rejects.toThrow(/NO AUTO UNDO/);
  });

  it('SET AUTODDL ON commits DDL even when a later statement fails', async () => {
    const table = `cc_autoddl_${version}`;
    await db.execute(`drop table ${table}`).catch(() => undefined);
    const script = `
      set autoddl on;
      create table ${table} (id integer);
      insert into no_such_table_cc (id) values (1);
    `;
    await expect(db.executeScript(script)).rejects.toThrow(/Table unknown|Dynamic SQL Error/i);
    // The Delphi-installer scenario: the DDL survived the later failure.
    const [r] = await db.query<{ N: unknown }>(
      `select count(*) as n from rdb$relations where rdb$relation_name = '${table.toUpperCase()}'`,
    );
    expect(Number(r!.N)).toBe(1);
    await db.execute(`drop table ${table}`);
  });

  it('caller-supplied Transaction: every client command errors, tx stays alive', async () => {
    const tx = await db.startTransaction();
    try {
      await expect(
        db.executeScript(`insert into ${log} (id) values (7); commit;`, { transaction: tx }),
      ).rejects.toThrow(/caller-supplied Transaction/);
      expect(tx.isFinished).toBe(false); // the executor never touched its lifecycle
      await expect(db.executeScript('reconnect;', { transaction: tx })).rejects.toThrow(/caller owns the connection/);
      expect(tx.isFinished).toBe(false);
    } finally {
      await tx.rollback();
    }
  });

  it("perStatement: COMMIT/ROLLBACK are no-op successes (isql-script friendliness)", async () => {
    await db.execute(`delete from ${log}`);
    const result = await db.executeScript(
      `
        insert into ${log} (id) values (1);
        commit;
        rollback;
        insert into ${log} (id) values (2);
      `,
      { transaction: 'perStatement' },
    );
    expect(result.failed).toBe(0);
    expect(result.succeeded).toBe(4);
    expect(await count(log)).toBe(2); // each insert already autocommitted
  });

  it('perStatement: SET TRANSACTION configures the transactions that follow', async () => {
    await expect(
      db.executeScript(
        `
          set transaction read only;
          insert into ${log} (id) values (8);
        `,
        { transaction: 'perStatement' },
      ),
    ).rejects.toThrow(/read-only transaction/i);
  });

  it("'none': SET TRANSACTION is rejected (that's defaultTransaction's job)", async () => {
    await expect(db.executeScript('set transaction read only;', { transaction: 'none' })).rejects.toThrow(
      /defaultTransaction/,
    );
  });

  it("clientCommands: 'error' rejects every client command without sending it", async () => {
    await db.execute(`delete from ${log}`);
    await expect(
      db.executeScript(`insert into ${log} (id) values (1); commit;`, { clientCommands: 'error' }),
    ).rejects.toThrow(/clientCommands: 'error'/);
    expect(await count(log)).toBe(0); // wrapper tx rolled back — COMMIT never executed anywhere
  });

  it('continueOnError applies to client-command failures too', async () => {
    const result = await db.executeScript(
      `
        insert into ${log} (id) values (1);
        set transaction snapshot;
        insert into ${log} (id) values (2);
      `,
      { continueOnError: true },
    );
    expect(result.failed).toBe(1); // dirty SET TRANSACTION recorded, script went on
    expect(result.succeeded).toBe(2);
    expect(result.statements[1]!.error?.message).toMatch(/COMMIT or ROLLBACK first/);
  });

  it('ROLLBACK TO SAVEPOINT stays server-side and works inside the script transaction', async () => {
    await db.execute(`delete from ${log}`);
    const result = await db.executeScript(`
      insert into ${log} (id) values (1);
      savepoint sp1;
      insert into ${log} (id) values (2);
      rollback to savepoint sp1;
      insert into ${log} (id) values (3);
    `);
    expect(result.failed).toBe(0);
    const rows = await db.query<{ ID: number }>(`select id from ${log} order by id`);
    expect(rows.map((r) => r.ID)).toEqual([1, 3]); // 2 undone by the savepoint rollback
  });
});
