import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FirebirdError, type Attachment, type Blob } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

/**
 * Blob write streaming (deferred backlog #6): Readable / AsyncIterable
 * sources bound directly as BLOB parameters — uploaded segment-by-segment,
 * never buffering the whole value in the driver.
 */
describe.each(FB_SERVERS)('blob write streaming on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_WSTREAM_${version}`;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer not null primary key, doc blob, memo blob sub_type text)`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  /** Deterministic payload split into awkward chunk sizes. */
  function chunked(total: number, chunkSizes: number[]): { chunks: Buffer[]; whole: Buffer } {
    const whole = Buffer.alloc(total);
    for (let i = 0; i < total; i++) whole[i] = (i * 13) & 0xff;
    const chunks: Buffer[] = [];
    let off = 0;
    let k = 0;
    while (off < total) {
      const n = Math.min(chunkSizes[k++ % chunkSizes.length]!, total - off);
      chunks.push(whole.subarray(off, off + n));
      off += n;
    }
    return { chunks, whole };
  }

  it('async generator source: odd chunk sizes re-framed correctly (1 MB)', async () => {
    const { chunks, whole } = chunked(1_000_000, [1, 7_000, 65_535, 100_000, 3]);
    async function* gen() {
      for (const c of chunks) yield c;
    }
    await db.execute(`insert into ${t} (id, doc) values (?, ?)`, [1, gen()]);
    const [r] = await db.query(`select doc from ${t} where id = 1`);
    expect(sha1(r!.DOC as Buffer)).toBe(sha1(whole));
  });

  it('Node Readable source (fs-stream shape) round-trips', async () => {
    const { chunks, whole } = chunked(300_000, [16_384]); // fs default-ish chunks
    await db.execute(`insert into ${t} (id, doc) values (?, ?)`, [2, Readable.from(chunks)]);
    const [r] = await db.query(`select doc from ${t} where id = 2`);
    expect((r!.DOC as Buffer).equals(whole)).toBe(true);
  });

  it('string-yielding source into a memo goes through the charset codec', async () => {
    async function* words() {
      yield 'streamed ';
      yield 'memo — ';
      yield '€ works';
    }
    await db.execute(`insert into ${t} (id, memo) values (?, ?)`, [3, words()]);
    const [r] = await db.query(`select memo from ${t} where id = 3`);
    expect(r!.MEMO).toBe('streamed memo — € works');
  });

  it('empty source yields an empty (non-NULL) blob', async () => {
    async function* empty() {
      /* nothing */
    }
    await db.execute(`insert into ${t} (id, doc) values (?, ?)`, [4, empty()]);
    const [r] = await db.query(`select doc, char_length(doc) as len from ${t} where id = 4`);
    expect(r!.DOC).not.toBeNull();
    expect((r!.DOC as Buffer).length).toBe(0);
  });

  it('a source that throws mid-stream fails the statement and keeps the connection usable', async () => {
    async function* boom() {
      yield Buffer.alloc(70_000, 0xaa);
      throw new Error('disk read failed');
    }
    await expect(db.execute(`insert into ${t} (id, doc) values (?, ?)`, [5, boom()])).rejects.toThrow('disk read failed');
    // Connection still in sync; the failed row never landed.
    const rows = await db.query(`select id from ${t} where id = 5`);
    expect(rows).toHaveLength(0);
    const [ok] = await db.query(`select count(*) as c from ${t}`);
    expect(Number(ok!.C)).toBeGreaterThan(0);
  });

  it('streaming into a non-BLOB column throws a clear error', async () => {
    async function* g() {
      yield Buffer.from('x');
    }
    await expect(db.execute(`insert into ${t} (id, doc) values (?, ?)`, [g() as never, Buffer.from('y')])).rejects.toThrow(
      /only valid for BLOB/,
    );
  });

  it('binding a lazy Blob handle directly is rejected with guidance (deadlock guard)', async () => {
    await db.transaction(async (tx) => {
      const [src] = await tx.query(`select doc from ${t} where id = 1`, [], { blobs: 'lazy' });
      await expect(tx.execute(`insert into ${t} (id, doc) values (?, ?)`, [6, src!.DOC as never])).rejects.toThrow(
        /await blob\.buffer\(\)/,
      );
      // The documented way works: materialize, then bind.
      const bytes = await (src!.DOC as Blob).buffer();
      await tx.execute(`insert into ${t} (id, doc) values (?, ?)`, [6, bytes]);
      const [r] = await tx.query(`select doc from ${t} where id = 6`);
      expect(sha1(r!.DOC as Buffer)).toBe(sha1(bytes));
    });
  });

  it('two streaming params in one statement, inside an explicit tx', async () => {
    const { chunks, whole } = chunked(150_000, [10_000]);
    async function* bin() {
      for (const c of chunks) yield c;
    }
    async function* memo() {
      yield 'two-stream';
    }
    await db.transaction(async (tx) => {
      await tx.execute(`insert into ${t} (id, doc, memo) values (?, ?, ?)`, [7, bin(), memo()]);
    });
    const [r] = await db.query(`select doc, memo from ${t} where id = 7`);
    expect((r!.DOC as Buffer).equals(whole)).toBe(true);
    expect(r!.MEMO).toBe('two-stream');
  });

  it('backpressure shape: a slow source still lands intact', async () => {
    const { chunks, whole } = chunked(200_000, [50_000]);
    async function* slow() {
      for (const c of chunks) {
        await new Promise((r) => setTimeout(r, 5));
        yield c;
      }
    }
    await db.execute(`insert into ${t} (id, doc) values (?, ?)`, [8, slow()]);
    const [r] = await db.query(`select doc from ${t} where id = 8`);
    expect(sha1(r!.DOC as Buffer)).toBe(sha1(whole));
  });
});
