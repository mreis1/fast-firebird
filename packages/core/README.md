<p align="center">
  <img src="https://raw.githubusercontent.com/mreis1/fast-firebird/main/assets/png/logo2-lettering-1440.png" alt="fast-firebird — The modern, pure-TypeScript Firebird driver for Node.js" width="640">
</p>

# @fast-firebird/core

A next-generation Firebird SQL driver for Node.js — **pure TypeScript**, zero
native dependencies, speaking the Firebird wire protocol directly (protocols
13–19) with first-class support for **Firebird 3, 4, and 5**.

```ts
import { connect } from '@fast-firebird/core';

const db = await connect({
  host: 'localhost',
  database: '/data/employees.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
});

const rows = await db.query('select first 5 * from employee where salary > ?', [50000]);
await db.disconnect();
```

## Highlights

- **Fast on real networks** — statement allocate+prepare pipelined into one
  round trip, execute+fetch coalesced, adaptive fetch batching, deferred
  cleanup ops. `Attachment.roundTrips` exposes the flush counter.
- **Blobs done right** — eager by default (a `SELECT` gives you values), 64KB
  segments with deep pipelining, FB5 inline blobs (small blobs cost **zero**
  extra round trips), lazy modes per column/subtype, `blob.stream()`,
  `blob.toFile()`, read-ahead for streaming consumers. 11–149× faster than
  legacy drivers on blob workloads.
- **Modern auth & wire crypt** — SRP256/SRP (Firebird's exact SRP-6a variant),
  ARC4/ChaCha/ChaCha64 wire encryption on by default, wire compression,
  Legacy_Auth fallback for old servers.
- **Complete type system** — all Firebird types including INT128, DECFLOAT
  16/34 (±Inf/NaN), TIMESTAMP/TIME WITH TIME ZONE (instant or `ZonedDate`),
  NUMERIC precision handling, charset layer resolved at prepare time
  (including `CHARSET NONE` legacy databases via `charsetNoneEncoding`).
- **Production plumbing** — connection pool (validation-on-borrow, idle
  eviction), per-connection statement cache, row streaming with backpressure,
  multi-statement script execution (isql-compatible `SET TERM`), savepoint
  nested transactions, transaction restart/auto-upgrade, `await using`
  support, POST_EVENT listeners, Services API (server info, gstat, gbak
  backup/restore).
- **Real error messages** — the full gds→message table (2539 entries) with
  SQLSTATE and complete status vector on every `FirebirdError`.
- **Tested against real servers** — 784 tests across a Firebird 3/4/5
  (+ Legacy_Auth) Docker matrix on every push.

## Drizzle ORM

See [`@fast-firebird/drizzle`](https://www.npmjs.com/package/@fast-firebird/drizzle)
for the Drizzle dialect (query builder, migrator, schema introspection).

## Documentation

Full documentation, benchmarks, and design notes:
**[github.com/mreis1/fast-firebird](https://github.com/mreis1/fast-firebird)**

## License

MIT. Contains data derived from the Firebird project under IDPL/IPL — see
`NOTICE`.
