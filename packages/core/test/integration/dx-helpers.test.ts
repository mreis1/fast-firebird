import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createPool, Blob, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Deferred backlog #8 — small DX helpers: queryOne(), typed query<T>(),
 * per-query fetchSize, `await using` (Symbol.asyncDispose) and blob.toFile().
 */
describe.each(FB_SERVERS)('DX helpers on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_DX_${version}`;
  const bt = `T_DXB_${version}`;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer not null primary key, val varchar(30))`);
    await ddl(db, `recreate table ${bt} (id integer not null primary key, doc blob sub_type 0)`);
    await db.transaction(async (tx) => {
      for (let i = 1; i <= 50; i++) await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [i, `row ${i}`]);
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  describe('queryOne', () => {
    it('returns the first row', async () => {
      const row = await db.queryOne(`select val from ${t} where id = ?`, [7]);
      expect(row).toEqual({ VAL: 'row 7' });
    });

    it('returns undefined on an empty result', async () => {
      expect(await db.queryOne(`select val from ${t} where id = ?`, [-1])).toBeUndefined();
    });

    it('works on transactions and prepared statements', async () => {
      await db.transaction(async (tx) => {
        expect(await tx.queryOne(`select val from ${t} where id = ?`, [3])).toEqual({ VAL: 'row 3' });
      });
      const stmt = await db.prepare(`select val from ${t} where id = ?`);
      try {
        expect(await stmt.queryOne([4])).toEqual({ VAL: 'row 4' });
        expect(await stmt.queryOne([-1])).toBeUndefined();
      } finally {
        await stmt.close();
      }
    });
  });

  describe('typed rows query<T>()', () => {
    interface DxRow {
      ID: number;
      VAL: string;
    }

    it('shapes rows at compile time (values unchanged at runtime)', async () => {
      const rows = await db.query<DxRow>(`select id, val from ${t} where id <= 2 order by id`);
      // TS: rows[0].ID is number, rows[0].VAL is string — no casts needed.
      expect(rows.map((r) => r.ID)).toEqual([1, 2]);
      expect(rows[0]!.VAL).toBe('row 1');
      const one = await db.queryOne<DxRow>(`select id, val from ${t} where id = ?`, [5]);
      expect(one?.VAL).toBe('row 5');
      const res = await db.run<DxRow>(`select id, val from ${t} where id = 1`);
      expect(res.rows[0]!.ID).toBe(1);
    });

    it('types streamed rows too', async () => {
      const ids: number[] = [];
      for await (const r of db.queryStream<DxRow>(`select id, val from ${t} order by id`)) ids.push(r.ID);
      expect(ids).toHaveLength(50);
    });
  });

  describe('per-query fetchSize', () => {
    it('caps the rows per fetch round trip for one statement', async () => {
      // Warm the statement cache so both runs pay identical prepare costs.
      await db.query(`select id from ${t} order by id`);

      const before = db.roundTrips;
      const all = await db.query(`select id from ${t} order by id`);
      const defaultTrips = db.roundTrips - before;

      const before2 = db.roundTrips;
      const tiny = await db.query(`select id from ${t} order by id`, [], { fetchSize: 5 });
      const tinyTrips = db.roundTrips - before2;

      expect(tiny).toEqual(all);
      expect(all).toHaveLength(50);
      // 50 rows in batches of ≤5 needs many more fetches than the default
      // adaptive plan (which takes all 50 in the first piggybacked batch).
      expect(tinyTrips).toBeGreaterThan(defaultTrips + 5);
    });

    it('applies to queryStream as well', async () => {
      const before = db.roundTrips;
      const ids: number[] = [];
      for await (const r of db.queryStream(`select id from ${t} order by id`, [], { fetchSize: 10 })) {
        ids.push(r.ID as number);
      }
      expect(ids).toHaveLength(50);
      expect(db.roundTrips - before).toBeGreaterThan(4); // ≥5 fetch batches
    });
  });

  describe('await using (Symbol.asyncDispose)', () => {
    it('rolls back an uncommitted transaction at scope exit', async () => {
      {
        await using tx = await db.startTransaction();
        await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [901, 'dropped']);
      }
      expect(await db.queryOne(`select 1 as x from ${t} where id = 901`)).toBeUndefined();
    });

    it('is a no-op after an explicit commit', async () => {
      {
        await using tx = await db.startTransaction();
        await tx.execute(`insert into ${t} (id, val) values (?, ?)`, [902, 'kept']);
        await tx.commit();
      }
      expect(await db.queryOne(`select val from ${t} where id = 902`)).toEqual({ VAL: 'kept' });
      await db.execute(`delete from ${t} where id = 902`);
    });

    it('disconnects an attachment at scope exit', async () => {
      let ref: Attachment;
      {
        await using conn = await connect({ ...FB_BASE, port, database: (db as any).options.database });
        ref = conn;
        expect(conn.isAlive).toBe(true);
      }
      expect(ref!.isAlive).toBe(false);
    });

    it('closes a pool at scope exit', async () => {
      let ref;
      {
        await using pool = await createPool({ ...FB_BASE, port, database: (db as any).options.database, max: 2 });
        ref = pool;
        expect(await pool.queryOne(`select 1 as x from rdb$database`)).toEqual({ X: 1 });
      }
      await expect(ref!.acquire()).rejects.toThrow(/closed/i);
    });

    it('closes a prepared statement at scope exit', async () => {
      let ref;
      {
        await using stmt = await db.prepare(`select val from ${t} where id = ?`);
        ref = stmt;
        expect(await stmt.queryOne([1])).toEqual({ VAL: 'row 1' });
      }
      await expect(ref!.queryOne([1])).rejects.toThrow(/closed/i);
    });
  });

  describe('blob.toFile', () => {
    it('streams a lazy blob to disk and returns the byte count', async () => {
      const payload = randomBytes(300 * 1024); // spans several segments
      await db.execute(`insert into ${bt} (id, doc) values (?, ?)`, [1, payload]);
      const dir = await mkdtemp(join(tmpdir(), 'ff-tofile-'));
      const path = join(dir, 'doc.bin');
      try {
        await db.transaction(async (tx) => {
          const row = await tx.queryOne(`select doc from ${bt} where id = 1`, [], { blobs: 'lazy' });
          const blob = row!.DOC as Blob;
          const written = await blob.toFile(path);
          expect(written).toBe(payload.length);
        });
        const onDisk = await readFile(path);
        expect(onDisk.length).toBe(payload.length);
        expect(sha(onDisk)).toBe(sha(payload));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
