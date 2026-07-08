# Performance Plan

Firebird's reputation for chatty remote connections is the #1 thing this driver
must fix relative to legacy Node drivers.

## Round-trip budget (targets)

| Operation                         | node-firebird today | fast-firebird target |
|-----------------------------------|---------------------|----------------------|
| connect+attach                    | 3–4 RTs             | 2–3 RTs (auth folded into connect where server allows) |
| simple query (prepare→rows)       | 4–5 RTs             | 2 RTs (allocate deferred; prepare+info one packet; execute+first fetch batched) |
| repeated query (stmt cache)       | 3–4 RTs             | 1 RT (execute+fetch pipelined) |
| fetch N rows                      | N/fetchSize RTs     | configurable large fetch batches (default 400 rows or ~1MB cap) |

## Tactics

1. **Deferred packets** (jaybird lazy-send model): op_allocate_statement and
   op_free_statement(DSQL_close) written without waiting; responses consumed FIFO.
2. **Fetch batching**: op_fetch requests `fetchSize` rows in ONE response stream;
   make fetchSize adaptive (rows small → bigger batches) and user-configurable.
3. **Statement cache**: LRU of prepared statements keyed by (sql, tx-dialect flags),
   opt-out-able. Reuse avoids prepare/describe cycles entirely.
4. **Single-flush writes**: coalesce op sequences (e.g. execute immediately followed
   by fetch) into one socket write.
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
