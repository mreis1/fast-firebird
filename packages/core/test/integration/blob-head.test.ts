import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FirebirdBlobError, type Attachment, type Blob } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

/**
 * `blob.head(n)` + forward-resume cursor (deferred backlog #5): read the
 * first bytes (magic-number sniffing) keeping the handle open at position;
 * buffer()/stream() resume the transfer instead of starting over.
 */
describe.each(FB_SERVERS)('blob.head / resume cursor on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_HEAD_${version}`;
  const SIZE = 300_000;
  // PNG-like magic followed by a deterministic byte pattern.
  const PAYLOAD = Buffer.alloc(SIZE);
  for (let i = 0; i < SIZE; i++) PAYLOAD[i] = (i * 7) & 0xff;
  PAYLOAD.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer not null primary key, doc blob, memo blob sub_type text, tiny blob)`);
    await db.execute(`insert into ${t} values (?,?,?,?)`, [1, PAYLOAD, 'memo €-head', Buffer.from('tiny')]);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  /** Fetch a fresh lazy handle for column `col` of row 1. */
  async function handleOf(tx: any, col: string): Promise<Blob> {
    const [row] = await tx.query(`select ${col} from ${t} where id = 1`, [], { blobs: 'lazy' });
    return row![col.toUpperCase()] as Blob;
  }

  it('head(8) sniffs the magic number in 2 flushes (open + one window)', async () => {
    await db.transaction(async (tx) => {
      const doc = await handleOf(tx, 'doc');
      const before = db.roundTrips;
      const magic = await doc.head(8);
      expect(db.roundTrips - before).toBeLessThanOrEqual(2);
      expect(magic.equals(PAYLOAD.subarray(0, 8))).toBe(true);
    });
  });

  it('buffer() after head() resumes — no re-open, no re-transfer, bytes exact', async () => {
    await db.transaction(async (tx) => {
      const doc = await handleOf(tx, 'doc');
      await doc.head(8);
      const before = db.roundTrips;
      const full = await doc.buffer();
      // Resume = one pipelined window flush on the EXISTING handle. A fresh
      // read would cost 2+ (open + window) — ≤1 proves no re-open happened.
      expect(db.roundTrips - before).toBeLessThanOrEqual(1);
      expect(full.equals(PAYLOAD)).toBe(true);
      expect((await doc.buffer()).equals(PAYLOAD)).toBe(true); // cached repeat
    });
  });

  it('widening heads read only the delta; full head promotes to cache', async () => {
    await db.transaction(async (tx) => {
      const doc = await handleOf(tx, 'doc');
      const h16 = await doc.head(16);
      expect(h16.equals(PAYLOAD.subarray(0, 16))).toBe(true);
      const h100k = await doc.head(100_000);
      expect(h100k.equals(PAYLOAD.subarray(0, 100_000))).toBe(true);
      // head(n) beyond the blob size returns everything and caches it.
      const tiny = await handleOf(tx, 'tiny');
      const all = await tiny.head(1_000_000);
      expect(all.toString()).toBe('tiny');
      const before = db.roundTrips;
      expect((await tiny.buffer()).toString()).toBe('tiny');
      expect(db.roundTrips - before).toBe(0); // promoted — no wire work
    });
  });

  it('stream() after head() emits the full content exactly once (resume)', async () => {
    await db.transaction(async (tx) => {
      const doc = await handleOf(tx, 'doc');
      const magic = await doc.head(8);
      expect(magic.length).toBe(8);
      const before = db.roundTrips;
      const chunks: Buffer[] = [];
      for await (const c of doc.stream({ chunkSize: 65_535 })) chunks.push(c as Buffer);
      const all = Buffer.concat(chunks);
      expect(all.equals(PAYLOAD)).toBe(true); // preamble + resumed tail, no dupes
      // Resumed stream never re-opens: strictly fewer flushes than a fresh
      // stream of the same blob (which pays open + per-pull round trips).
      const resumed = db.roundTrips - before;
      const fresh = await handleOf(tx, 'doc');
      const before2 = db.roundTrips;
      const chunks2: Buffer[] = [];
      for await (const c of fresh.stream({ chunkSize: 65_535 })) chunks2.push(c as Buffer);
      expect(Buffer.concat(chunks2).equals(PAYLOAD)).toBe(true);
      expect(resumed).toBeLessThan(db.roundTrips - before2);
    });
  });

  it('close() releases the cursor; a later read starts clean from byte 0', async () => {
    await db.transaction(async (tx) => {
      const doc = await handleOf(tx, 'doc');
      expect((await doc.head(16)).equals(PAYLOAD.subarray(0, 16))).toBe(true);
      await doc.close();
      const full = await doc.buffer(); // fresh full read — no double prefix
      expect(full.equals(PAYLOAD)).toBe(true);
      await doc.close(); // no-op on a finished blob
    });
  });

  it('head() decodes nothing — text() after a memo head still charset-decodes', async () => {
    await db.transaction(async (tx) => {
      const memo = await handleOf(tx, 'memo');
      const raw = await memo.head(4); // raw bytes, no codec
      expect(Buffer.isBuffer(raw)).toBe(true);
      expect(await memo.text()).toBe('memo €-head'); // resume + codec intact
    });
  });

  it('head() on a prefetched blob serves from the read-ahead store', async () => {
    const it_ = db.queryStream(`select id, doc from ${t} where id = 1`, [], { blobs: 'lazy', blobReadAhead: 1 })[Symbol.asyncIterator]();
    try {
      const r1 = (await it_.next()).value;
      await new Promise((r) => setTimeout(r, 150)); // let the prefetch land
      const before = db.roundTrips;
      const magic = await (r1.DOC as Blob).head(8);
      expect(magic.equals(PAYLOAD.subarray(0, 8))).toBe(true);
      expect(db.roundTrips - before).toBe(0);
    } finally {
      await it_.return?.(undefined);
    }
  });

  it('an unfinished cursor does not desync the connection or the tx', async () => {
    await db.transaction(async (tx) => {
      const doc = await handleOf(tx, 'doc');
      await doc.head(16); // cursor left open on purpose
      const [r] = await tx.query(`select count(*) as c from ${t}`);
      expect(Number(r!.C)).toBe(1); // interleaved query is fine
    });
    // tx closed with the cursor open — server frees it; connection usable.
    const rows = await db.query(`select id from ${t}`);
    expect(rows).toHaveLength(1);
  });

  it('head() after the transaction closed throws FirebirdBlobError', async () => {
    let stale: Blob | undefined;
    await db.transaction(async (tx) => {
      stale = await handleOf(tx, 'doc');
    });
    await expect(stale!.head(8)).rejects.toBeInstanceOf(FirebirdBlobError);
  });
});
