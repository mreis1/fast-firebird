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

### M0 — Foundation (in progress)
- [x] Monorepo scaffold (pnpm, TS strict, vitest, tsup)
- [x] Reference sources cloned into `references/` (gitignored): node-firebird, node-firebird2,
      rsfbclient, jaybird, python3-driver, firebird core
- [ ] Protocol research notes in `plans/research/` (agents running)
- [x] Docker safety rules (`plans/docker-safety.md`)

### M1 — Connect & authenticate (target: first)
- [ ] TCP transport with buffered reader/writer, connect timeout
- [ ] XDR encode/decode primitives
- [ ] op_connect → op_accept_data handshake, protocol 13+ (FB3+), offer up to 16/17
- [ ] SRP (Srp256 default, Srp fallback, Legacy_Auth optional) via node:crypto
- [ ] op_attach with DPB builder; op_detach; op_create (database)
- [ ] Error mapping: status vector → FirebirdError classes

### M2 — Queries
- [ ] Transactions (TPB builder, commit/rollback/retaining)
- [ ] allocate/prepare/execute/fetch with SQL-info metadata parsing
- [ ] BLR parameter message construction
- [ ] Type codec: all FB3 types; FB4 int128/decfloat/tz types
- [ ] Charset layer incl. `CHARSET NONE` + `charsetNoneEncoding` + transcodeAdapter
- [ ] High-level API: `connect()`, `query()`, `execute()`, `transaction()`

### M3 — Security & performance
- [ ] WireCrypt (Arc4/ChaCha) — Arc4 first
- [ ] WireCompression (zlib)
- [ ] Batched fetch with configurable fetch size; prepared statement reuse
- [ ] Pipelining/deferred packets where safe (jaybird-style lazy responses)

### M4 — Blobs, streaming, pooling
- [ ] Segmented blob read/write; streaming APIs with backpressure
- [ ] Row streaming (async iterators + Readable)
- [ ] Connection pool

### M5 — Events, services, scripts
- [ ] POST_EVENT listening (aux connection)
- [ ] Services API (backup/restore/stats)
- [ ] Script parser (SET TERM, PSQL bodies, comments, strings) + executeScript

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
