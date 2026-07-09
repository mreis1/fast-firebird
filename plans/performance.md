# Performance Plan

Firebird's reputation for chatty remote connections is the #1 thing this driver
must fix relative to legacy Node drivers.

## Round-trip budget — MEASURED (integration-test asserted, 2026-07-09)

`Attachment.roundTrips` counts packet flushes; tests in
`test/integration/statement-cache.test.ts` assert these numbers on FB3/4/5:

| Operation (inside an open transaction)   | node-firebird | fast-firebird measured |
|-------------------------------------------|---------------|------------------------|
| cold query (prepare→rows)                 | 4–5 RTs       | **2 RTs** (allocate+prepare one flush; execute+first-fetch one flush) |
| warm query, ≤fetchSize rows (stmt cache)  | 3–4 RTs       | **1 RT** (execute+fetch coalesced) |
| warm DML incl. affected count             | 3–4 RTs       | **1 RT** (execute+info coalesced) |
| one-shot `db.query` warm                  | 5–6 RTs       | **3 RTs** (tx start / work / commit) |
| fetch N rows                              | N/200 RTs     | N/400 RTs (configurable `fetchSize`) |

Deferred (0-RT) operations riding with the next packet: statement DSQL_close
after cursor EOF, DSQL_drop on cache eviction, blob close after read.

## Tactics

1. ✅ **Deferred packets** (jaybird lazy-send model): op_free_statement/op_close_blob
   written without waiting; responses consumed FIFO (`WireConnection.markDeferred`).
2. ✅ **Fetch batching**: 400 rows per op_fetch by default, `fetchSize` configurable.
   Adaptive sizing: future.
3. ✅ **Statement cache**: LRU keyed by exact SQL (`statementCacheSize`, default 64,
   0 disables). DDL on the connection clears it. **Caveat (measured on FB3/4/5):
   cached statements hold metadata existence locks — foreign DDL on referenced
   tables blocks until eviction/disconnect. Documented in README. Also measured:
   the server hard-closes the connection if an unknown statement handle is used,
   so cache staleness cannot be probed server-side; the re-prepare retry in
   session.ts only fires for format errors (gds 335544343).**
4. ✅ **Single-flush writes**: execute+first-fetch (selects) and execute+record-counts
   (DML) coalesced into one packet; error paths drain piggybacked responses via the
   deferred-response mechanism.
5. **Buffer discipline**: pooled scratch buffers for XDR encode; subarray views for
   decode; decode strings lazily only when the column is actually read? — measure
   first; eager is simpler and usually wins for full-row consumption.
6. **Blobs**: request maximum segments per op_get_segment buffer (up to 65535);
   stream with backpressure; configurable chunk sizes for read & write. FB4+
   inline blob batching where available.
7. **WireCompression** for high-latency/low-bandwidth links (zlib, negotiated).

## Benchmark harness (packages/benchmarks)

- Compare: fast-firebird vs node-firebird vs node-firebird2.
- Scenarios: connect storm; 1-row query; 10k-row scan; 1k inserts (single tx);
  blob 1KB/1MB/50MB read+write; charset-heavy VARCHAR scan (UTF8 vs NONE+win1252).
- Latency simulation: run against Docker FB with injected delay (toxiproxy
  container inside the same isolated compose project, or `tc netem` in-container)
  at 1ms / 10ms / 50ms RTT. Localhost numbers alone are NOT acceptance criteria.
- Report: ops/sec + total round trips (count via wire-layer counter) — round-trip
  count is a first-class benchmark metric.

## Status
Not started; harness lands with M3.
