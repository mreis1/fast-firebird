import { describe, expect, it } from 'vitest';
import { connect } from '../../src/index.js';
import { FB_BASE, FB_SERVERS } from './env.js';

describe.each(FB_SERVERS)('wire compression on Firebird $version', ({ port, version }) => {
  it('negotiates zlib compression and runs queries', async () => {
    const db = await connect({ ...FB_BASE, port, wireCompression: true, wireCrypt: 'disabled' });
    try {
      expect(db.wireCompressed).toBe(true);
      expect(db.wireEncrypted).toBe(false);
      const rows = await db.query('select 1 as a from rdb$database');
      expect(rows).toEqual([{ A: 1 }]);
    } finally {
      await db.disconnect();
    }
  });

  it('compression + Arc4 encryption together (compress-then-encrypt)', async () => {
    const db = await connect({ ...FB_BASE, port, wireCompression: true, wireCrypt: 'enabled' });
    try {
      expect(db.wireCompressed).toBe(true);
      expect(db.wireEncrypted).toBe(true);
      const rows = await db.query('select cast(? as varchar(30)) as v from rdb$database', ['crypt+zip €']);
      expect(rows).toEqual([{ V: 'crypt+zip €' }]);
    } finally {
      await db.disconnect();
    }
  });

  it('survives multi-batch fetches over a compressed stream', async () => {
    const db = await connect({ ...FB_BASE, port, wireCompression: true });
    try {
      const rows = await db.query(
        `select first 3000 cast(row_number() over() as integer) as i from rdb$types a, rdb$types b`,
      );
      expect(rows).toHaveLength(3000);
      expect(rows[2999]!.I).toBe(3000);
    } finally {
      await db.disconnect();
    }
  });

  it('round-trips blobs over a compressed encrypted wire', async () => {
    const db = await connect({ ...FB_BASE, port, wireCompression: true });
    try {
      await db.execute(`recreate table t_zip_${version} (id integer, data blob, note blob sub_type text)`);
      const payload = Buffer.alloc(200_000);
      for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
      const note = 'compressed blob text — ação €'.repeat(500);
      await db.execute(`insert into t_zip_${version} values (?,?,?)`, [1, payload, note]);
      const [r] = await db.query(`select data, note from t_zip_${version} where id = 1`);
      expect(Buffer.compare(r!.DATA as Buffer, payload)).toBe(0);
      expect(r!.NOTE).toBe(note);
    } finally {
      await db.disconnect();
    }
  });

  it('falls back gracefully when compression is not requested', async () => {
    const db = await connect({ ...FB_BASE, port });
    try {
      expect(db.wireCompressed).toBe(false);
    } finally {
      await db.disconnect();
    }
  });
});
