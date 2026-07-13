import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, prefetchBlobs, type Attachment, type Blob } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

/**
 * FB 5.0.2+ inline blobs (protocol ≥ 19): blobs under the negotiated size
 * ride WITH the row data — small blob/memo reads cost zero round trips.
 * FB3/4 negotiate lower protocols and are asserted unaffected.
 */
describe.each(FB_SERVERS)('inline blobs on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_INLINE_${version}`;
  const N = 20;
  const SMALL = Buffer.alloc(4_000, 0x5a); // well under 64K → inlined on FB5
  const BIG = Buffer.alloc(200_000, 0x42); // over 64K → normal pipeline
  const fb5 = version === 5;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer not null primary key, doc blob, memo blob sub_type text, big blob)`);
    await db.transaction(async (tx) => {
      for (let i = 1; i <= N; i++) {
        const doc = Buffer.from(SMALL);
        doc.writeInt32LE(i, 0);
        await tx.execute(`insert into ${t} (id, doc, memo) values (?,?,?)`, [i, doc, `memo €-${i}`]);
      }
      await tx.execute(`insert into ${t} (id, doc, big) values (?,?,?)`, [100, SMALL, BIG]);
      await tx.execute(`insert into ${t} (id) values (?)`, [101]); // NULLs
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it(`negotiates protocol ${version === 5 ? 19 : version === 3 ? 15 : 16}`, () => {
    // FB3 tops out at P15, FB4 at P16 (we don't offer 17/18), FB 5.0.2+ at P19.
    expect(db.protocolVersion).toBe(version === 5 ? 19 : version === 3 ? 15 : 16);
  });

  it('eager fetch: small blobs cost (almost) no extra round trips on FB5', async () => {
    await db.transaction(async (tx) => {
      // Baseline: same rows, no blob columns.
      const b0 = db.roundTrips;
      await tx.query(`select id from ${t} where id <= ${N}`);
      const noBlobRT = db.roundTrips - b0;

      const b1 = db.roundTrips;
      const rows = await tx.query(`select id, doc, memo from ${t} where id <= ${N} order by id`);
      const withBlobsRT = db.roundTrips - b1;

      for (const r of rows) {
        const doc = r.DOC as Buffer;
        expect(doc.readInt32LE(0)).toBe(r.ID);
        expect(doc.length).toBe(SMALL.length);
        expect(r.MEMO).toBe(`memo €-${r.ID}`); // charset decode intact
      }
      if (fb5) {
        // 2×N blobs rode inline with the rows — no per-blob wire work.
        expect(withBlobsRT).toBeLessThanOrEqual(noBlobRT + 1);
      } else {
        expect(withBlobsRT).toBeGreaterThan(noBlobRT); // pre-P19 servers pay the pipeline
      }
    });
  });

  it('mixed row: big blob falls back to the normal pipeline, small stays inline', async () => {
    const [r] = await db.query(`select doc, big from ${t} where id = 100`);
    expect(sha1(r!.DOC as Buffer)).toBe(sha1(SMALL));
    expect(sha1(r!.BIG as Buffer)).toBe(sha1(BIG));
  });

  it('lazy handles: buffer()/text()/head()/stream() serve inline data with zero RTs (FB5)', async () => {
    await db.transaction(async (tx) => {
      const rows = await tx.query(`select id, doc, memo from ${t} where id <= 4 order by id`, [], { blobs: 'lazy' });
      const before = db.roundTrips;
      expect((await (rows[0]!.DOC as Blob).buffer()).readInt32LE(0)).toBe(1);
      expect(await (rows[1]!.MEMO as Blob).text()).toBe('memo €-2');
      expect((await (rows[2]!.DOC as Blob).head(8)).length).toBe(8);
      const chunks: Buffer[] = [];
      for await (const c of (rows[3]!.DOC as Blob).stream()) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).length).toBe(SMALL.length);
      if (fb5) expect(db.roundTrips - before).toBe(0);
      else expect(db.roundTrips - before).toBeGreaterThan(0);
    });
  });

  it('prefetchBlobs claims inline entries without wire work (FB5)', async () => {
    await db.transaction(async (tx) => {
      const rows = await tx.query(`select doc from ${t} where id <= ${N}`, [], { blobs: 'lazy' });
      const before = db.roundTrips;
      await prefetchBlobs(rows.map((r) => r.DOC as Blob));
      if (fb5) expect(db.roundTrips - before).toBe(0);
      for (const r of rows) expect(((await (r.DOC as Blob).buffer()) as Buffer).length).toBe(SMALL.length);
      if (fb5) expect(db.roundTrips - before).toBe(0);
    });
  });

  it('single-shot semantics: a re-read of the same id falls back to the wire, correctly', async () => {
    await db.transaction(async (tx) => {
      // Two lazy queries produce two handles for the SAME blob id: the first
      // read consumes the inline entry, the second goes over the wire.
      const [a] = await tx.query(`select doc from ${t} where id = 1`, [], { blobs: 'lazy' });
      const [b] = await tx.query(`select doc from ${t} where id = 1`, [], { blobs: 'lazy' });
      const bufA = await (a!.DOC as Blob).buffer();
      const bufB = await (b!.DOC as Blob).buffer();
      expect(bufA.equals(bufB)).toBe(true);
    });
  });

  it('maxInlineBlobSize: 0 disables the feature entirely', async () => {
    const conn = await connect({ ...FB_BASE, port, database: (db as any).options.database, maxInlineBlobSize: 0 });
    try {
      await conn.transaction(async (tx) => {
        const rows = await tx.query(`select id, doc from ${t} where id <= 3 order by id`, [], { blobs: 'lazy' });
        const before = conn.roundTrips;
        await (rows[0]!.DOC as Blob).buffer();
        expect(conn.roundTrips - before).toBeGreaterThan(0); // wire read even on FB5
      });
    } finally {
      await conn.disconnect();
    }
  });

  it('custom maxInlineBlobSize threshold is honored (FB5)', async () => {
    const conn = await connect({ ...FB_BASE, port, database: (db as any).options.database, maxInlineBlobSize: 1024 });
    try {
      await conn.transaction(async (tx) => {
        // 4 KB blob > 1 KB threshold → not inlined even on FB5.
        const rows = await tx.query(`select doc from ${t} where id = 1`, [], { blobs: 'lazy' });
        const before = conn.roundTrips;
        expect((await (rows[0]!.DOC as Blob).buffer()).length).toBe(SMALL.length);
        expect(conn.roundTrips - before).toBeGreaterThan(0);
      });
    } finally {
      await conn.disconnect();
    }
  });

  it('tiny maxBlobCacheSize: overflow blobs are dropped but reads stay correct', async () => {
    const conn = await connect({ ...FB_BASE, port, database: (db as any).options.database, maxBlobCacheSize: 5_000 });
    try {
      await conn.transaction(async (tx) => {
        const rows = await tx.query(`select id, doc from ${t} where id <= ${N} order by id`, [], { blobs: 'lazy' });
        for (const r of rows) {
          expect(((await (r.DOC as Blob).buffer()) as Buffer).readInt32LE(0)).toBe(r.ID);
        }
      });
    } finally {
      await conn.disconnect();
    }
  });

  it('inline cache is transaction-scoped: nothing lingers after commit', async () => {
    await db.transaction(async (tx) => {
      await tx.query(`select doc, memo from ${t} where id <= ${N}`, [], { blobs: 'lazy' }); // handles never read
    });
    const inline = (db as any).session.inline;
    if (fb5) expect(inline.size).toBe(0); // unread entries died with the tx
    // Connection stays healthy.
    const [r] = await db.query(`select count(*) as c from ${t}`);
    expect(Number(r!.C)).toBe(N + 2);
  });

  it('queryStream with blobReadAhead composes: inline entries satisfy the prefetcher', async () => {
    const seen: number[] = [];
    for await (const row of db.queryStream(`select id, doc from ${t} where id <= ${N} order by id`, [], {
      blobs: 'lazy',
      blobReadAhead: 2,
    })) {
      const buf = await (row.DOC as Blob).buffer();
      expect(buf.readInt32LE(0)).toBe(row.ID);
      seen.push(row.ID as number);
    }
    expect(seen).toHaveLength(N);
  });

  it('NULL blobs and expandStar/exclude still behave', async () => {
    const [r] = await db.query(`select doc, memo from ${t} where id = 101`);
    expect(r!.DOC).toBeNull();
    expect(r!.MEMO).toBeNull();
    const [x] = await db.query(`select * from ${t} where id = 1`, [], { expandStar: true, exclude: ['BIG'] });
    expect(Object.keys(x!)).toEqual(['ID', 'DOC', 'MEMO']);
    expect((x!.DOC as Buffer).length).toBe(SMALL.length);
  });
});
