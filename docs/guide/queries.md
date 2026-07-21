# Queries & parameters

## `run` and its shortcuts (`query`, `queryOne`, `execute`)

There is **one** execution primitive — `run()` — that works for any statement
(SELECT, INSERT/UPDATE/DELETE, DDL) and returns everything the server reported:

```ts
const { rows, rowsAffected, columns } = await db.run('update t set x = 1 where y = ?', [2]);
```

`query`, `queryOne`, and `execute` are thin, typed shortcuts over `run()` — they
run the exact same call and just project the field you asked for, with a return
type to match. Reach for the shortcut that fits; drop to `run()` when you want
more than one field back:

```ts
// Each is `async` — await it; the arrow shows what it resolves to.
db.run(sql, p)       // → { rows, rowsAffected, columns }   (the primitive)
db.query(sql, p)     // → run().rows            : Row[]
db.queryOne(sql, p)  // → run().rows[0]         : Row | undefined
db.execute(sql, p)   // → run().rowsAffected    : number
```

```ts
const rows = await db.query('select id, name from users');               // Row[]
const user = await db.queryOne('select * from users where id = ?', [7]); // Row | undefined
const n    = await db.execute('delete from log where created < ?', [cutoff]); // number

// Compile-time row typing (no runtime validation) flows through the shortcut:
interface User { ID: number; NAME: string }
const typed = await db.query<User>('select id, name from users');
typed[0].NAME; // string
```

`queryOne` returns the first row or `undefined` — the full result set is still
fetched, so add `FIRST 1` (or a unique predicate) when many rows could match.
`execute` ignores any rows a statement produces, so use it for writes/DDL where
you only care about the affected count. All four take the same
`(sql, params, options)` shape and the same positional-or-named parameters
(below). The pool exposes the same `query`/`queryOne`/`run`/`execute` set, each
acquiring a connection for the single call.

## Named parameters (`@name`)

Pass an **object** instead of an array and mark placeholders with `@name`. The
driver rewrites `@name` to positional `?` and reorders the values client-side —
so the object key order is irrelevant, and a name repeated in the SQL is bound
in every slot it appears:

```ts
const rows = await db.query(
  'select * from emp where dept = @dept and sal > @min',
  { dept: 10, min: 5000 },
);

// Works everywhere params do — execute, streams, prepared statements, the pool:
await db.execute('update emp set name = @name where id = @id', { name: 'Ann', id: 1 });

const stmt = await db.prepare('select * from emp where dept = @dept');
await stmt.query({ dept: 10 });   // re-run with different objects
```

::: tip Why `@name` and not `:name`?
A leading colon (`:var`) is a **PSQL local-variable reference** in Firebird —
`@name` has no meaning anywhere in the SQL/PSQL grammar, so it's unambiguous
even inside an `EXECUTE BLOCK` body.
:::

Markers inside string literals, quoted identifiers, `q'{…}'` literals and
comments are left untouched. Positional `?` + array params keep working
unchanged; mixing a named object with `?`-only SQL throws a `FirebirdParamError`.

## Column metadata & array rows

Every `run()`/`QueryResult` carries `columns: ColumnInfo[]` — the row key
(alias-aware), underlying field, source relation, friendly SQL type name, and
nullability, exactly as the columns appear in the rows:

```ts
const { rows, columns } = await db.run('select * from invoices', [], { rowMode: 'array' });
// columns[i].name is the positional header for rows[n][i]
```

`rowMode: 'array'` preserves duplicate/aliased column names positionally —
intended for ORM adapters and grid UIs.

## Column filtering & `select *` expansion

```ts
await db.query('select * from docs', [], { exclude: ['PHOTO'] });   // or { only: [...] }
await db.query('select * from docs', [], { exclude: ['PHOTO'], expandStar: true });
```

Without `expandStar`, `exclude`/`only` filter at decode time (blob columns are
then never fetched, scalars still cross the wire). With `expandStar: true` the
driver rewrites top-level `*` / `alias.*` / `table.*` into an explicit column
list *before* preparing, so excluded columns are genuinely never sent by the
server. Rewrites cost one extra prepare per unique (sql, only, exclude), are
cached, and are invalidated by DDL. Top-level `UNION` is not supported, and
Firebird itself rejects a bare `*` mixed with other select items — qualify it
(`select t.*, 1 as x from t`).

## Per-query fetch sizing

```ts
await db.query('select * from wide_rows', [], { fetchSize: 50 });
```

Fetching is adaptive by default (batches sized from the described row width
against a byte budget, ramping up across a scan). `fetchSize` — per connection
or per query — is the ceiling on rows per fetch round trip.
