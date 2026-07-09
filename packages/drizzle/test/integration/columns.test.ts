import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Attachment } from '@fast-firebird/core';
import {
  drizzle,
  firebirdTable,
  integer,
  numeric,
  doublePrecision,
  bigint,
  timestamp,
  date,
  time,
  blob,
  blobText,
  type FirebirdDatabase,
} from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

describe.each(FB_SERVERS)('drizzle Firebird column types on FB $version', ({ port, version }) => {
  let att: Attachment;
  let db: FirebirdDatabase<Record<string, never>>;

  const rows = firebirdTable(`DZ_TYPES_${version}`, {
    id: integer('ID').primaryKey(),
    price: numeric('PRICE', { precision: 9, scale: 2 }),
    ratio: doublePrecision('RATIO'),
    big: bigint('BIG', { mode: 'bigint' }),
    born: date('BORN'),
    wake: time('WAKE'),
    created: timestamp('CREATED'),
    payload: blob('PAYLOAD'),
    notes: blobText('NOTES'),
  });

  beforeAll(async () => {
    att = await freshDb(port);
    db = drizzle(att);
    await ddl(
      att,
      `recreate table DZ_TYPES_${version} (
        ID integer not null primary key,
        PRICE numeric(9,2),
        RATIO double precision,
        BIG bigint,
        BORN date,
        WAKE time,
        CREATED timestamp,
        PAYLOAD blob sub_type binary,
        NOTES blob sub_type text
      )`,
    );
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await att?.dropDatabase();
  });

  it('round-trips temporal, numeric, bigint and blob types', async () => {
    const born = new Date(1985, 2, 3);
    const wake = new Date(1970, 0, 1, 7, 30, 15, 250);
    const created = new Date(2024, 5, 15, 12, 34, 56, 789);
    const payload = Buffer.from([0, 1, 2, 250, 251, 252]);
    const notes = 'blob text with unicode: ação é € — ok';

    await db.insert(rows).values({
      id: 1,
      price: '1234.56',
      ratio: 0.5,
      big: 9007199254740993n,
      born,
      wake,
      created,
      payload,
      notes,
    });

    const [r] = await db.select().from(rows).where(eq(rows.id, 1));
    expect(r).toBeDefined();
    expect(Number(r!.price)).toBe(1234.56);
    expect(r!.ratio).toBe(0.5);
    expect(r!.big).toBe(9007199254740993n);
    expect((r!.born as Date).getFullYear()).toBe(1985);
    expect((r!.born as Date).getMonth()).toBe(2);
    const w = r!.wake as Date;
    expect([w.getHours(), w.getMinutes(), w.getSeconds(), w.getMilliseconds()]).toEqual([7, 30, 15, 250]);
    expect((r!.created as Date).toISOString()).toBe(created.toISOString());
    expect(Buffer.isBuffer(r!.payload)).toBe(true);
    expect(Buffer.compare(r!.payload as Buffer, payload)).toBe(0);
    expect(r!.notes).toBe(notes);
  });

  it('reports the correct Firebird SQL types', () => {
    expect(rows.born.getSQLType()).toBe('date');
    expect(rows.wake.getSQLType()).toBe('time');
    expect(rows.created.getSQLType()).toBe('timestamp');
    expect(rows.payload.getSQLType()).toBe('blob sub_type binary');
    expect(rows.notes.getSQLType()).toBe('blob sub_type text');
  });
});
