---
layout: home

hero:
  name: fast-firebird
  text: The modern Firebird driver for Node.js
  tagline: Pure TypeScript, zero native dependencies — speaking the Firebird wire protocol directly, with round trips treated as the scarcest resource. Proven against real Firebird 3/4/5/6 servers on every push.
  image:
    src: /phoenix.png
    alt: fast-firebird
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Migrating from node-firebird
      link: /guide/migrate-from-node-firebird
    - theme: alt
      text: API reference
      link: /api/

features:
  - icon: ⚡
    title: Round-trip frugal, measurably
    details: Prepare pipelined into one round trip, execute+fetch coalesced, adaptive batching, FB5/FB6 inline blobs. Attachment.roundTrips exposes the flush counter — the driver's own tests assert exact counts.
  - icon: 🧩
    title: Pure TypeScript, zero native deps
    details: No fbclient, no node-gyp, no prebuilt binaries. Installs the same everywhere — containers, serverless, ARM, Alpine. Protocols 13–20 with SRP256 auth and ChaCha/Arc4 wire encryption.
  - icon: 📦
    title: Bulk writes in one round trip
    details: executeBatch rides the Firebird 4+ wire batch API — thousands of INSERT/UPDATE/DELETE rows per round trip, streaming row sources, per-row update counts and errors, BLOB support.
  - icon: 🗄️
    title: Blobs done right
    details: Eager by default, lazy per column on request, 64KB segments with deep pipelining, partial reads with resume, read-ahead for streams. 21–152× faster than legacy drivers on blob workloads.
  - icon: 🌐
    title: The full type system
    details: DECFLOAT(16/34), INT128, TIMESTAMP/TIME WITH TIME ZONE with the zone preserved, exact NUMERIC scaling, and a charset layer resolved at prepare time — including legacy CHARSET NONE databases.
  - icon: 🔬
    title: Tested against real servers
    details: 1158 core + 90 Drizzle tests run in CI against a real Firebird 3/4/5/6 container matrix — byte-exact blob checks, exact round-trip assertions, error-path connection reuse.
  - icon: 🌪️
    title: Production plumbing included
    details: Connection pool with validation-on-borrow, per-connection statement cache, backpressured streaming, POST_EVENT listeners, Services API (gbak/gstat), isql-faithful script runner.
  - icon: 💧
    title: Drizzle ORM adapter
    details: "@fast-firebird/drizzle: query builder with FIRST/SKIP pagination and RETURNING, savepoint-nested transactions, a plain-SQL migrator, and RDB$ introspection → schema codegen."
---

## Sixty seconds to your first query

::: code-group

```sh [pnpm]
pnpm add @fast-firebird/core
```

```sh [npm]
npm install @fast-firebird/core
```

:::

```ts
import { connect } from '@fast-firebird/core';

const db = await connect({
  host: 'localhost',
  port: 3050,
  database: '/data/app.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
});

const rows = await db.query('select id, name from users where id = ?', [1]);

await db.transaction(async (tx) => {
  await tx.execute('insert into users (id, name) values (?, ?)', [2, 'Alice']);
});

await db.disconnect();
```

Works out of the box against **Firebird 3, 4, and 5** — plus **Firebird 6**
(snapshot, protocol 20). Node.js ≥ 22.
