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
- [x] Type codec: all FB3 types + INT64/INT128, TZ types (zone discarded for now);
      DECFLOAT decodes to raw bytes (TODO proper decimal)
- [x] Charset layer incl. `CHARSET NONE` + `charsetNoneEncoding` + transcodeAdapter
      + charsetOverrides — verified € round-trip on FB3/4/5
- [x] Blob read/write (eager materialization; subtype 1 → string)
- [x] High-level API: `connect()`, `query()`, `run()`, `execute()`, `transaction()`
- [ ] Statement cache / reusable PreparedStatement objects (M3)
- [ ] op_execute affected-counts piggyback avoidance (extra RT today for DML)

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
- [ ] Blob *streaming* APIs (chunk-level Readable/Writable) — still buffered per value

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

### M5.5 — Core hardening & DX (planned 2026-07-09; see plans/dx.md)
- [ ] Legacy_Auth plugin (DES crypt(3)) — migration blocker; verify live
- [ ] Lazy blobs + blob streaming (`Blob.buffer/text/stream`); eager stays default
- [ ] Column `exclude`/`only` (decode-time; skips unneeded BLOB materialization)
- [ ] Transaction `restart()` + stored options; opt-in `autoUpgradeReadOnly`
- [ ] Pool blob-parallel helper (`pool.materialize`, honest single-conn note)
- [ ] `plans/projection.md` — `SELECT *` rewrite (`expandStar`) DEFERRED/future

### M6 — Ecosystem
- [ ] Drizzle dialect + adapter (`plans/drizzle.md`)
- [ ] node-firebird/node-firebird2 compat layer + migration guide
- [ ] Benchmarks: localhost + simulated latency (tc/toxiproxy), blob throughput, charset overhead
- [ ] Docs site / README polish; CI (GitHub Actions with FB 3/4/5 service containers)

## Testing strategy
- Unit: XDR, SRP vectors, type codec, charset, script parser — no server needed.
- Integration: Docker FB 3/4/5 (`docker/docker-compose.yml`, project `fast-firebird-test`),
  strictly isolated per `plans/docker-safety.md`.
- Regression: `CHARSET NONE` + win1252 round-trips (€, smart quotes, em dash).

## Current status (2026-07-08)
M0 nearly done; M1 implementation starting. See `diary/2026-07-08.md`.
