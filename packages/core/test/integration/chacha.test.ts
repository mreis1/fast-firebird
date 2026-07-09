import { describe, expect, it } from 'vitest';
import { connect } from '../../src/index.js';
import { FB_BASE, FB_SERVERS } from './env.js';

const FB45 = FB_SERVERS.filter((s) => s.version >= 4);

describe.each(FB45)('ChaCha wire crypt on Firebird $version', ({ port }) => {
  for (const plugin of ['ChaCha', 'ChaCha64'] as const) {
    it(`negotiates ${plugin} and round-trips data`, async () => {
      const db = await connect({ ...FB_BASE, port, wireCryptPlugin: plugin });
      try {
        expect(db.wireEncrypted).toBe(true);
        expect(db.wireCryptPlugin).toBe(plugin);
        // Payload spanning many keystream blocks + unicode (VARCHAR max is
        // 8191 bytes for single-byte, fewer for UTF8; keep well under).
        const big = 'ação €—" '.repeat(150);
        const [r] = await db.query('select cast(? as varchar(2000)) as v from rdb$database', [big]);
        expect(r!.V).toBe(big);
        // Multi-batch fetch keeps the cipher stream in sync.
        const rows = await db.query('select first 2000 cast(row_number() over() as integer) i from rdb$types a, rdb$types b');
        expect(rows).toHaveLength(2000);
      } finally {
        await db.disconnect();
      }
    });
  }

  it('ChaCha survives blob round-trips', async () => {
    const db = await connect({ ...FB_BASE, port, wireCryptPlugin: 'ChaCha' });
    try {
      await db.execute('recreate table t_cc_blob (id integer, data blob)');
      const payload = Buffer.alloc(120_000);
      for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
      await db.execute('insert into t_cc_blob values (?, ?)', [1, payload]);
      const [r] = await db.query('select data from t_cc_blob where id = 1');
      expect(Buffer.compare(r!.DATA as Buffer, payload)).toBe(0);
    } finally {
      await db.disconnect();
    }
  });
});

describe('ChaCha unavailable on Firebird 3', () => {
  const fb3 = FB_SERVERS.find((s) => s.version === 3)!;
  it('reports a clear error rather than hanging or corrupting', async () => {
    const err = await connect({ ...FB_BASE, port: fb3.port, wireCryptPlugin: 'ChaCha' }).catch((e) => e);
    expect(String(err.message)).toMatch(/did not advertise a ChaCha IV|Arc4/);
  });

  it('Arc4 still works on FB3', async () => {
    const db = await connect({ ...FB_BASE, port: fb3.port });
    try {
      expect(db.wireCryptPlugin).toBe('Arc4');
      expect(db.wireEncrypted).toBe(true);
    } finally {
      await db.disconnect();
    }
  });
});
