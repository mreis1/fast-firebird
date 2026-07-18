import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createDatabase, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, nextDatabasePath } from './env.js';

/**
 * FB6 attach-time DPB options: `searchPath` (isc_dpb_search_path, 105) sets
 * the session's initial schema search path; `owner` (isc_dpb_owner, 102)
 * creates a database owned by another user. Pre-FB6 servers silently ignore
 * both tags (asserted below), so the options are safe to set unconditionally.
 */
const fb6 = FB_SERVERS.find((s) => s.version === 6);

describe.skipIf(!fb6)('FB6 searchPath / owner attach options', () => {
  const port = fb6!.port;
  let db: Attachment;
  let database: string;

  beforeAll(async () => {
    database = nextDatabasePath(port);
    db = await createDatabase({ ...FB_BASE, port, database });
    await ddl(db, 'create schema APP');
    await ddl(db, 'create table APP.SETTINGS (id integer not null primary key, name varchar(20))');
    await db.execute("insert into APP.SETTINGS values (1, 'from-app-schema')");
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('default search path is PUBLIC, SYSTEM — unqualified name does not see APP', async () => {
    const conn = await connect({ ...FB_BASE, port, database });
    try {
      const [r] = await conn.query("select rdb$get_context('SYSTEM','SEARCH_PATH') as sp from rdb$database");
      expect(r!.SP).toBe('"PUBLIC", "SYSTEM"');
      await expect(conn.query('select * from SETTINGS')).rejects.toThrow(/Table unknown|not defined/i);
    } finally {
      await conn.disconnect();
    }
  });

  it('searchPath (array form) resolves unqualified names through APP', async () => {
    const conn = await connect({ ...FB_BASE, port, database, searchPath: ['APP', 'PUBLIC'] });
    try {
      const [r] = await conn.query("select rdb$get_context('SYSTEM','SEARCH_PATH') as sp from rdb$database");
      expect(r!.SP).toBe('"APP", "PUBLIC", "SYSTEM"'); // SYSTEM auto-appended
      const [row] = await conn.query('select name from SETTINGS where id = 1');
      expect(row!.NAME).toBe('from-app-schema');
      const [cs] = await conn.query('select current_schema as s from rdb$database');
      expect(cs!.S).toBe('APP');
    } finally {
      await conn.disconnect();
    }
  });

  it('searchPath (string form) works too', async () => {
    const conn = await connect({ ...FB_BASE, port, database, searchPath: 'APP' });
    try {
      const [row] = await conn.query('select name from SETTINGS where id = 1');
      expect(row!.NAME).toBe('from-app-schema');
    } finally {
      await conn.disconnect();
    }
  });

  it('owner: createDatabase produces a database owned by another user', async () => {
    const OWNER = 'FF_TEST_OWNER';
    await db.execute(`create or alter user ${OWNER} password 'ff-owner-pw' using plugin Srp`);
    const owned = nextDatabasePath(port);
    let conn: Attachment | null = null;
    try {
      conn = await createDatabase({ ...FB_BASE, port, database: owned, owner: OWNER });
      const [r] = await conn.query('select mon$owner as o from mon$database');
      expect((r!.O as string).trim()).toBe(OWNER);
    } finally {
      await conn?.dropDatabase();
      await db.execute(`drop user ${OWNER} using plugin Srp`).catch(() => {});
    }
  });
});

describe.each(FB_SERVERS.filter((s) => s.version < 6))(
  'searchPath is ignored gracefully on Firebird $version',
  ({ port }) => {
    it('attach succeeds with searchPath set', async () => {
      const conn = await connect({ ...FB_BASE, port, searchPath: ['PUBLIC', 'SYSTEM'] });
      try {
        const [r] = await conn.query('select 1 as ok from rdb$database');
        expect(r!.OK).toBe(1);
      } finally {
        await conn.disconnect();
      }
    });
  },
);
