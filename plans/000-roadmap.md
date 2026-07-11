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
- [ ] Blob *write* streaming (Writable; writes are still buffered per value) — backlog

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
      lazy blob handles. 18 tests. (autoUpgradeReadOnly: deferred, opt-in later.)
- [x] Pool parallelism helper `pool.map(items, fn, {concurrency})` — bounded
      concurrent work across pooled connections, results in order. Honest note:
      lazy blob handles can't cross connections, so parallelize by running the
      *query* per partition inside `fn`, not by sharing handles. 1 test.
- [ ] `plans/projection.md` — `SELECT *` rewrite (`expandStar`) DEFERRED/future

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
- [ ] CI: GitHub Actions with FB 3/4/5 service containers
- [ ] Benchmarks expansion: tc/toxiproxy latency matrix, blob throughput, charset overhead
- [ ] Docs site / README polish

## Deferred backlog (explicitly parked, in rough priority order)

1. **`SELECT *` projection rewrite** (`expandStar`, `plans/projection.md`) —
   rewrite `*`/`ALIAS.*`/`TABLE.*` server-side so `exclude` can skip blob
   columns without the caller typing every column. User-requested; needs
   alias-aware SQL analysis.
2. **Zone-preserving timezone types** — TIMESTAMP/TIME WITH TIME ZONE currently
   decode to UTC-instant JS `Date`s (instant exact, zone id dropped; verified:
   09:30 America/New_York → 13:30Z). Apps that must round-trip the *zone*
   need a `{date, zone}` value or Temporal ZonedDateTime once stable in Node.
3. **Cross-blob pipelining** — per-segment pipelining shipped (32-deep window);
   the next WAN win is overlapping blob open/read/close ACROSS rows on one
   connection. Field data (2026-07-11): 100×1.7 MB fetch runs at 10 MB/s on a
   44 MB/s path — the gap is ~2–3 RTTs of per-blob open/close/drain that could
   overlap with the previous blob's transfer.
4. **Blob write streaming** — `Writable`/AsyncIterable input for blob params
   (reads already stream via `Blob.stream()`).
5. **core `autoUpgradeReadOnly`** — opt-in RO→RW transaction auto-upgrade with
   statement replay in core's own API (the nf2-ext compat layer already does
   this at its level).
6. **Drizzle depth**: nested transactions (savepoints — adapter currently
   throws), relational query API, drizzle-kit migrations, RDB$ introspection →
   schema generation.
7. **Services actions**: backup/restore (gbak) via service start+output —
   plumbing (SPB, collectOutput) already exists.
8. **DECFLOAT special values** — Inf/NaN decode; encode rejects them (finite
   round-trip complete).
9. **Protocol 10–12 / FB 2.5 legacy support** — EOL upstream; only if a
   migration demands it.
10. **Native/WASM acceleration** (SIMD UTF-8, decimal128) — only if benchmarks
   prove the need (`plans/architecture.md`).

## Testing strategy
- Unit: XDR, SRP vectors, type codec, charset, script parser — no server needed.
- Integration: Docker FB 3/4/5 (`docker/docker-compose.yml`, project `fast-firebird-test`),
  strictly isolated per `plans/docker-safety.md`.
- Regression: `CHARSET NONE` + win1252 round-trips (€, smart quotes, em dash).

## Current status (2026-07-10)
M0–M5.5 complete. M6 essentially delivered: Drizzle adapter (30 tests),
node-firebird2-ext swap (branch `fast-firebird`, 9/9), live demo dashboard with
feature explorer + custom benchmark, brand assets (SVG/PNG/ICO). DECFLOAT now
fully decoded AND encoded (target-aware params) — the last placeholder type; the
read+write type system is complete for finite values. Core: 340+ tests green.
Remaining active M6 work: publish `@fast-firebird/core`, CI, benchmark
expansion, docs polish. Parked work lives in the Deferred backlog above.
See `diary/2026-07-09.md` (sessions 9–14) and `diary/2026-07-10.md`.
