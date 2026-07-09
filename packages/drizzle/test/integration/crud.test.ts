import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Attachment } from '@fast-firebird/core';
import { drizzle, firebirdTable, integer, varchar, boolean, type FirebirdDatabase } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

describe.each(FB_SERVERS)('drizzle CRUD on Firebird $version', ({ port, version }) => {
  let att: Attachment;
  let db: FirebirdDatabase<Record<string, never>>;

  // A distinct table name per server keeps the schema object simple while the
  // isolated database already prevents cross-file contention.
  const users = firebirdTable(`DZ_USERS_${version}`, {
    id: integer('ID').primaryKey(),
    name: varchar('NAME', { length: 60 }),
    age: integer('AGE'),
    active: boolean('ACTIVE'),
  });

  beforeAll(async () => {
    att = await freshDb(port);
    db = drizzle(att);
    await ddl(
      att,
      `recreate table DZ_USERS_${version} (
        ID integer not null primary key,
        NAME varchar(60),
        AGE integer,
        ACTIVE boolean
      )`,
    );
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await att?.dropDatabase();
  });

  it('inserts and selects rows', async () => {
    // Firebird has no multi-row VALUES; the dialect rewrites this batch to
    // INSERT … SELECT … UNION ALL SELECT … transparently.
    await db.insert(users).values([
      { id: 1, name: 'Alice é €', age: 30, active: true },
      { id: 2, name: 'Bob', age: 25, active: false },
      { id: 3, name: 'Carol', age: 42, active: true },
    ]);

    const all = await db.select().from(users).orderBy(users.id);
    expect(all).toEqual([
      { id: 1, name: 'Alice é €', age: 30, active: true },
      { id: 2, name: 'Bob', age: 25, active: false },
      { id: 3, name: 'Carol', age: 42, active: true },
    ]);
  });

  it('filters with where (eq/and/gte)', async () => {
    const rows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.active, true), gte(users.age, 35)));
    expect(rows).toEqual([{ id: 3, name: 'Carol' }]);
  });

  it('paginates with FIRST/SKIP (limit/offset)', async () => {
    const rows = await db.select({ id: users.id }).from(users).orderBy(users.id).limit(1).offset(1);
    expect(rows).toEqual([{ id: 2 }]);
  });

  it('updates with RETURNING', async () => {
    const returned = await db
      .update(users)
      .set({ age: 31 })
      .where(eq(users.id, 1))
      .returning({ id: users.id, age: users.age });
    expect(returned).toEqual([{ id: 1, age: 31 }]);
  });

  it('inserts a single row with RETURNING', async () => {
    const returned = await db
      .insert(users)
      .values({ id: 4, name: 'Dave', age: 50, active: true })
      .returning();
    expect(returned).toEqual([{ id: 4, name: 'Dave', age: 50, active: true }]);
  });

  it('deletes rows', async () => {
    await db.delete(users).where(eq(users.id, 4));
    const remaining = await db.select({ c: sql<number>`count(*)` }).from(users);
    expect(Number(remaining[0]!.c)).toBe(3);
  });

  it('commits a transaction', async () => {
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ id: 10, name: 'Tx', age: 1, active: true });
    });
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, 10));
    expect(rows).toEqual([{ id: 10 }]);
  });

  it('rolls back a transaction on throw', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(users).values({ id: 11, name: 'Nope', age: 1, active: true });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, 11));
    expect(rows).toEqual([]);
  });
});
