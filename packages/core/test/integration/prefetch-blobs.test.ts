import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Blob as FbBlob, FirebirdBlobError, prefetchBlobs, type Attachment, type Blob } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

/**
 * prefetchBlobs(): bulk-materialize buffered-lazy handles through one
 * cross-blob pipeline instead of N serialized per-handle conversations.
 */
describe.each(FB_SERVERS)('prefetchBlobs on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_PREF_${version}`;
  const N = 30;
  const shas: Record<number, string> = {};

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer not null primary key, doc blob, memo blob sub_type text)`);
    await db.transaction(async (tx) => {
      for (let i = 1; i <= N; i++) {
        const doc = Buffer.alloc(20_000 + i, i & 0xff);
        doc.writeInt32LE(i, 0);
        shas[i] = sha1(doc);
        await tx.execute(`insert into ${t} values (?,?,?)`, [i, doc, `memo €-${i}`]);
      }
      await tx.execute(`insert into ${t} (id) values (?)`, [N + 1]); // NULL blobs
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('one pipeline for many handles; reads afterwards are free and byte-exact', async () => {
    await db.transaction(async (tx) => {
      const rows = await tx.query(`select id, doc, memo from ${t} order by id`, [], { blobs: 'lazy' });
      const before = db.roundTrips;
      await prefetchBlobs(rows.flatMap((r) => [r.DOC as Blob, r.MEMO as Blob]));
      const prefetchFlushes = db.roundTrips - before;
      expect(prefetchFlushes).toBeLessThan(N * 2); // < 1 flush/blob (serial ≈ 2+)

      const after = db.roundTrips;
      for (const r of rows.slice(0, N)) {
        expect(sha1(await (r.DOC as Blob).buffer())).toBe(shas[r.ID as number]);
        expect(await (r.MEMO as Blob).text()).toBe(`memo €-${r.ID}`); // codec intact
      }
      expect(db.roundTrips - after).toBe(0); // all served from memory
    });
  });

  it('beats per-handle Promise.all on flushes (control)', async () => {
    await db.transaction(async (tx) => {
      const rows = await tx.query(`select doc from ${t} where id <= ${N} order by id`, [], { blobs: 'lazy' });
      const b1 = db.roundTrips;
      await prefetchBlobs(rows.map((r) => r.DOC as Blob));
      const bulk = db.roundTrips - b1;

      const rows2 = await tx.query(`select doc from ${t} where id <= ${N} order by id`, [], { blobs: 'lazy' });
      const b2 = db.roundTrips;
      await Promise.all(rows2.map((r) => (r.DOC as Blob).buffer())); // serializes on the op-lock
      const serial = db.roundTrips - b2;

      expect(bulk).toBeLessThan(serial);
    });
  });

  it('tolerates nulls, duplicates, cached and head-cursor handles', async () => {
    await db.transaction(async (tx) => {
      const rows = await tx.query(`select id, doc from ${t} where id <= 4 or id = ${N + 1} order by id`, [], { blobs: 'lazy' });
      const b1 = rows[0]!.DOC as Blob;
      const b2 = rows[1]!.DOC as Blob;
      const b3 = rows[2]!.DOC as Blob;
      const b4 = rows[3]!.DOC as Blob;
      await b1.buffer(); // already cached → skipped
      await b2.head(8); // open cursor → skipped (resumes on its own)
      await prefetchBlobs([b1, b2, b3, b3, b4, rows[4]!.DOC as Blob | null, null, undefined]);
      expect(sha1(await b1.buffer())).toBe(shas[1]);
      expect(sha1(await b2.buffer())).toBe(shas[2]); // cursor resume still exact
      expect(sha1(await b3.buffer())).toBe(shas[3]);
      expect(sha1(await b4.buffer())).toBe(shas[4]);
      expect(rows[4]!.DOC).toBeNull(); // NULL column never was a handle
    });
  });

  it('groups handles from different queries in the same transaction', async () => {
    await db.transaction(async (tx) => {
      const a = await tx.query(`select doc from ${t} where id = 1`, [], { blobs: 'lazy' });
      const b = await tx.query(`select doc from ${t} where id = 2`, [], { blobs: 'lazy' });
      await prefetchBlobs([a[0]!.DOC as Blob, b[0]!.DOC as Blob]);
      const before = db.roundTrips;
      expect(sha1(await (a[0]!.DOC as Blob).buffer())).toBe(shas[1]);
      expect(sha1(await (b[0]!.DOC as Blob).buffer())).toBe(shas[2]);
      expect(db.roundTrips - before).toBe(0);
    });
  });

  it('static form Blob.prefetch is the same API', async () => {
    await db.transaction(async (tx) => {
      const rows = await tx.query(`select doc from ${t} where id = 5`, [], { blobs: 'lazy' });
      await FbBlob.prefetch([rows[0]!.DOC as Blob]);
      const before = db.roundTrips;
      expect(sha1(await (rows[0]!.DOC as Blob).buffer())).toBe(shas[5]);
      expect(db.roundTrips - before).toBe(0);
    });
  });

  it('throws on handles from a closed transaction', async () => {
    let stale: Blob | undefined;
    await db.transaction(async (tx) => {
      const rows = await tx.query(`select doc from ${t} where id = 1`, [], { blobs: 'lazy' });
      stale = rows[0]!.DOC as Blob;
    });
    await expect(prefetchBlobs([stale!])).rejects.toBeInstanceOf(FirebirdBlobError);
  });

  it('skips read-ahead-tracked handles without double-fetching', async () => {
    const it_ = db.queryStream(`select id, doc from ${t} where id <= 2 order by id`, [], {
      blobs: 'lazy',
      blobReadAhead: 1,
    })[Symbol.asyncIterator]();
    try {
      const r1 = (await it_.next()).value;
      await new Promise((r) => setTimeout(r, 100)); // let read-ahead land
      await prefetchBlobs([r1.DOC as Blob]); // tracked by the store → skipped
      expect(sha1(await (r1.DOC as Blob).buffer())).toBe(shas[1]);
    } finally {
      await it_.return?.(undefined);
    }
  });
});
