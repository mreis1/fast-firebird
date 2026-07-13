import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBlobs } from '../../src/protocol/blob.js';
import { type Attachment, type Blob } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');

/**
 * Part A of cross-blob pipelining: eager batch materialization overlaps
 * open/read/close ACROSS blobs on one connection — automatic, no API change.
 */
describe.each(FB_SERVERS)('cross-blob pipelining (eager) on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_XBLOB_${version}`;
  const N = 40;
  const expectedSha: Record<number, string> = {};
  const memoOf = (id: number) => `memo €-${id} — “ok”`;

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer not null primary key, memo blob sub_type text, bin blob)`);
    await db.transaction(async (tx) => {
      for (let i = 1; i <= N; i++) {
        // Deterministic per-row payload, multi-segment for a few of them.
        const size = i % 7 === 0 ? 200_000 : 3_000 + i;
        const bin = Buffer.alloc(size, i & 0xff);
        bin.writeInt32LE(i, 0);
        expectedSha[i] = sha1(bin);
        await tx.execute(`insert into ${t} values (?,?,?)`, [i, memoOf(i), bin]);
      }
      // A NULL-blob row must survive batch materialization untouched.
      await tx.execute(`insert into ${t} (id) values (?)`, [N + 1]);
    });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  it('A1: batch results are byte-identical to per-blob reads (correctness regression)', async () => {
    const rows = await db.query(`select id, memo, bin from ${t} order by id`);
    expect(rows).toHaveLength(N + 1);
    for (const r of rows.slice(0, N)) {
      const id = r.ID as number;
      expect(sha1(r.BIN as Buffer)).toBe(expectedSha[id]);
      expect(r.MEMO).toBe(memoOf(id)); // memos still charset-decoded strings
    }
    expect(rows[N]!.MEMO).toBeNull();
    expect(rows[N]!.BIN).toBeNull();
  });

  it('A2: overlapping beats one round trip per blob (flush budget)', async () => {
    // 40 rows × 2 blob columns = 80 blobs. Serial cost was ≥ 2 flushes per
    // blob (open + first window) ≈ 160+; overlapped, opens/windows/closes
    // coalesce into shared packets.
    const before = db.roundTrips;
    const rows = await db.query(`select memo, bin from ${t} where id <= ${N}`);
    const flushes = db.roundTrips - before;
    expect(rows).toHaveLength(N);
    expect(flushes).toBeLessThan(80); // < 1 flush per blob (serial: ~2/blob)
  });

  it('A3: an error mid-pipeline drains cleanly and keeps the connection usable', async () => {
    await db.transaction(async (tx) => {
      // Grab real ids via a lazy query, then poison the middle of the list.
      const rows = await tx.query(`select bin from ${t} where id <= 5 order by id`, [], { blobs: 'lazy' });
      const ids = rows.map((r) => ((r.BIN as Blob) as any).id as Buffer);
      const poisoned = [...ids.slice(0, 2), Buffer.alloc(8, 0xff), ...ids.slice(2)];
      const att = db as any;
      await expect(
        att.withLock(() => readBlobs(att.wire, (tx as any).handle, poisoned, 65535)),
      ).rejects.toThrow();
      // The wire must still be in sync: normal work continues on this tx.
      const [r] = await tx.query(`select count(*) as c from ${t}`);
      expect(Number(r!.C)).toBe(N + 1);
      const again = await tx.query(`select bin from ${t} where id = 1`);
      expect(sha1(again[0]!.BIN as Buffer)).toBe(expectedSha[1]);
    });
  });

  it('duplicate blob ids in one batch read independently', async () => {
    await db.transaction(async (tx) => {
      const [row] = await tx.query(`select bin from ${t} where id = 3`, [], { blobs: 'lazy' });
      const id = ((row!.BIN as Blob) as any).id as Buffer;
      const att = db as any;
      const [a, b] = await att.withLock(() => readBlobs(att.wire, (tx as any).handle, [id, id], 65535));
      expect(sha1(a)).toBe(expectedSha[3]);
      expect(a.equals(b)).toBe(true);
    });
  });
});
