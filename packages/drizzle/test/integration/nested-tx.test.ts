import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Attachment } from '@fast-firebird/core';
import { drizzle, firebirdTable, integer, varchar, type FirebirdDatabase } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

describe.each(FB_SERVERS)('drizzle nested transactions (savepoints) on Firebird $version', ({ port, version }) => {
  let att: Attachment;
  let db: FirebirdDatabase<Record<string, never>>;

  const items = firebirdTable(`DZ_NEST_${version}`, {
    id: integer('ID').primaryKey(),
    val: varchar('VAL', { length: 20 }),
  });

  beforeAll(async () => {
    att = await freshDb(port);
    db = drizzle(att);
    await ddl(att, `recreate table DZ_NEST_${version} (ID integer not null primary key, VAL varchar(20))`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await att?.dropDatabase();
  });

  const allIds = async () => (await db.select({ id: items.id }).from(items).orderBy(items.id)).map((r) => r.id);

  it('nested tx.transaction rolls back only the inner scope on error', async () => {
    await db.transaction(async (tx) => {
      await tx.insert(items).values({ id: 1, val: 'outer' });
      await tx
        .transaction(async (inner) => {
          await inner.insert(items).values({ id: 2, val: 'inner' });
          throw new Error('undo inner');
        })
        .catch((e: Error) => expect(e.message).toBe('undo inner'));
      // Outer work is intact inside the same transaction.
      const seen = await tx.select({ id: items.id }).from(items);
      expect(seen).toEqual([{ id: 1 }]);
    });
    expect(await allIds()).toEqual([1]);
  });

  it('nested success commits together with the outer transaction', async () => {
    await db.transaction(async (tx) => {
      await tx.insert(items).values({ id: 10, val: 'outer' });
      await tx.transaction(async (inner) => {
        await inner.insert(items).values({ id: 11, val: 'inner' });
      });
    });
    expect(await allIds()).toEqual(expect.arrayContaining([10, 11]));
  });

  it('two levels of nesting keep independent scopes', async () => {
    await db.transaction(async (tx) => {
      await tx.insert(items).values({ id: 20, val: 'L1' });
      await tx.transaction(async (l2) => {
        await l2.insert(items).values({ id: 21, val: 'L2' });
        await l2
          .transaction(async (l3) => {
            await l3.insert(items).values({ id: 22, val: 'L3' });
            throw new Error('undo L3');
          })
          .catch(() => undefined);
      });
    });
    const got = await allIds();
    expect(got).toEqual(expect.arrayContaining([20, 21]));
    expect(got).not.toContain(22);
  });

  it('tx.rollback() in a nested scope undoes the inner work and propagates', async () => {
    await db.transaction(async (tx) => {
      await tx.insert(items).values({ id: 30, val: 'outer' });
      await tx
        .transaction(async (inner) => {
          await inner.insert(items).values({ id: 31, val: 'inner' });
          inner.rollback(); // drizzle-style: throws TransactionRollbackError
        })
        .catch(() => undefined);
      await tx.update(items).set({ val: 'kept' }).where(eq(items.id, 30));
    });
    expect(await allIds()).toContain(30);
    expect(await allIds()).not.toContain(31);
    const [row] = await db.select().from(items).where(eq(items.id, 30));
    expect(row!.val).toBe('kept');
  });
});
