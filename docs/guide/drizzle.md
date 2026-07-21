# Drizzle ORM adapter

`@fast-firebird/drizzle` plugs the driver into
[Drizzle ORM](https://orm.drizzle.team):

::: code-group

```sh [pnpm]
pnpm add @fast-firebird/core @fast-firebird/drizzle drizzle-orm
```

```sh [npm]
npm install @fast-firebird/core @fast-firebird/drizzle drizzle-orm
```

:::

```ts
import { connect } from '@fast-firebird/core';
import { drizzle, firebirdTable, integer, varchar, timestamp } from '@fast-firebird/drizzle';
import { eq } from 'drizzle-orm';

const users = firebirdTable('users', {
  id: integer('id').primaryKey(),
  name: varchar('name', { length: 40 }),
  created: timestamp('created'),
});

const orm = drizzle(await connect({ … }));
const rows = await orm.select().from(users).where(eq(users.id, 1));
```

Firebird is Postgres-shaped, so the adapter reuses Drizzle's pg-core query
builder with a Firebird dialect (parameter binding, `FIRST/SKIP` pagination,
`RETURNING`) and Firebird-correct date/time/blob column types. Nested
`tx.transaction()` works via savepoints. 88 integration tests against FB 3/4/5/6.

## Relational queries

Flat `db.query.users.findMany()`/`findFirst()`
(columns/where/orderBy/limit/offset) work — they compile to plain selects.
Nested `with:` is rejected with guidance: it requires JSON aggregation
functions Firebird doesn't have; use explicit joins instead.

## Migrations

drizzle-kit can't generate for Firebird, so the package ships a plain-SQL
migrator — `.sql` files applied in name order, recorded in a tracking table,
full isql syntax per file (incl. `SET TERM`/PSQL). Statements commit
individually (isql AUTODDL-style — Firebird DML can't see a table created in
the same uncommitted transaction), so keep migrations small and idempotent:

```ts
import { migrate } from '@fast-firebird/drizzle';
await migrate(orm, { migrationsFolder: './migrations' }); // 0001_init.sql, 0002_…
```

## Introspection → schema codegen

Generate a Drizzle schema from an existing database's RDB$ metadata (tables,
column types incl. NUMERIC precision/scale and blob subtypes, nullability,
single & composite primary keys):

```ts
import { introspectDatabase, generateDrizzleSchema } from '@fast-firebird/drizzle';
const tables = await introspectDatabase(att);
await fs.writeFile('schema.ts', generateDrizzleSchema(tables));
```
