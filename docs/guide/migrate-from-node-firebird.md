# Migrating from node-firebird

`node-firebird` has served the Node + Firebird community for over a decade —
this guide maps its API to fast-firebird, side by side. Most call sites
translate one-for-one; the differences that need actual thought are
[blobs](#blobs), [transactions around multiple statements](#transactions),
and [result-key casing](#row-keys-and-casing).

## Connecting

::: code-group

```js [node-firebird]
const Firebird = require('node-firebird');

const options = {
  host: '127.0.0.1',
  port: 3050,
  database: '/data/app.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
  lowercase_keys: false,
  role: null,
  pageSize: 4096,
};

Firebird.attach(options, (err, db) => {
  if (err) throw err;
  // use db …
  db.detach();
});
```

```ts [fast-firebird]
import { connect } from '@fast-firebird/core';

const db = await connect({
  host: '127.0.0.1',
  port: 3050,
  database: '/data/app.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
  role: 'RDB$ADMIN',        // optional
});

// use db …
await db.disconnect();
```

:::

Everything is promise-native — no callback wrappers, no `util.promisify`.

## Queries

::: code-group

```js [node-firebird]
db.query('select * from users where id = ?', [1], (err, result) => {
  if (err) throw err;
  console.log(result);        // array of row objects
});

// INSERT/UPDATE — affected rows not returned
db.query('update users set name = ? where id = ?', ['Ann', 1], (err) => { … });
```

```ts [fast-firebird]
const rows = await db.query('select * from users where id = ?', [1]);

// execute() returns the affected-row count:
const n = await db.execute('update users set name = ? where id = ?', ['Ann', 1]);

// or named parameters:
await db.execute('update users set name = @name where id = @id', { name: 'Ann', id: 1 });
```

:::

`db.query` returns rows; `db.queryOne` returns the first row or `undefined`;
`db.execute` returns the affected count; `db.run` returns all three (rows,
count, column metadata). See [Queries & parameters](./queries).

### Streaming (`sequentially`)

::: code-group

```js [node-firebird]
db.sequentially('select * from big_table', [], (row, index) => {
  process(row);
}, (err) => { /* done */ });
```

```ts [fast-firebird]
for await (const row of db.queryStream('select * from big_table')) {
  process(row);               // backpressured; `break` any time
}
```

:::

The async iterator is backpressure-aware: the next fetch round trip only fires
as you consume. See [Streaming](./streaming).

## Transactions

::: code-group

```js [node-firebird]
db.transaction(Firebird.ISOLATION_READ_COMMITTED, (err, tx) => {
  tx.query('insert into orders (id) values (?)', [1], (err) => {
    if (err) return tx.rollback();
    tx.commit((err) => { … });
  });
});
```

```ts [fast-firebird]
// Callback form — commit on success, rollback on any throw:
await db.transaction(async (tx) => {
  await tx.execute('insert into orders (id) values (?)', [1]);
});

// Or explicit:
const tx = await db.startTransaction({ isolation: 'readCommitted' });
await tx.execute('insert into orders (id) values (?)', [1]);
await tx.commit();
```

:::

Isolation mapping:

| node-firebird | fast-firebird |
|---|---|
| `ISOLATION_READ_COMMITTED` | `{ isolation: 'readCommitted' }` (default) |
| `ISOLATION_READ_COMMITTED_READ_ONLY` | `{ isolation: 'readCommitted', readOnly: true }` |
| `ISOLATION_REPEATABLE_READ` | `{ isolation: 'snapshot' }` |
| `ISOLATION_SERIALIZABLE` | `{ isolation: 'consistency' }` |
| *(no equivalent)* | `wait: true \| false \| seconds`, savepoint nesting, `restart()`, RO auto-upgrade |

## Pooling

::: code-group

```js [node-firebird]
const pool = Firebird.pool(5, options);
pool.get((err, db) => {
  db.query('select 1 from rdb$database', [], (err, r) => {
    db.detach();              // returns the connection to the pool
  });
});
pool.destroy();
```

```ts [fast-firebird]
import { createPool } from '@fast-firebird/core';

const pool = await createPool({ ...options, min: 1, max: 5 });

const rows = await pool.query('select 1 from rdb$database'); // acquire→run→release
await pool.use(async (db) => { /* borrow explicitly */ });

await pool.close();
```

:::

The pool validates connections on borrow (`op_ping`), evicts idle connections,
and each pooled connection keeps its own warm statement cache. See
[Pooling](./pooling).

## Blobs

This is the biggest ergonomic difference. node-firebird delivers blobs as a
callback-of-an-emitter per cell (or as values with `blobAsText`); reading is
sequential per blob, in 1KB chunks by default.

::: code-group

```js [node-firebird]
db.query('select id, photo from docs', [], (err, rows) => {
  rows[0].PHOTO((err, name, emitter) => {
    const chunks = [];
    emitter.on('data', (c) => chunks.push(c));
    emitter.on('end', () => useBuffer(Buffer.concat(chunks)));
  });
});
```

```ts [fast-firebird]
// Eager (default): blob columns arrive as values — Buffers, memos as strings.
const rows = await db.query('select id, photo from docs');
useBuffer(rows[0].PHOTO as Buffer);

// Lazy, for big/optional blobs (transaction-scoped handles):
await db.transaction(async (tx) => {
  const rows = await tx.query('select id, photo from docs', [], { blobs: 'lazy' });
  await (rows[0].PHOTO as Blob).toFile('out.jpg');   // or .buffer() / .stream()
});
```

:::

Writing blobs takes `Buffer`, `string`, or any `Readable`/async iterable as an
ordinary parameter. Blob transfer is also where the largest performance gap
sits (64KB pipelined segments + FB5 inline blobs vs sequential 1KB chunks —
[measured 21–152×](./performance)). See [Blobs](./blobs).

## Row keys and casing

node-firebird with `lowercase_keys: true` lowercases column names.
fast-firebird returns keys **exactly as Firebird reports them** — uppercase
unless the identifier was quoted at DDL time. Migrating code that reads
`row.name` should either switch to `row.NAME` or alias in SQL
(`select name as "name" …`).

## Escaping

Replace `Firebird.escape(value)` string-building with parameters — positional
`?` or named `@name`. Parameters are bound on the wire (never interpolated),
which is both safer and faster (prepared-statement reuse).

## Feature-by-feature map

| node-firebird | fast-firebird |
|---|---|
| `Firebird.attach(opts, cb)` | `await connect(opts)` |
| `Firebird.create(opts, cb)` | `await createDatabase(opts)` |
| `Firebird.attachOrCreate` | `connect` + `createDatabase` on ENOENT |
| `Firebird.pool(max, opts)` | `await createPool({ …, max })` |
| `db.query(sql, params, cb)` | `await db.query(sql, params)` |
| `db.execute(sql, params, cb)` | `await db.run(sql, params, { rowMode: 'array' })` |
| `db.sequentially(sql, params, rowCb, cb)` | `for await (const row of db.queryStream(sql, params))` |
| `db.transaction(isolation, cb)` | `await db.transaction(fn)` / `startTransaction(opts)` |
| `db.detach(cb)` | `await db.disconnect()` |
| `blobAsText` | eager text blobs are the default; `blobs: 'lazy'` for handles |
| `lowercase_keys` | keys as reported (alias in SQL if needed) |
| `Firebird.escape(v)` | use parameters (`?` / `@name`) |
| `db.attachEvent(cb)` | `await db.events(['name'])` → EventEmitter |
| *(gbak via CLI)* | `connectService()` → `svc.backup()/restore()` (server-side) |
| *(no equivalent)* | `executeBatch`, prepared statements + cache, `expandStar`/column filters, savepoint nesting, `ZonedDate`, INT128/DECFLOAT, wire crypt/compression, Drizzle adapter |

## What to watch out for

1. **Node ≥ 22 required.** fast-firebird has a modern baseline; node-firebird
   supports much older runtimes.
2. **Wire encryption is on by default** (`wireCrypt: 'enabled'`). Old servers
   with `AuthServer = Legacy_Auth` need
   `{ authPlugin: 'Legacy_Auth', wireCrypt: 'disabled' }` — see
   [Auth & encryption](./security).
3. **Default charset is UTF8** (node-firebird's is also UTF-8 by default, but
   many legacy apps overrode it). For `CHARSET NONE` databases written as
   win1252, use the [CHARSET NONE toolkit](./charset-none).
4. **Blob handles are transaction-scoped** in lazy mode — read them before
   commit. Eager mode (the default) has no such concern.
5. **`queryOne` fetches the full result set** — add `FIRST 1` to the SQL when
   many rows could match.
