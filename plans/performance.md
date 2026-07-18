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

## Measured results vs node-firebird 1.1.10 (2026-07-09, FB5, defaults vs defaults)

In-process TCP latency proxy (one-way delay per link; RTT ≈ 2×delay).
`pnpm --filter @fast-firebird/benchmarks bench`. Both drivers warmed up;
node-firebird needed 4 SRP connect retries during the run (its padded-scramble
bug — see plans/research errata); fast-firebird needed none.

| Scenario | Delay | fast-firebird | node-firebird | Speedup |
|---|---|---|---|---|
| warm select ×200 (open tx) | 0ms | 95 ms (202 RT) | 287 ms | 3.0× |
| warm select ×200 (open tx) | 2ms | 1216 ms | 3573 ms | 2.9× |
| warm select ×200 (open tx) | 10ms | 5013 ms | 14678 ms | 2.9× |
| warm 1-row select ×200 (auto-tx) | 10ms | 14817 ms (600 RT) | 24622 ms | 1.7× |
| scan 10k rows ×3 | 10ms | 2336 ms (85 RT) | 4141 ms | 1.8× |
| insert 300 rows (1 tx) | 0/2/10ms | — | — | 2.0–2.6× |
| blob 1MB write+read ×3 | 0ms | 199 ms (131 RT) | 2809 ms | **14.1×** |
| blob 1MB write+read ×3 | 2ms | 950 ms | 36583 ms | **38.5×** |
| blob 1MB write+read ×3 | 10ms | 3406 ms | 148376 ms | **43.6×** |
| connect+detach ×10 | 10ms | 1438 ms | 1028 ms | 0.7× ¹ |

¹ fast-firebird encrypts the wire by default (op_crypt = +1 RT + SRP256);
node-firebird hardcodes wire crypt off. With `wireCrypt: 'disabled'` the
connect cost is comparable. Everything else: defaults vs defaults.

Blob dominance: node-firebird writes/reads 1024-byte segments (~1000 RTs/MB);
we use 64KB segments (131 RTs for 3×(write+read) of 1MB) — raised to the wire
maximum by default 2026-07-09.

## Results 2026-07-16 (benchmark expansion for open-source release)

Same harness, node-firebird 1.1.10, FB5 container, Node 22.16. New scenario:
`scan 300×8KB blobs` (the "table of memos/documents" shape — per-blob round
trips dominate). 6 SRP connect retries needed by node-firebird during the run.

| Scenario | Delay | fast-firebird | node-firebird | Speedup |
|---|---|---|---|---|
| connect+detach ×10 | 0ms | 192 ms | 194 ms | 1.0× |
| warm 1-row select ×200 | 0ms | 290 ms (600 RT) | 347 ms | 1.2× |
| warm select ×200 (open tx) | 0ms | 110 ms (202 RT) | 287 ms | 2.6× |
| scan 10k rows ×3 | 0ms | 126 ms (91 RT) | 134 ms | 1.1× |
| insert 300 rows (1 tx) | 0ms | 165 ms (307 RT) | 260 ms | 1.6× |
| blob 1MB write+read ×3 | 0ms | 229 ms (80 RT) | 2534 ms | **11.1×** |
| scan 300×8KB blobs | 0ms | 34 ms (21 RT) | 916 ms | **26.7×** |
| warm select ×200 (open tx) | 2ms | 1342 ms | 3846 ms | 2.9× |
| insert 300 rows (1 tx) | 2ms | 2073 ms | 4134 ms | 2.0× |
| blob 1MB write+read ×3 | 2ms | 360 ms (80 RT) | 39156 ms | **108.8×** |
| scan 300×8KB blobs | 2ms | 174 ms (21 RT) | 21414 ms | **123.4×** |
| warm select ×200 (open tx) | 10ms | 4993 ms | 14905 ms | 3.0× |
| scan 10k rows ×3 | 10ms | 2613 ms (91 RT) | 4103 ms | 1.6× |
| insert 300 rows (1 tx) | 10ms | 7498 ms | 15128 ms | 2.0× |
| blob 1MB write+read ×3 | 10ms | 1010 ms (80 RT) | 150037 ms | **148.5×** |
| scan 300×8KB blobs | 10ms | 610 ms (21 RT) | 80882 ms | **132.6×** |

vs the 2026-07-09 run: 1MB blob ×3 dropped 131→80 RT and 950→360 ms @2ms —
the 32-deep segment pipelining shipped 07-10/11. That's why the blob speedup
grew from 14–44× to 11–149× (both drivers re-measured same day, same box).

### Blob strategy matrix (fast-firebird only, 300×8KB, FB5)

Isolates WHERE the speedup comes from. `BENCH_BLOB=1` runs just this matrix.

| Strategy | 0ms | 2ms | 10ms |
|---|---|---|---|
| eager + FB5 inline (default) | 42 ms (21 RT) | 149 ms (21 RT) | 566 ms (21 RT) |
| eager, inline off (pipelined) | 68 ms (217 RT) | 413 ms (217 RT) | 1778 ms (217 RT) |
| stream lazy, on-demand | 362 ms (607 RT) | 4062 ms (607 RT) | 15390 ms (607 RT) |
| stream lazy + blobReadAhead | 327 ms (607 RT) | 3847 ms (607 RT) | 15038 ms (607 RT) |
| stream on-demand + 10ms/row work | 4372 ms | 7546 ms | 18414 ms |
| stream readAhead + 10ms/row work | 3339 ms | 3944 ms | 14690 ms |

Findings, verified not assumed:
- FB5 inline blobs: **zero** blob RTs (21 = prepare/execute/fetch batches).
- Eager pipelining: ~0.7 RT/blob (217 for 300) vs 2 sequential RT/blob lazy.
- `blobReadAhead` does NOT cut RTs (607 both ways — the prefetcher is
  single-flight by design, bounded lock slices). Its value is OVERLAP: with
  10ms/row consumer work it hides the fetches behind the work — 3944 ms @2ms
  ≈ the 3847 ms pure-fetch floor, vs 7546 ms on-demand (1.9×). With zero
  consumer work between rows, readAhead ≈ on-demand — expected, now measured.

## Results 2026-07-18 (re-run vs node-firebird 2.10.0)

Context: node-firebird's 2.x modernization sprint (2.4.0→2.10.0, Jul 13–17 —
TypeScript, promises, batch API, pool, statement cache, protocol 20) made the
1.1.10 comparison indefensible for launch. Re-ran the full suite, defaults vs
defaults, FB5, same harness.

| Scenario | 0ms | 2ms | 10ms |
|---|---|---|---|
| connect+detach ×10 | 0.8× | 1.2× | 1.2× |
| warm 1-row select ×200 (autocommit) | 1.6× | 1.7× | 1.8× |
| warm select ×200 (open tx) | 3.0× | 3.1× | 3.1× |
| 10k-row scan ×3 | 1.1× | 1.3× | 1.7× |
| insert 300 rows (1 tx) | 1.7× | 1.6× | 1.9× |
| 1MB blob write+read ×3 | 21.0× | 115.2× | 151.6× |
| scan 300×8KB blobs | 33.2× | 123.6× | 139.5× |

Findings vs the 1.1.10 numbers:
- The 2.x modernization did NOT change the wire mechanics that dominate these
  workloads: blob reads are still a sequential per-blob open/read/close cycle
  in 1KB chunks (default `blobReadChunkSize: 1024`), so the blob gaps hold
  (and widened slightly at 0ms: 11→21× on 1MB, 27→33× on the memo scan).
- Non-blob gaps essentially unchanged (open-tx selects 3.0–3.1×, inserts
  1.6–1.9×, scans 1.1–1.7×) — their statement cache defaults to OFF
  (`statementCacheSize: 0`) and defaults-vs-defaults is the methodology.
- Bare connect at 0ms remains our one loss (0.8×): wireCrypt on by default.
- Their `maxInlineBlobSize` DPB now works (2.10.0 fixed the tag), but their
  blob-callback read path didn't benefit in this workload.

Blob strategy matrix re-measured same session (README table refreshed):
inline 32/159/582 ms (21 RT), pipelined 60/400/1740 (217 RT), lazy on-demand
314/3700/14695 (607 RT); readAhead+10ms-work 3867 ms at 2ms vs 7352 on-demand
— overlap conclusion from 07-16 unchanged.

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
Harness shipped with M3 (latency proxy, RT counter, markdown report).
Expanded 2026-07-16 for the open-source release: many-small-blobs scan
(pairwise) + fast-firebird blob strategy matrix (inline / pipelined eager /
lazy stream ± readAhead ± consumer work). Re-run 2026-07-18 against
node-firebird 2.10.0 (see Results above) — README tables cite 2.10.0 now.
