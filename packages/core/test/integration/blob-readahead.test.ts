import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment, type Blob } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

/**
 * Part B of cross-blob pipelining: `blobReadAhead` on queryStream — the
 * driver prefetches upcoming rows' lazy blobs while the consumer processes
 * the current one. Purely an optimization: everything stays correct when it
 * can't help (budget, skips, out-of-order reads).
 */
describe.each(FB_SERVERS)('blobReadAhead on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_RAHEAD_${version}`;
  const N = 12;
  const SIZE = 100_000;
  const payload = (id: number) => {
    const b = Buffer.alloc(SIZE, id & 0xff);
    b.writeInt32LE(id, 0);
    return b;
  };

  /** Let background prefetch lock-slices drain. */
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer not null primary key, doc blob, memo blob sub_type text)`);
    await db.transaction(async (tx) => {
      for (let i = 1; i <= N; i++) await tx.execute(`insert into ${t} values (?,?,?)`, [i, payload(i), `memo-${i}`]);
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('B1: the next row’s prefetched blob costs zero round trips', async () => {
    // 2-row result set: after row 2's prefetch there is no further background
    // activity, so the round-trip counter isolates exactly this read.
    const it_ = db.queryStream(`select id, doc from ${t} where id <= 2 order by id`, [], { blobs: 'lazy', blobReadAhead: 1 })[Symbol.asyncIterator]();
    try {
      const r1 = (await it_.next()).value;
      expect((await (r1.DOC as Blob).buffer()).equals(payload(1))).toBe(true);
      await settle(); // row 2's prefetch finishes in the background
      const before = db.roundTrips;
      const r2 = (await it_.next()).value;
      const buf2 = await (r2.DOC as Blob).buffer();
      expect(buf2.equals(payload(2))).toBe(true);
      expect(db.roundTrips - before).toBe(0); // ← served entirely from prefetch
    } finally {
      await it_.return?.(undefined);
    }
  });

  it('B1b: without read-ahead the same read does cost round trips (control)', async () => {
    const it_ = db.queryStream(`select id, doc from ${t} order by id`, [], { blobs: 'lazy' })[Symbol.asyncIterator]();
    try {
      const r1 = (await it_.next()).value;
      await (r1.DOC as Blob).buffer();
      await settle();
      const before = db.roundTrips;
      const r2 = (await it_.next()).value;
      await (r2.DOC as Blob).buffer();
      expect(db.roundTrips - before).toBeGreaterThan(0);
    } finally {
      await it_.return?.(undefined);
    }
  });

  it('exporter loop: every blob correct, contents identical to eager', async () => {
    const seen: number[] = [];
    for await (const row of db.queryStream(`select id, doc, memo from ${t} order by id`, [], {
      blobs: 'lazy-binary',
      blobReadAhead: 2,
    })) {
      expect(row.MEMO).toBe(`memo-${row.ID}`); // lazy-binary keeps memos eager
      const buf = await (row.DOC as Blob).buffer();
      expect(buf.equals(payload(row.ID as number))).toBe(true);
      seen.push(row.ID as number);
      await settle(10); // simulate the fs write the prefetch overlaps
    }
    expect(seen).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it('B2: a blob over maxBytes still reads correctly (bounded memory, on-demand fallback)', async () => {
    // Budget smaller than one blob: at most one prefetch may overshoot; the
    // rest are served on demand — correctness is unchanged either way.
    for await (const row of db.queryStream(`select id, doc from ${t} where id <= 4 order by id`, [], {
      blobs: 'lazy',
      blobReadAhead: { depth: 2, maxBytes: 65_536 },
    })) {
      expect((await (row.DOC as Blob).buffer()).equals(payload(row.ID as number))).toBe(true);
    }
  });

  it('B3: breaking out mid-stream leaks nothing and keeps the connection usable', async () => {
    let count = 0;
    for await (const row of db.queryStream(`select id, doc from ${t} order by id`, [], { blobs: 'lazy', blobReadAhead: 3 })) {
      if (++count === 2) break; // prefetches for rows 2..5 are in flight/queued
      await (row.DOC as Blob).buffer();
    }
    await settle();
    // Same-connection work continues: full re-read gives correct bytes.
    const rows = await db.query(`select id, doc from ${t} where id = ${N}`);
    expect((rows[0]!.DOC as Buffer).equals(payload(N))).toBe(true);
  });

  it('B4: column filter — unlisted columns are never prefetched', async () => {
    const it_ = db.queryStream(`select id, doc, memo from ${t} where id <= 2 order by id`, [], {
      blobs: 'lazy',
      blobReadAhead: { columns: ['DOC'], depth: 1 },
    })[Symbol.asyncIterator]();
    try {
      const r1 = (await it_.next()).value;
      await (r1.DOC as Blob).buffer();
      await settle();
      const before = db.roundTrips;
      const r2 = (await it_.next()).value;
      await (r2.DOC as Blob).buffer(); // prefetched
      expect(db.roundTrips - before).toBe(0);
      await (r2.MEMO as Blob).text(); // NOT prefetched → costs wire work
      expect(db.roundTrips - before).toBeGreaterThan(0);
    } finally {
      await it_.return?.(undefined);
    }
  });

  it('out-of-order and repeated reads stay correct', async () => {
    const rows: Record<string, unknown>[] = [];
    await db.transaction(async (tx) => {
      for await (const row of tx.queryStream(`select id, doc from ${t} where id <= 6 order by id`, [], {
        blobs: 'lazy',
        blobReadAhead: 2,
      })) {
        rows.push(row); // defer all reads until after iteration (tx still open)
      }
      for (const row of [...rows].reverse()) {
        const buf = await (row.DOC as Blob).buffer();
        expect(buf.equals(payload(row.ID as number))).toBe(true);
        expect((await (row.DOC as Blob).buffer()).equals(buf)).toBe(true); // cached repeat
      }
    });
  });

  it('connection-level default applies; per-query false disables it', async () => {
    const conn = await connect({ ...FB_BASE, port, database: (db as any).options.database, blobs: 'lazy', blobReadAhead: 1 });
    try {
      // Default on: next-row blob free.
      const a = conn.queryStream(`select id, doc from ${t} where id <= 2 order by id`)[Symbol.asyncIterator]();
      const a1 = (await a.next()).value;
      await (a1.DOC as Blob).buffer();
      await settle();
      const before = conn.roundTrips;
      const a2 = (await a.next()).value;
      await (a2.DOC as Blob).buffer();
      expect(conn.roundTrips - before).toBe(0);
      await a.return?.(undefined);

      // Explicit false: back to on-demand.
      const b = conn.queryStream(`select id, doc from ${t} order by id`, [], { blobReadAhead: false })[Symbol.asyncIterator]();
      const b1 = (await b.next()).value;
      await (b1.DOC as Blob).buffer();
      await settle();
      const before2 = conn.roundTrips;
      const b2 = (await b.next()).value;
      await (b2.DOC as Blob).buffer();
      expect(conn.roundTrips - before2).toBeGreaterThan(0);
      await b.return?.(undefined);
    } finally {
      await conn.disconnect();
    }
  });

  it('prefetched blobs stream() from memory', async () => {
    const it_ = db.queryStream(`select id, doc from ${t} where id <= 2 order by id`, [], { blobs: 'lazy', blobReadAhead: 1 })[Symbol.asyncIterator]();
    try {
      const r1 = (await it_.next()).value;
      await (r1.DOC as Blob).buffer();
      await settle();
      const before = db.roundTrips;
      const r2 = (await it_.next()).value;
      const chunks: Buffer[] = [];
      for await (const c of (r2.DOC as Blob).stream()) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).equals(payload(2))).toBe(true);
      expect(db.roundTrips - before).toBe(0);
    } finally {
      await it_.return?.(undefined);
    }
  });
});
