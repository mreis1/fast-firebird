import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Attachment } from '@fast-firebird/core';
import { drizzle, generateDrizzleSchema, introspectDatabase, migrate } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

describe.each(FB_SERVERS)('introspection & migrator on Firebird $version', ({ port, version }) => {
  let att: Attachment;

  beforeAll(async () => {
    att = await freshDb(port);
    await ddl(
      att,
      `recreate table INTRO_ORDERS_${version} (
        ID integer not null,
        CUSTOMER_NAME varchar(60) not null,
        TOTAL numeric(9,2),
        CREATED timestamp,
        NOTES blob sub_type text,
        RAW_DATA blob sub_type 0,
        ACTIVE boolean,
        BIG_NUM bigint,
        primary key (ID)
      )`,
    );
    await ddl(
      att,
      `recreate table INTRO_LINES_${version} (
        ORDER_ID integer not null,
        LINE_NO smallint not null,
        QTY double precision,
        primary key (ORDER_ID, LINE_NO)
      )`,
    );
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await att?.dropDatabase();
  });

  it('introspects tables, columns, types, nullability and PKs from RDB$', async () => {
    const tables = await introspectDatabase(att);
    const orders = tables.find((t) => t.name === `INTRO_ORDERS_${version}`)!;
    expect(orders).toBeDefined();
    expect(orders.primaryKey).toEqual(['ID']);

    const byName = Object.fromEntries(orders.columns.map((c) => [c.name, c]));
    expect(byName.ID!.sqlType).toBe('INTEGER');
    expect(byName.ID!.nullable).toBe(false);
    expect(byName.CUSTOMER_NAME!.sqlType).toBe('VARCHAR(60)');
    expect(byName.CUSTOMER_NAME!.nullable).toBe(false);
    expect(byName.TOTAL!.sqlType).toBe('NUMERIC(9,2)');
    expect(byName.TOTAL!.nullable).toBe(true);
    expect(byName.CREATED!.sqlType).toBe('TIMESTAMP');
    expect(byName.NOTES!.sqlType).toBe('BLOB SUB_TYPE TEXT');
    expect(byName.RAW_DATA!.sqlType).toBe('BLOB SUB_TYPE BINARY');
    expect(byName.ACTIVE!.sqlType).toBe('BOOLEAN');
    expect(byName.BIG_NUM!.sqlType).toBe('BIGINT');

    const lines = tables.find((t) => t.name === `INTRO_LINES_${version}`)!;
    expect(lines.primaryKey).toEqual(['ORDER_ID', 'LINE_NO']);
    expect(lines.columns.find((c) => c.name === 'LINE_NO')!.sqlType).toBe('SMALLINT');
    expect(lines.columns.find((c) => c.name === 'QTY')!.sqlType).toBe('DOUBLE PRECISION');
  });

  it('generates compilable-looking drizzle schema code', async () => {
    const tables = await introspectDatabase(att);
    const code = generateDrizzleSchema(tables.filter((t) => t.name.startsWith('INTRO_')));
    expect(code).toContain(`export const introOrders${version} = firebirdTable('INTRO_ORDERS_${version}'`);
    expect(code).toContain(`id: integer('ID').primaryKey()`);
    expect(code).toContain(`customerName: varchar('CUSTOMER_NAME', { length: 60 }).notNull()`);
    expect(code).toContain(`notes: blobText('NOTES')`);
    // Composite PK table uses the extraConfig form.
    expect(code).toContain(`primaryKey({ columns: [t.orderId, t.lineNo] })`);
    // Every referenced builder is imported from the package.
    const importLine = code.split('\n')[1]!;
    for (const fn of ['firebirdTable', 'integer', 'varchar', 'blobText', 'primaryKey']) {
      expect(importLine).toContain(fn);
    }
  });

  it('migrate applies pending .sql files in order, once (AUTODDL-style commits)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ff-migrations-'));
    try {
      await writeFile(
        join(dir, '0001_init.sql'),
        `create table MIG_T_${version} (id integer not null primary key, val varchar(20));
         insert into MIG_T_${version} (id, val) values (1, 'from-0001');`,
      );
      await writeFile(
        join(dir, '0002_proc.sql'),
        `set term ^ ;
         create procedure MIG_P_${version} returns (n integer) as begin n = 42; suspend; end^
         set term ; ^`,
      );
      const orm = drizzle(att);

      const first = await migrate(orm, { migrationsFolder: dir });
      expect(first.applied).toEqual(['0001_init.sql', '0002_proc.sql']);
      expect(first.skipped).toEqual([]);

      // Re-run: everything already recorded.
      const second = await migrate(orm, { migrationsFolder: dir });
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(['0001_init.sql', '0002_proc.sql']);

      // The migrations actually ran.
      expect(await att.queryOne(`select val from MIG_T_${version} where id = 1`)).toEqual({ VAL: 'from-0001' });
      expect(await att.queryOne(`select n from MIG_P_${version}`)).toEqual({ N: 42 });

      // A new pending file applies incrementally.
      await writeFile(join(dir, '0003_more.sql'), `insert into MIG_T_${version} (id, val) values (2, 'from-0003');`);
      const third = await migrate(orm, { migrationsFolder: dir });
      expect(third.applied).toEqual(['0003_more.sql']);
      expect((await att.query(`select id from MIG_T_${version} order by id`)).length).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a failing migration aborts the run and records nothing (statements before it stay — AUTODDL)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ff-migrations-bad-'));
    try {
      await writeFile(
        join(dir, '0001_bad.sql'),
        `create table MIG_BAD_${version} (id integer not null primary key);
         insert into MIG_BAD_${version} (id) values (1);
         insert into NOPE_${version} (id) values (1);`,
      );
      await expect(migrate(att, { migrationsFolder: dir })).rejects.toThrow(/Table unknown/i);
      // Unrecorded — a rerun retries the file (and here fails again, now on
      // the already-committed leading CREATE: partial application is real
      // and documented; migrations should be small/idempotent).
      const again = await migrate(att, { migrationsFolder: dir }).catch((e: Error) => e);
      expect(again).toBeInstanceOf(Error);
      const done = await att.query(`select name from FF_MIGRATIONS where name = '0001_bad.sql'`);
      expect(done).toEqual([]);
      // The leading statements DID commit (Firebird has no transactional
      // multi-statement DDL+DML — same reason isql defaults to AUTODDL).
      expect(await att.queryOne(`select id from MIG_BAD_${version}`)).toEqual({ ID: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
