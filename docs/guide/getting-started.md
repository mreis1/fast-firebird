# Getting started

## Requirements

- **Node.js ≥ 22**
- A **Firebird 3, 4, 5, or 6** server. No client library is needed — the
  driver speaks the wire protocol directly, so there's nothing native to
  install.

## Install

::: code-group

```sh [pnpm]
pnpm add @fast-firebird/core
```

```sh [npm]
npm install @fast-firebird/core
```

```sh [yarn]
yarn add @fast-firebird/core
```

:::

The package ships ESM and CJS builds with full TypeScript declarations.

## Connect and query

```ts
import { connect } from '@fast-firebird/core';

const db = await connect({
  host: 'localhost',
  port: 3050,                  // default
  database: '/data/app.fdb',   // server-side path or alias
  user: 'SYSDBA',
  password: 'masterkey',
});

const rows = await db.query('select id, name from users where id = ?', [1]);
const one  = await db.queryOne<{ ID: number; NAME: string }>(
  'select id, name from users where id = ?', [1],
);

await db.transaction(async (tx) => {
  await tx.execute('insert into users (id, name) values (?, ?)', [2, 'Alice']);
});

await db.disconnect();          // or: await using db = await connect({ … })
```

A few things worth knowing on day one:

- `query`/`queryOne`/`execute` are shortcuts over one primitive, `run()` —
  see [Queries & parameters](./queries).
- Column keys arrive as Firebird reports them — uppercase unless you quoted
  the identifier at DDL time (`row.NAME`, not `row.name`).
- Without an explicit transaction, each call runs in its own auto-committed
  transaction. Use `db.transaction(fn)` (or `startTransaction`) to group work —
  see [Transactions](./transactions).
- Wire encryption (Arc4) is **on by default**; see
  [Auth, encryption & compression](./security).

## Connecting to different setups

```ts
// Embedded-style alias defined in databases.conf:
const db = await connect({ host: 'db.example.com', database: 'myapp', user, password });

// Old server with Legacy_Auth only:
const legacy = await connect({
  host, database, user, password,
  authPlugin: 'Legacy_Auth',
  wireCrypt: 'disabled',
});

// Legacy CHARSET NONE database written as Windows-1252 (Delphi era):
const delphi = await connect({
  host, database, user, password,
  charset: 'NONE',
  charsetNoneEncoding: 'win1252',
});
```

See [Legacy CHARSET NONE](./charset-none) for the full transcoding toolkit.

## Creating a database

```ts
import { createDatabase } from '@fast-firebird/core';

const db = await createDatabase({
  host: 'localhost',
  database: '/data/new.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
  pageSize: 8192,          // optional
});
await db.disconnect();
```

## A production shape

Most applications want the [connection pool](./pooling) plus the
[statement cache](./prepared-statements) (on by default):

```ts
import { createPool } from '@fast-firebird/core';

const pool = await createPool({ host, database, user, password, min: 2, max: 10 });

const users = await pool.query('select * from users where dept = ?', [10]);
await pool.transaction(async (tx) => { /* … */ });

await pool.close();
```

## Where to next

- [Queries & parameters](./queries) — the execution API, named parameters, result shaping
- [Bulk writes](./batch) — thousands of rows per round trip on FB4+
- [Blobs](./blobs) — eager/lazy strategies, streaming, performance
- [Drizzle ORM](./drizzle) — the `@fast-firebird/drizzle` adapter
- [Migrating from node-firebird](./migrate-from-node-firebird) — side-by-side equivalents
