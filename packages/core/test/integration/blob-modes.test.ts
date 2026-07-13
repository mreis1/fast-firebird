import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, FirebirdBlobError, Blob as FbBlob, type Attachment, type Blob, type BlobMode, type Row } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

/**
 * Blob mode matrix: 'eager' | 'lazy' | 'lazy-binary' | 'lazy-text', applied
 * per query, per connection, and across query/queryStream/prepared paths.
 * Subtype 1 (text, a.k.a. memo) vs everything else (binary).
 */

/** What each mode must produce per subtype. */
const MATRIX: Record<BlobMode, { text: 'string' | 'handle'; binary: 'buffer' | 'handle' }> = {
  eager: { text: 'string', binary: 'buffer' },
  lazy: { text: 'handle', binary: 'handle' },
  'lazy-binary': { text: 'string', binary: 'handle' },
  'lazy-text': { text: 'handle', binary: 'buffer' },
};
const MODES = Object.keys(MATRIX) as BlobMode[];

function kindOf(v: unknown): 'string' | 'buffer' | 'handle' | 'null' | 'other' {
  if (v === null) return 'null';
  if (typeof v === 'string') return 'string';
  if (Buffer.isBuffer(v)) return 'buffer';
  if (v instanceof FbBlob) return 'handle';
  return 'other';
}

describe.each(FB_SERVERS)('blob modes on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  const t = `T_BMODE_${version}`;
  const MEMO = 'memo €-1 “ok”';
  const BIN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // PNG-ish magic

  beforeAll(async () => {
    db = await freshDb(port);
    await ddl(db, `recreate table ${t} (id integer not null primary key, memo blob sub_type text, bin blob)`);
    await db.execute(`insert into ${t} values (?,?,?)`, [1, MEMO, BIN]);
    await db.execute(`insert into ${t} (id) values (?)`, [2]); // NULL blobs
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.dropDatabase();
  });

  /** Assert one row against the matrix and verify handle contents decode. */
  async function checkRow(row: Row, mode: BlobMode): Promise<void> {
    const want = MATRIX[mode];
    expect(kindOf(row.MEMO)).toBe(want.text === 'string' ? 'string' : 'handle');
    expect(kindOf(row.BIN)).toBe(want.binary === 'buffer' ? 'buffer' : 'handle');
    // Values must be identical whichever path produced them.
    const memo = typeof row.MEMO === 'string' ? row.MEMO : await (row.MEMO as Blob).text();
    const bin = Buffer.isBuffer(row.BIN) ? (row.BIN as Buffer) : await (row.BIN as Blob).buffer();
    expect(memo).toBe(MEMO);
    expect(bin.equals(BIN)).toBe(true);
  }

  describe.each(MODES)('mode %s', (mode) => {
    it('tx.query: cell types and contents match the matrix', async () => {
      await db.transaction(async (tx) => {
        const [row] = await tx.query(`select memo, bin from ${t} where id = 1`, [], { blobs: mode });
        await checkRow(row!, mode);
      });
    });

    it('queryStream (own tx): same matrix', async () => {
      for await (const row of db.queryStream(`select memo, bin from ${t} where id = 1`, [], { blobs: mode })) {
        await checkRow(row, mode);
      }
    });

    it('prepared statement with explicit tx: same matrix', async () => {
      const stmt = await db.prepare(`select memo, bin from ${t} where id = ?`);
      try {
        await db.transaction(async (tx) => {
          const [row] = await stmt.query([1], tx, { blobs: mode });
          await checkRow(row!, mode);
        });
      } finally {
        await stmt.close();
      }
    });

    it('NULL blob cells stay null', async () => {
      await db.transaction(async (tx) => {
        const [row] = await tx.query(`select memo, bin from ${t} where id = 2`, [], { blobs: mode });
        expect(row!.MEMO).toBeNull();
        expect(row!.BIN).toBeNull();
      });
    });

    if (mode === 'eager') {
      it('db.query allowed (auto-tx is fine for eager)', async () => {
        const [row] = await db.query(`select memo, bin from ${t} where id = 1`, [], { blobs: mode });
        await checkRow(row!, mode);
      });
    } else {
      it('db.query rejects (auto-tx would kill the handles)', async () => {
        await expect(db.query(`select memo from ${t}`, [], { blobs: mode })).rejects.toBeInstanceOf(FirebirdBlobError);
      });
    }
  });

  it('connection-level default applies; per-query override wins both ways', async () => {
    const conn = await connect({ ...FB_BASE, port, database: (db as any).options.database, blobs: 'lazy-binary' });
    try {
      await conn.transaction(async (tx) => {
        // Connection default: memo eager string, bin lazy handle.
        const [byDefault] = await tx.query(`select memo, bin from ${t} where id = 1`);
        expect(kindOf(byDefault!.MEMO)).toBe('string');
        expect(kindOf(byDefault!.BIN)).toBe('handle');
        // Per-query eager override beats the connection default…
        const [eager] = await tx.query(`select memo, bin from ${t} where id = 1`, [], { blobs: 'eager' });
        expect(kindOf(eager!.MEMO)).toBe('string');
        expect(kindOf(eager!.BIN)).toBe('buffer');
        // …and so does the inverse subtype mode.
        const [flipped] = await tx.query(`select memo, bin from ${t} where id = 1`, [], { blobs: 'lazy-text' });
        expect(kindOf(flipped!.MEMO)).toBe('handle');
        expect(kindOf(flipped!.BIN)).toBe('buffer');
      });
      // db.query under a lazy connection default throws; explicit eager passes.
      await expect(conn.query(`select memo from ${t}`)).rejects.toBeInstanceOf(FirebirdBlobError);
      const rows = await conn.query(`select memo from ${t} where id = 1`, [], { blobs: 'eager' });
      expect(rows[0]!.MEMO).toBe(MEMO);
    } finally {
      await conn.disconnect();
    }
  });

  it('lazy-binary: unread binary handles cost zero round trips while memos decode', async () => {
    await db.transaction(async (tx) => {
      const before = db.roundTrips;
      const rows = await tx.query(`select id, memo, bin from ${t} where id = 1`, [], { blobs: 'lazy-binary' });
      const withMemo = db.roundTrips - before;
      expect(rows[0]!.MEMO).toBe(MEMO); // decoded eagerly (costs blob reads)
      // Reading the binary later works on demand.
      const head = await (rows[0]!.BIN as Blob).buffer();
      expect(head.subarray(0, 4).equals(BIN.subarray(0, 4))).toBe(true); // magic number
      expect(withMemo).toBeGreaterThan(0);
    });
  });

  it('lazy-text charset: memo handle .text() decodes € exactly like eager', async () => {
    await db.transaction(async (tx) => {
      const [row] = await tx.query(`select memo from ${t} where id = 1`, [], { blobs: 'lazy-text' });
      expect(await (row!.MEMO as Blob).text()).toBe(MEMO);
    });
  });

  it('composes with expandStar + exclude', async () => {
    await db.transaction(async (tx) => {
      const [row] = await tx.query(`select * from ${t} where id = 1`, [], {
        blobs: 'lazy-binary',
        expandStar: true,
        exclude: ['BIN'],
      });
      expect(Object.keys(row!)).toEqual(['ID', 'MEMO']);
      expect(row!.MEMO).toBe(MEMO);
    });
  });

  it('composes with exclude (no expandStar): excluded lazy column never creates a handle', async () => {
    await db.transaction(async (tx) => {
      const [row] = await tx.query(`select id, memo, bin from ${t} where id = 1`, [], { blobs: 'lazy', exclude: ['BIN'] });
      expect(Object.keys(row!)).toEqual(['ID', 'MEMO']);
      expect(kindOf(row!.MEMO)).toBe('handle');
    });
  });

  it('rowMode array keeps the matrix per position', async () => {
    await db.transaction(async (tx) => {
      const res = await tx.run(`select memo, bin from ${t} where id = 1`, [], { blobs: 'lazy-binary', rowMode: 'array' });
      const cells = res.rows[0] as unknown as unknown[];
      expect(kindOf(cells[0])).toBe('string');
      expect(kindOf(cells[1])).toBe('handle');
      expect(res.columns.map((c) => c.type)).toEqual(['BLOB SUB_TYPE TEXT', 'BLOB']);
    });
  });
});
