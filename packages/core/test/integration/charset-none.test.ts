import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { connect, createDatabase, type Attachment, type Blob } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT } from './env.js';

/**
 * The legacy-Delphi scenario this driver exists for: databases declared
 * CHARSET NONE whose bytes are really Windows-1252 (€, smart quotes, em
 * dashes), written by software that predates sane charset handling.
 */
describe.each(FB_SERVERS)('CHARSET NONE legacy win1252 on Firebird $version', ({ port, version }) => {
  const dbPath = `/var/lib/firebird/data/none_legacy_${version}.fdb`;
  const WIN1252_ONLY = 'Preço: 100€ — “ótimo” d’água';

  beforeAll(async () => {
    const db = await createDatabase({ ...FB_BASE, port, database: dbPath, charset: 'NONE' });
    await db.execute(`create table history (
      id integer not null primary key,
      memo varchar(120),
      long_memo blob sub_type text
    )`);
    await db.disconnect();
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    const db = await connect({ ...FB_BASE, port, database: dbPath, charset: 'NONE' });
    await db.dropDatabase();
  });

  function connectLegacy(extra: Record<string, unknown> = {}): Promise<Attachment> {
    return connect({ ...FB_BASE, port, database: dbPath, charset: 'NONE', charsetNoneEncoding: 'win1252', ...extra });
  }

  it('round-trips win1252-only characters through charsetNoneEncoding', async () => {
    const db = await connectLegacy();
    try {
      await db.execute('insert into history (id, memo, long_memo) values (?,?,?)', [1, WIN1252_ONLY, WIN1252_ONLY]);
      const [r] = await db.query('select memo, long_memo from history where id = 1');
      expect(r!.MEMO).toBe(WIN1252_ONLY);
      expect(r!.LONG_MEMO).toBe(WIN1252_ONLY);
    } finally {
      await db.disconnect();
    }
  });

  it('stored bytes really are single-byte win1252 (verified via raw connection)', async () => {
    // A NONE connection without decoding config sees byte-preserving latin1.
    const db = await connect({ ...FB_BASE, port, database: dbPath, charset: 'NONE' });
    try {
      const [r] = await db.query('select memo from history where id = 1');
      const raw = Buffer.from(r!.MEMO as string, 'latin1');
      expect(raw.includes(0x80)).toBe(true); // € as the single win1252 byte
      expect(iconv.decode(raw, 'win1252')).toBe(WIN1252_ONLY);
    } finally {
      await db.disconnect();
    }
  });

  it('matches rows by win1252 parameter (WHERE memo LIKE %€%)', async () => {
    const db = await connectLegacy();
    try {
      const rows = await db.query("select id from history where memo like ?", ['%€%']);
      expect(rows).toEqual([{ ID: 1 }]);
    } finally {
      await db.disconnect();
    }
  });

  it('supports the node-firebird2 transcodeAdapter contract', async () => {
    const db = await connect({
      ...FB_BASE,
      port,
      database: dbPath,
      charset: 'NONE',
      transcodeAdapter: {
        text: {
          fromDb: (buffer) => iconv.decode(buffer, 'win1252'),
          toDb: (value) => iconv.encode(value, 'win1252'),
        },
      },
    });
    try {
      await db.execute('insert into history (id, memo) values (?,?)', [2, 'adapter: €—”']);
      const [r] = await db.query('select memo from history where id = 2');
      expect(r!.MEMO).toBe('adapter: €—”');
    } finally {
      await db.disconnect();
    }
  });

  it('decodes a lazy text blob (memo) through charsetNoneEncoding', async () => {
    const db = await connectLegacy();
    try {
      await db.transaction(async (tx) => {
        const [r] = await tx.query('select long_memo from history where id = 1', [], { blobs: 'lazy' });
        // Blob.text() must use the same win1252 codec the eager path uses.
        expect(await (r!.LONG_MEMO as Blob).text()).toBe(WIN1252_ONLY);
      });
    } finally {
      await db.disconnect();
    }
  });

  it('supports charsetOverrides on a text blob column', async () => {
    const db = await connect({
      ...FB_BASE,
      port,
      database: dbPath,
      charset: 'NONE',
      charsetOverrides: { 'HISTORY.LONG_MEMO': 'win1252' },
    });
    try {
      const [r] = await db.query('select long_memo from history where id = 1');
      expect(r!.LONG_MEMO).toBe(WIN1252_ONLY);
    } finally {
      await db.disconnect();
    }
  });

  it('supports field-level charsetOverrides', async () => {
    const db = await connect({
      ...FB_BASE,
      port,
      database: dbPath,
      charset: 'NONE',
      charsetOverrides: { 'HISTORY.MEMO': 'win1252' },
    });
    try {
      const [r] = await db.query('select memo from history where id = 1');
      expect(r!.MEMO).toBe(WIN1252_ONLY);
    } finally {
      await db.disconnect();
    }
  });
});
