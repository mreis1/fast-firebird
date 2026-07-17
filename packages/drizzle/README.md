# @fast-firebird/drizzle

[Drizzle ORM](https://orm.drizzle.team) dialect and driver for **Firebird 3/4/5**,
powered by [`@fast-firebird/core`](https://www.npmjs.com/package/@fast-firebird/core)
— pure TypeScript, zero native dependencies.

```ts
import { connect } from '@fast-firebird/core';
import { drizzle, firebirdTable, integer, varchar } from '@fast-firebird/drizzle';
import { eq } from 'drizzle-orm';

const users = firebirdTable('USERS', {
  id: integer('ID').primaryKey(),
  name: varchar('NAME', { length: 50 }),
});

const db = drizzle(await connect({ /* … */ }));

const rows = await db.select().from(users).where(eq(users.id, 1)).limit(10);
```

## What works

- **Query builder** — select/insert/update/delete, joins, `RETURNING`,
  `limit`/`offset` translated to Firebird's `FIRST`/`SKIP`, multi-row inserts.
- **All Firebird column types** — including blobs (`blob`/`blobText`),
  timestamps, `DECFLOAT`, `INT128`.
- **Transactions** — `db.transaction()`, with nested transactions mapped to
  Firebird savepoints.
- **Migrations** — a plain-SQL migrator (`migrate(db, { migrationsFolder })`):
  lexicographic `.sql` files, per-statement commits (AUTODDL-style), tracked in
  a migrations table. drizzle-kit's generators are closed to third-party
  dialects, so migrations are hand-written SQL — which Firebird DBAs tend to
  prefer anyway.
- **Introspection** — `introspectDatabase()` reads the RDB$ system tables and
  `generateDrizzleSchema()` emits a ready-to-use schema file from an existing
  database.
- **Relational queries** — flat `db.query.<table>.findMany()/findFirst()` work;
  nested `with:` is rejected with a guidance error (Firebird has no JSON
  aggregation — planned via client-side decomposition, tracked in the repo).

## Documentation

Full documentation and examples:
**[github.com/mreis1/fast-firebird](https://github.com/mreis1/fast-firebird)**

## License

MIT
