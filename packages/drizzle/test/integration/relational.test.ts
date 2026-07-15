import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { desc, eq, relations } from 'drizzle-orm';
import type { Attachment } from '@fast-firebird/core';
import { drizzle, firebirdTable, integer, varchar } from '../../src/index.js';
import { FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

/**
 * Relational query API support boundary on Firebird:
 * - FLAT `findMany`/`findFirst` (columns/where/orderBy/limit/offset) compile
 *   to plain selects — supported.
 * - Nested `with:` needs Postgres JSON aggregation — rejected driver-side
 *   with guidance (use explicit joins).
 */
describe.each(FB_SERVERS)('relational queries on Firebird $version', ({ port, version }) => {
  let att: Attachment;

  const users = firebirdTable(`RQ_USERS_${version}`, {
    id: integer('ID').primaryKey(),
    name: varchar('NAME', { length: 40 }),
  });
  const posts = firebirdTable(`RQ_POSTS_${version}`, {
    id: integer('ID').primaryKey(),
    userId: integer('USER_ID'),
    title: varchar('TITLE', { length: 40 }),
  });
  const usersRelations = relations(users, ({ many }) => ({ posts: many(posts) }));
  const postsRelations = relations(posts, ({ one }) => ({
    user: one(users, { fields: [posts.userId], references: [users.id] }),
  }));
  const schema = { users, posts, usersRelations, postsRelations };

  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    att = await freshDb(port);
    db = drizzle(att, { schema });
    await ddl(att, `recreate table RQ_USERS_${version} (ID integer not null primary key, NAME varchar(40))`);
    await ddl(att, `recreate table RQ_POSTS_${version} (ID integer not null primary key, USER_ID integer, TITLE varchar(40))`);
    await att.execute(`insert into RQ_USERS_${version} values (1, 'Alice')`);
    await att.execute(`insert into RQ_USERS_${version} values (2, 'Bob')`);
    await att.execute(`insert into RQ_POSTS_${version} values (1, 1, 'Hello')`);
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await att?.dropDatabase();
  });

  it('flat findMany works (plain select)', async () => {
    const rows = await db.query.users.findMany({ orderBy: [desc(users.id)] });
    expect(rows).toEqual([
      { id: 2, name: 'Bob' },
      { id: 1, name: 'Alice' },
    ]);
  });

  it('flat findFirst with where/columns works', async () => {
    const row = await db.query.users.findFirst({
      where: eq(users.id, 1),
      columns: { name: true },
    });
    expect(row).toEqual({ name: 'Alice' });
  });

  it('findMany with limit/offset uses FIRST/SKIP', async () => {
    const rows = await db.query.users.findMany({ orderBy: [desc(users.id)], limit: 1, offset: 1 });
    expect(rows).toEqual([{ id: 1, name: 'Alice' }]);
  });

  it('`with:` fails fast with a clear driver-side error', async () => {
    // The SQL is built lazily inside QueryPromise.then, which throws
    // synchronously — adopt it inside a chain so it surfaces as a rejection.
    await expect(Promise.resolve().then(() => db.query.users.findMany({ with: { posts: true } }))).rejects.toThrow(
      /no JSON aggregation[\s\S]*explicit joins/,
    );
  });
});
