# fast-firebird — Roadmap

> Mission: the fastest, most reliable, most complete Firebird driver for Node.js.
> Pure TypeScript, Firebird 3/4/5, Drizzle-ready. See `AGENTS.md` for the full mandate.

## Package layout (monorepo, pnpm)

```
packages/
  core/                  @fast-firebird/core        — wire protocol driver (zero framework deps)
  pool/                  @fast-firebird/pool        — connection pooling (may fold into core)
  script/                @fast-firebird/script      — isql-style script parser + executor
  drizzle/               @fast-firebird/drizzle     — Drizzle ORM dialect + driver adapter
  compat-node-firebird/  @fast-firebird/compat      — legacy node-firebird(2) API shim
  benchmarks/            private                    — perf harness (vs node-firebird, latency sims)
```

`core` starts life containing the pool and script parser as subpaths; they split out
only when API surface stabilizes (avoid premature package fragmentation).

## Milestones

### M0 — Foundation ✅ (2026-07-08/09)
- [x] Monorepo scaffold (pnpm, TS strict, vitest, tsup)
- [x] Reference sources cloned into `references/` (gitignored): node-firebird, node-firebird2,
      rsfbclient, jaybird, python3-driver, firebird core
- [x] Protocol research notes in `plans/research/` (3 documents)
- [x] Docker safety rules (`plans/docker-safety.md`)

### M1 — Connect & authenticate ✅ (2026-07-09)
- [x] TCP transport with buffered reader/writer, connect timeout
- [x] XDR encode/decode primitives
- [x] op_connect → op_accept_data/op_cond_accept handshake, protocols 13–16 offered
- [x] SRP (Srp256 default, Srp fallback) via node:crypto — incl. FB3 attach-time
      auth continuation (crypt-disabled path). Legacy_Auth: not yet.
- [x] Arc4 wire encryption (pure-TS RC4; OpenSSL 3 dropped legacy rc4)
- [x] op_attach/op_create/op_detach/op_drop_database with DPB builder
- [x] Error mapping: full gds message table (2539 msgs generated from FB source) + SQLSTATE

### M2 — Queries ✅ core (2026-07-09)
- [x] Transactions (TPB builder, commit/rollback/retaining, isolation presets)
- [x] allocate+prepare pipelined (1 RT), execute, batched fetch, SQL-info parsing
- [x] BLR parameter messages (value-driven) + output BLR from describe
- [x] Type codec: all FB3 types + INT64/INT128, TZ types (decoded to UTC-instant
      JS Dates; zone id discarded — zone-preserving types deferred, see backlog);
      DECFLOAT: full IEEE 754-2008 DPD decode+encode since 2026-07-09/10
      (exact decimal strings; target-aware param binding)
- [x] Charset layer incl. `CHARSET NONE` + `charsetNoneEncoding` + transcodeAdapter
      + charsetOverrides — verified € round-trip on FB3/4/5
- [x] Blob read/write (eager materialization; subtype 1 → string)
- [x] High-level API: `connect()`, `query()`, `run()`, `execute()`, `transaction()`
- [x] Statement cache / reusable PreparedStatement objects (delivered in M3)
- [x] op_execute affected-counts piggyback (delivered in M3 — 1-RT warm DML)

### M3 — Security & performance (statement cache + RT work ✅ 2026-07-09)
- [x] Statement cache: per-connection LRU keyed by SQL (`statementCacheSize`,
      default 64), DDL clears it, deferred close/drop, format-error re-prepare
      retry. Documented metadata-lock caveat (foreign DDL blocks on cached stmts).
- [x] Public `PreparedStatement` API (`att.prepare` → query/run/execute/close)
- [x] Execute+first-fetch and execute+record-counts coalesced into one packet;
      measured & test-asserted: warm select/DML = 1 RT, cold = 2 RT
- [x] `Attachment.roundTrips` flush counter (first-class perf metric)
- [x] INSERT/UPDATE/DELETE ... RETURNING via op_execute2
- [x] SRP scramble fix: minimal (stripped) key bytes per srp.cpp — killed the
      ~1/128 intermittent login failure; deterministic short-key regression test
- [x] WireCompression (zlib): pipeline stage beneath Arc4 (compress→encrypt),
      pflag_compress negotiation, tx-crypt flush barrier; 15 tests on FB3/4/5
- [x] Benchmark harness vs node-firebird (`packages/benchmarks`) with in-process
      latency proxy (0/2/10ms). Measured: warm select 3×, DML 2×, blob 14–44×
      faster; results in `plans/performance.md`.
- [x] SRP plugin-switch / wrong-password fix: server re-sends salt on failed
      proof (not an error) — track attempted plugins, one proof each, fail fast
      (was: 30s deadlock). Regression tests added.
- [x] Blob default chunk raised to 64KB (wire max) — blob throughput is RT-bound
- [x] ChaCha / ChaCha64 wire crypt (FB4+): SHA256(sessionKey) key, IV pre-shared
      in the auth op_response TAG_PLUGIN_SPECIFIC clumplet (protocol 16);
      `wireCryptPlugin` opt-in, Arc4 default; FB3 rejects with a clear error.
      RFC-8439-vector unit test + FB4/5 integration.
- [x] Adaptive fetch sizing: batch count from row width vs 256KB budget, ramped
      40→cap; caps wide-row memory, minimizes RTs on narrow scans.

### M4 — Streaming & pooling ✅ (2026-07-09)
- [x] Row streaming (`queryStream`, async iterators + `Readable.from`): lazy
      batch fetch, backpressure, early-break stops after 1–2 batches (asserted),
      blob materialization, own-tx or in-tx variants.
- [x] Connection pool (`createPool`/`Pool`): acquire/release/use, min/max,
      acquire timeout, idle eviction, op_ping validation, per-conn statement
      cache. Fixed a capacity-overshoot race (reserve slot before async validate).
- [x] Segmented blob read/write with configurable chunk sizes (done in M2)
- [x] Blob *read* streaming (`Blob.stream()`, chunk-level Readable — M5.5)
- [x] Blob *write* streaming — Readable/AsyncIterable sources bound directly
      as BLOB params (shipped 2026-07-13, see backlog #6)

### M5 — Events, services, scripts ✅ (2026-07-09)
- [x] Script parser (isql-faithful: SET TERM, PSQL bodies, comments, string/
      q-literal/quoted-ident, line/col errors) + `executeScript` (perScript/
      perStatement/none tx modes, continueOnError, progress). 27 tests.
- [x] POST_EVENT listening: per-attachment shared async channel (aux port,
      rid-demuxed op_que_events/op_event, auto re-arm, baseline suppression,
      FIN-not-RST teardown for FB3), `Attachment.events()` EventEmitter. 9 tests.
- [x] Services API: `connectService` → server version/implementation/sec-db
      info + gstat statistics (SPB v2 doubled header, SpbStart 2-byte strings).
      12 tests. Backup/restore actions: future (same start+output plumbing).

### M5.5 — Core hardening & DX ✅ (2026-07-09; see plans/dx.md)
- [x] Legacy_Auth plugin (DES crypt(3), UTF-8 password bytes) — verified live on
      a Legacy_Auth server; `authPlugin:'Legacy_Auth'`. Clear error when a
      WireCrypt=Disabled server refuses op_crypt. 6 crypt-vector + 4 integration tests.
- [x] Lazy blobs + blob streaming (`Blob.buffer/text/stream/size`, `blobs:'lazy'`
      per-query or per-connection; eager default). Handles are transaction-scoped
      with dead-handle detection (FirebirdBlobError); `db.query` lazy throws.
      Connect timeout now covers the handshake (not just TCP).
- [x] Column `exclude`/`only` (decode-time; drops columns + skips unneeded BLOB
      materialization). 33 tests; verified unread blobs cost zero round trips.
- [x] Transaction `restart(options?)` — commit(default)/rollback + reopen,
      reuses or replaces isolation strategy; tx-generation invalidates prior
      lazy blob handles. 18 tests. (autoUpgradeReadOnly shipped 2026-07-13 —
      deferred backlog #7.)
- [x] Pool parallelism helper `pool.map(items, fn, {concurrency})` — bounded
      concurrent work across pooled connections, results in order. Honest note:
      lazy blob handles can't cross connections, so parallelize by running the
      *query* per partition inside `fn`, not by sharing handles. 1 test.
- [x] `plans/projection.md` — `SELECT *` rewrite (`expandStar`) — shipped
      2026-07-13 (alias-exact via isc_info_sql_relation_alias, self-join safe)

### M6 — Ecosystem
- [x] Drizzle dialect + adapter (`plans/drizzle.md`) — `@fast-firebird/drizzle`:
      FirebirdDialect (`?` params, upper-folded quoting, FIRST/SKIP pagination,
      multi-row INSERT rewritten to `SELECT … UNION ALL` with per-column CASTs),
      session/prepared-query/transaction, driver `drizzle(attachment)`, Firebird
      column types (timestamp/date/time/blob/blobText). 30 integration tests
      (CRUD, where, pagination, RETURNING, tx commit/rollback, all column types)
      green on FB3/4/5. Surfaced+fixed a core param-coercion/wire-desync bug (below).
- [x] node-firebird2 compat + migration guide — delivered as the `fast-firebird`
      branch of `the private node-firebird2-ext repo` (full internals swap, public API
      unchanged, RO→RW auto-upgrade replicated, MIGRATION.md; 9/9 on FB3/4/5).
      See `plans/nf2-ext-integration.md`. Prereq for deployment: publish core.
- [x] Live demo dashboard (`apps/demo`, React + Fastify): connection/wire info,
      live pool + POST_EVENT (SSE), three-way SQL runner (core/drizzle/compat),
      version feature explorer (FB3/4/5 cards, runnable SQL), row streaming,
      blob round-trip, per-stack micro-benchmark, custom structure benchmark
      (user-defined columns + blob file picker, insert+fetch timings).
- [ ] Publish `@fast-firebird/core` (npm or private registry) — blocks real
      deployment of the nf2-ext branch (today a `file:` link)
- [x] CI: GitHub Actions (`.github/workflows/ci.yml`, 2026-07-13) — same
      docker-compose matrix as local dev (FB3/4/5 + legacy), frozen-lockfile
      install with a stub for the gitignored nf2-ext file: dep, typecheck +
      build + 674 core / 30 drizzle tests; validated via clean-clone dry run
- [ ] Benchmarks expansion: tc/toxiproxy latency matrix, blob throughput, charset overhead
- [ ] Docs site / README polish

## Design decisions (locked)

- **Blobs are EAGER by default** — final verdict 2026-07-13. Rationale:
  "SELECT gives me values" is the near-universal driver expectation, and lazy
  leaks transaction-lifetime concerns into ordinary code. Flipping the default
  would also break every existing consumer (compat shim, drizzle, demo) and
  make `db.query` vs `tx.query` return different shapes. Lazy stays one option
  away: `connect({blobs:'lazy'})` connection-wide, or `{blobs:'lazy'}`
  per query/stream (auto-tx `db.query` rejects all lazy modes by design —
  handles would die with the hidden transaction). Subtype shorthands since
  2026-07-13: `'lazy-binary'` (files lazy, memos as strings — the export
  sweet spot) and `'lazy-text'` (inverse).

## Deferred backlog (explicitly parked, in rough priority order)

~~1. `SELECT *` projection rewrite~~ — SHIPPED 2026-07-13, see
   `plans/projection.md`.

~~2. Zone-preserving timezone types~~ — SHIPPED 2026-07-13: opt-in
   `timeZones: 'zoned'` connection mode returns `ZonedDate {date, zone}`
   (UTC instant + IANA name or ±HH:MM offset; also bindable as a param, zone
   round-trips). Default 'instant' (plain Date) unchanged. Zone-id table
   generated from Firebird's TimeZones.h (tzdata 2026b; offset ids =
   displacement + 1439). Temporal interop can layer on later.
~~3. Cross-blob pipelining~~ — SHIPPED 2026-07-13, both halves:
   (a) eager batch materialization overlaps open/read/close across blobs
   automatically (`readBlobs`: global 32-deep window across blobs, FIFO
   pending queue, in-order close descriptors, batched flushes, per-blob cap
   ramp; measured 30 ms RTT: 48→21 ms/blob, <1 RTT/blob); (b) opt-in
   `blobReadAhead` (`true | depth | {columns, depth, maxBytes}`, per-query or
   connection default) prefetches upcoming lazy blobs in bounded op-lock
   slices during `queryStream` (exporter loop 136→82 ms/row at 30 ms RTT).
   `prefetchBlobs(handles)` / `Blob.prefetch` bulk helper for buffered-lazy
   patterns shipped 2026-07-13 (one readBlobs pipeline per connection+tx
   group; skips cached/cursor/read-ahead/null entries). FB5 inline blobs
   SHIPPED 2026-07-13 too: protocol 19 negotiated on FB 5.0.2+, op_inline_blob
   consumed in readOp, tx-scoped InlineBlobCache consulted first by every
   blob read path — small blobs/memos cost ZERO round trips
   (`maxInlineBlobSize` default 65535, `maxBlobCacheSize` 10 MiB). Remaining
   follow-up: deepen the streaming prefetcher (overlap next blob's open with
   the current prefetch).
~~4. Per-column blob mode~~ — SHIPPED 2026-07-13, both forms: subtype
   shorthands `'lazy-binary'`/`'lazy-text'`, and the named-column form
   `blobs: {default?, eager: [cols], lazy: [cols]}` (bare or ALIAS.COL,
   case-insensitive, overrides beat the base mode, conflict throws; auto-tx
   guard only fires for lazy-capable configs; composes with blobReadAhead).
~~5. Blob head/resume cursor~~ — SHIPPED 2026-07-13: `blob.head(n)` (raw
   bytes, 2 flushes for a magic number) keeps the handle open at position;
   `buffer()`/`stream()`/`text()` resume from the cursor (no re-open, no
   re-transfer — RT-asserted), widening heads read only the delta, full
   consumption promotes to the cache, `blob.close()` releases an unfinished
   cursor. Composes with blobReadAhead (prefetched heads are free).
~~6. Blob write streaming~~ — SHIPPED 2026-07-13: `Readable`/
   `AsyncIterable<Buffer|string>` bound directly as BLOB params
   (`writeBlobStream`: accumulator re-frames arbitrary chunks into wire-max
   segments, PIPELINE_DEPTH upload window, string chunks via column codec;
   source-throw drains cleanly incl. unflushed segments). Lazy `Blob` handles
   are rejected as params with guidance (same-connection deadlock guard —
   `await blob.buffer()` first).
~~7. core `autoUpgradeReadOnly`~~ — SHIPPED 2026-07-13: opt-in (per-tx or
   connection default, per-tx wins) RO→RW auto-upgrade in core's own API. On
   isc_read_only_trans (335544361) in `tx.query/run/execute`: commit the
   write-free RO tx, reopen read-write (same isolation), replay the statement
   ONCE; `tx.autoUpgraded` reports it. Snapshot moves + prior lazy blob
   handles die (documented). 21 tests.
~~8. Small DX helpers~~ — SHIPPED 2026-07-13: per-query `fetchSize` (ceiling
   for the adaptive fetch plan, clamped 1–65535, run + stream paths);
   `queryOne<T>()` on Attachment/Transaction/Pool/PreparedStatement (first row
   or undefined — full fetch, use FIRST 1 for big sets); typed rows
   `query<T>/run<T>/queryStream<T>` + generic `QueryResult<T>` (compile-time
   only); `Symbol.asyncDispose` on Attachment (disconnect)/Transaction
   (rollback-unless-finished)/Pool (close)/PreparedStatement (close) — `await
   using` works, lib gained ESNext.Disposable; `blob.toFile(path)` streaming
   fs export returning bytes written. 39 tests.
9. **Drizzle depth**: nested transactions (savepoints — adapter currently
   throws), relational query API, drizzle-kit migrations, RDB$ introspection →
   schema generation.
10. **Services actions**: backup/restore (gbak) via service start+output —
   plumbing (SPB, collectOutput) already exists.
11. **DECFLOAT special values** — Inf/NaN decode; encode rejects them (finite
   round-trip complete).
12. **Protocol 10–12 / FB 2.5 legacy support** — EOL upstream; only if a
   migration demands it.
13. **Native/WASM acceleration** (SIMD UTF-8, decimal128) — only if benchmarks
   prove the need (`plans/architecture.md`).

## Testing strategy
- Unit: XDR, SRP vectors, type codec, charset, script parser — no server needed.
- Integration: Docker FB 3/4/5 (`docker/docker-compose.yml`, project `fast-firebird-test`),
  strictly isolated per `plans/docker-safety.md`.
- Regression: `CHARSET NONE` + win1252 round-trips (€, smart quotes, em dash).

## Current status (2026-07-13)
M0–M5.5 complete. M6 essentially delivered: Drizzle adapter (30 tests),
node-firebird2-ext swap (branch `fast-firebird`, 9/9), live demo dashboard with
feature explorer + custom benchmark + connection lifecycle/tx-wait/compression/
charset+role pickers, brand assets (SVG/PNG/ICO). DECFLOAT fully decoded AND
encoded — the read+write type system is complete for finite values. Recent
core additions: blob segment pipelining (32-deep; the 2.8→59 MB/s remote-fetch
arc, see diary 07-10/11), Legacy_Auth server-initiated fallback, commit-leak
fix, `ColumnInfo` result metadata (`QueryResult.columns`), abandoned-blob-
stream close. Blobs stay eager by default (see Design decisions). Core: 752
tests green on FB3/4/5 (+30 drizzle); GitHub Actions CI in place. Deferred
backlog #7 (autoUpgradeReadOnly) and #8 (DX helpers: per-query fetchSize,
queryOne, query<T>, await using, blob.toFile) shipped 2026-07-13. Remaining
active M6 work: publish `@fast-firebird/core`, benchmark expansion, docs
polish (README badly behind the feature set). Parked work lives in the
Deferred backlog above. See `diary/2026-07-11.md` and `diary/2026-07-13.md`.
