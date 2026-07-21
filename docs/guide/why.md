# Why fast-firebird?

The existing Node.js options are projects we learned a lot from, and
`node-firebird` deserves particular respect: it carried this maintainer's
production systems for years, and much of the Node + Firebird community with
it. It grew up in the callback era and spent a decade prioritizing
compatibility with very old Node.js versions; its recent 2.x line has been
modernizing at an impressive pace (TypeScript, promises, protocol 20).
`node-firebird-driver-native` is well-engineered but binds to the native
`fbclient` library, which complicates containers, serverless platforms, and
simple onboarding.

fast-firebird is different by design rather than by patching: it started from
a blank page in 2026 with a modern Node.js baseline (≥ 22), no
backwards-compatibility baggage, and the wire protocol itself as the design
center. Round trips are treated as the scarcest resource — counted, exposed
(`Attachment.roundTrips`), and asserted exactly in the driver's own tests —
which is a property you architect in from the start, not one you retrofit.

On top of that sits a pure-TypeScript, promise-native driver that speaks the
modern wire protocol (up to protocol 20) with SRP256 authentication and
Arc4/ChaCha wire encryption, covers the full FB4/5 type system (DECFLOAT,
INT128, `TIMESTAMP/TIME WITH TIME ZONE` with the zone preserved), rides
FB5/FB6 inline blobs, and ships the surrounding pieces — backpressured
streaming, events, the Services API, a connection pool, a script parser, and a
Drizzle ORM adapter — in one coherent package.

## Evidence, not adjectives

The engineering is test-driven against real servers: **1158 core tests + 90
Drizzle tests** run in CI against a real Firebird 3/4/5/6 container matrix,
many of them asserting exact wire round-trip counts, byte-exact blob content
(SHA-verified), and error-path connection reuse. Design trade-offs are
documented where you'll hit them (eager-by-default blobs, lazy-handle
transaction scoping, the statement-cache metadata-pinning caveat), and the
repository's `plans/` and `diary/` directories record the *why* behind every
decision.

See [Performance](./performance) for measured numbers against `node-firebird`
2.x, defaults vs defaults, at several link latencies.

## Feature overview

- **Connectivity** — SRP256/Srp/Legacy_Auth, Arc4/ChaCha/ChaCha64 wire crypt, zlib wire compression, connect timeouts covering the whole handshake, FB6 `searchPath`/`owner` attach options
- **Queries** — promise API (`query`, `queryOne`, `run`, `execute`), positional `?` or named `@name` parameters, typed rows `query<T>()`, prepared statements, per-connection LRU statement cache, adaptive batched fetching with per-query `fetchSize`
- **Bulk writes** — `executeBatch` on the FB4+ wire batch API: thousands of DML rows per round trip, streaming (async-iterable) row sources, per-row update counts and errors (`continueOnError`), BLOB support
- **Result shaping** — `ColumnInfo` metadata, `rowMode: 'array'`, `exclude`/`only` column filters, `expandStar` (`select *` rewritten to explicit columns before prepare)
- **Streaming** — `queryStream` async iterator with batch-level backpressure
- **Blobs** — eager or lazy (per subtype, per column), 64KB segments with cross-blob pipelining, partial reads (`head()`) with resume, streaming reads/writes, read-ahead for streams, batch prefetch, `toFile()`, FB5/FB6 inline blobs (small blobs cost zero round trips)
- **Types** — every scalar type including DECFLOAT(16/34), INT128, and zone-preserving `ZonedDate`
- **Transactions** — isolation/read-only/lock-wait options, `restart()`, nested transactions via savepoints, opt-in RO→RW auto-upgrade, `await using` support
- **Ecosystem** — connection pool, `POST_EVENT` listener, Services API (server info, gstat, gbak backup/restore), isql-faithful script parser, Drizzle ORM adapter (with nested transactions, plain-SQL migrator, RDB$ introspection → schema codegen), legacy `CHARSET NONE` transcoding toolkit
