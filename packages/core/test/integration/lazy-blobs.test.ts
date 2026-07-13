import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, FirebirdBlobError, type Attachment, type Blob } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

describe.each(FB_SERVERS)('lazy blobs on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_LAZY_${version}`;
  const N = 40;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer, b1 blob, b2 blob, memo blob sub_type text)`);
    await db.transaction(async (tx) => {
      for (let i = 1; i <= N; i++) {
        await tx.execute(`insert into ${t} values (?,?,?,?)`, [
          i,
          Buffer.from(`B1-${i}`),
          Buffer.from(`B2-${i}`),
          `memo €-${i}`,
        ]);
      }
      // Big blob for abandoned-stream tests: must dwarf the Readable's 16KB
      // highWaterMark so an early break happens far from EOF.
      await tx.execute(`insert into ${t} (id, b1) values (?, ?)`, [500, Buffer.alloc(100_000, 0x42)]);
    });
  }, HOOK_TIMEOUT);

  /** Runtime peek at the wire's pending deferred-response counter. */
  const deferredCount = () => (db as unknown as { wire: { deferredResponses: number } }).wire.deferredResponses;

  /** Wait until `cond()` holds (the deferred close rides the async op-lock). */
  async function until(cond: () => boolean, ms = 500): Promise<void> {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
  }

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('non-null blobs become handles; unread ones cost zero round trips', async () => {
    await db.transaction(async (tx) => {
      const before = db.roundTrips;
      let read = 0;
      for await (const row of tx.queryStream(`select id, b1, b2, memo from ${t} where id <= ${N} order by id`, [], { blobs: 'lazy' })) {
        expect(typeof (row.MEMO as Blob).text).toBe('function'); // handle, not value
        expect(typeof (row.B1 as Blob).buffer).toBe('function');
        const memo = await (row.MEMO as Blob).text();
        expect(memo).toBe(`memo €-${row.ID}`);
        read++;
        // B1/B2 handles deliberately untouched
      }
      expect(read).toBe(N);
      const lazyRT = db.roundTrips - before;

      // Eager reads all four blob columns → materially more round trips.
      const before2 = db.roundTrips;
      await tx.query(`select id, b1, b2, memo from ${t} where id <= ${N} order by id`);
      const eagerRT = db.roundTrips - before2;
      expect(eagerRT).toBeGreaterThan(lazyRT * 1.5);
    });
  });

  it('NULL blob columns are null (no handle)', async () => {
    await db.execute(`insert into ${t} (id, b1, memo) values (?, ?, ?)`, [999, null, null]);
    await db.transaction(async (tx) => {
      for await (const row of tx.queryStream(`select b1, memo from ${t} where id = 999`, [], { blobs: 'lazy' })) {
        expect(row.B1).toBeNull();
        expect(row.MEMO).toBeNull();
      }
    });
    await db.execute(`delete from ${t} where id = 999`);
  });

  it('buffer() is cached (idempotent)', async () => {
    await db.transaction(async (tx) => {
      for await (const row of tx.queryStream(`select b1 from ${t} where id = 3`, [], { blobs: 'lazy' })) {
        const a = await (row.B1 as Blob).buffer();
        const b = await (row.B1 as Blob).buffer();
        expect(a.equals(b)).toBe(true);
        expect(a.toString()).toBe('B1-3');
      }
    });
  });

  it('streams a blob in backpressured chunks', async () => {
    await db.transaction(async (tx) => {
      for await (const row of tx.queryStream(`select b2 from ${t} where id = 7`, [], { blobs: 'lazy' })) {
        const chunks: Buffer[] = [];
        for await (const c of (row.B2 as Blob).stream({ chunkSize: 2 })) chunks.push(c as Buffer);
        expect(Buffer.concat(chunks).toString()).toBe('B2-7');
      }
    });
  });

  it('abandoning a stream mid-read closes the server handle (magic-number pattern)', async () => {
    await db.transaction(async (tx) => {
      const [row] = await tx.query(`select b1 from ${t} where id = 500`, [], { blobs: 'lazy' });
      const blob = row!.B1 as Blob;

      // Read just the head (e.g. sniffing a file's magic number), then bail.
      let head: Buffer | null = null;
      for await (const chunk of blob.stream({ chunkSize: 4096 })) {
        head = chunk as Buffer;
        break; // for-await break destroys the Readable mid-blob
      }
      expect(head!.length).toBeGreaterThan(0);
      expect(head![0]).toBe(0x42);

      // destroy() must queue exactly one deferred op_close_blob. The stream's
      // openBlob flush consumed every previously pending deferred response, so
      // mid-stream the counter is 0 and the abandon-close brings it to exactly
      // 1 (it rides the async op-lock, so poll briefly).
      await until(() => deferredCount() === 1);
      expect(deferredCount()).toBe(1);

      // The wire stays in sync: a full re-read and a plain query both work
      // (these also consume the deferred close's response FIFO).
      const full = await blob.buffer();
      expect(full.length).toBe(100_000);
      const [r2] = await tx.query(`select id from ${t} where id = 500`);
      expect(r2!.ID).toBe(500);
    });
  });

  it('destroying an unread stream is a no-op (no handle opened, no close sent)', async () => {
    await db.transaction(async (tx) => {
      const [row] = await tx.query(`select b1 from ${t} where id = 500`, [], { blobs: 'lazy' });
      const blob = row!.B1 as Blob;
      const before = deferredCount();
      const rs = blob.stream();
      rs.destroy();
      await new Promise((r) => setTimeout(r, 25));
      expect(deferredCount()).toBe(before); // nothing was opened → nothing to close
      expect((await blob.buffer()).length).toBe(100_000); // connection unaffected
    });
  });

  it('a stream error path also closes the handle and keeps the connection usable', async () => {
    let rs: Readable | undefined;
    await db.transaction(async (tx) => {
      const [row] = await tx.query(`select b1 from ${t} where id = 500`, [], { blobs: 'lazy' });
      rs = (row!.B1 as Blob).stream({ chunkSize: 4096 });
      // Start it, then let the tx close underneath — the next pull must
      // destroy the stream with FirebirdBlobError, not hang or desync.
      await new Promise<void>((resolve, reject) => {
        rs!.once('data', () => resolve());
        rs!.once('error', reject);
      });
      rs!.pause();
    });
    const err = await new Promise<Error>((resolve) => {
      rs!.once('error', resolve);
      rs!.resume();
    });
    expect(err).toBeInstanceOf(FirebirdBlobError);
    const [r] = await db.query(`select count(*) as C from ${t}`);
    expect(Number(r!.C)).toBeGreaterThan(0);
  });

  it('size() reports the blob length', async () => {
    await db.transaction(async (tx) => {
      for await (const row of tx.queryStream(`select memo from ${t} where id = 1`, [], { blobs: 'lazy' })) {
        expect(await (row.MEMO as Blob).size()).toBe(Buffer.byteLength('memo €-1'));
      }
    });
  });

  it('reading a handle after its transaction closed throws FirebirdBlobError', async () => {
    let stale: Blob | undefined;
    await db.transaction(async (tx) => {
      for await (const row of tx.queryStream(`select memo from ${t} where id = 1`, [], { blobs: 'lazy' })) {
        stale = row.MEMO as Blob;
      }
    });
    await expect(stale!.text()).rejects.toBeInstanceOf(FirebirdBlobError);
  });

  it('lazy works with tx.query (buffered, handles valid until commit)', async () => {
    await db.transaction(async (tx) => {
      const rows = await tx.query(`select id, memo from ${t} where id <= 3 order by id`, [], { blobs: 'lazy' });
      expect(rows).toHaveLength(3);
      const texts = await Promise.all(rows.map((r) => (r.MEMO as Blob).text()));
      expect(texts).toEqual(['memo €-1', 'memo €-2', 'memo €-3']);
    });
  });

  it('db.query with lazy blobs throws (auto-tx would invalidate handles)', async () => {
    await expect(db.query(`select memo from ${t}`, [], { blobs: 'lazy' })).rejects.toBeInstanceOf(FirebirdBlobError);
  });

  it('Readable.from streams lazy rows', async () => {
    await db.transaction(async (tx) => {
      const rs = Readable.from(tx.queryStream(`select id from ${t} where id <= 5 order by id`, []));
      const ids: number[] = [];
      for await (const r of rs) ids.push((r as { ID: number }).ID);
      expect(ids).toEqual([1, 2, 3, 4, 5]);
    });
  });
});

describe.each(FB_SERVERS)('column exclude/only on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_EXCL_${version}`;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer, name varchar(20), big blob)`);
    await db.execute(`insert into ${t} values (1, 'alice', ?)`, [Buffer.alloc(5000, 0x41)]);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('exclude drops columns from the row and skips blob materialization', async () => {
    await db.transaction(async (tx) => {
      const before = db.roundTrips;
      const [row] = await tx.query(`select id, name, big from ${t}`, [], { exclude: ['BIG'] });
      expect(Object.keys(row!)).toEqual(['ID', 'NAME']); // BIG dropped
      // No blob open/read happened for BIG.
      expect(db.roundTrips - before).toBeLessThanOrEqual(2);
    });
  });

  it('only keeps just the listed columns', async () => {
    const [row] = await db.query(`select id, name, big from ${t}`, [], { only: ['ID'] });
    expect(Object.keys(row!)).toEqual(['ID']);
  });
});
