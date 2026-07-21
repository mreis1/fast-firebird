# Performance

## vs node-firebird 2.x

Measured against `node-firebird` **2.10.0** (the current, substantially
modernized 2.x line — re-measured 2026-07-18) on Firebird 5 with an
in-process latency proxy (`pnpm --filter @fast-firebird/benchmarks bench`),
defaults vs defaults. Columns are one-way link delay (RTT ≈ 2×):

| Scenario | 0ms | 2ms | 10ms |
|---|---|---|---|
| warm select ×200 (open tx) | 3.0× | 3.1× | 3.1× |
| 10k-row scan | 1.1× | 1.3× | 1.7× |
| 300-row insert (1 tx) | 1.7× | 1.6× | 1.9× |
| **1MB blob write+read** | **21×** | **115×** | **152×** |
| **scan 300 rows × 8KB blobs** | **33×** | **124×** | **140×** |

Blobs dominate because node-firebird reads each blob sequentially through a
per-blob open/read/close cycle in 1KB chunks (its default
`blobReadChunkSize`) — ~1000 round trips per MB; fast-firebird uses 64KB
segments with deep pipelining — and on FB 5.0.2+ small blobs ride inline with
the rows for zero extra round trips.

The one case where fast-firebird is slower — bare connect+detach on a 0ms
link (0.8×) — is because it encrypts the wire by default (SRP256 +
`op_crypt`); pass `wireCrypt: 'disabled'` to match.

::: tip Reproduce it
The benchmark harness lives in the repository
(`packages/benchmarks`) — same compose file as the test suite, methodology in
the source. Run `pnpm --filter @fast-firebird/benchmarks bench` against the
`pnpm fb:up` container matrix.
:::

## Where the blob speedup comes from

The same 300×8KB scan run under each of fast-firebird's blob strategies
(round trips include prepare/execute/fetch; the scan itself is ~21):

| Strategy | 0ms | 2ms | 10ms |
|---|---|---|---|
| eager + FB5 inline blobs (default) | 32 ms (21 RT) | 159 ms (21 RT) | 582 ms (21 RT) |
| eager, inline off (pipelined open/read/close) | 60 ms (217 RT) | 400 ms (217 RT) | 1740 ms (217 RT) |
| `queryStream` lazy, on-demand | 314 ms (607 RT) | 3700 ms (607 RT) | 14695 ms (607 RT) |
| `queryStream` lazy + `blobReadAhead`, 10ms/row consumer work | 3295 ms | 3867 ms | 14566 ms |
| `queryStream` lazy on-demand, 10ms/row consumer work | 3725 ms | 7352 ms | 17902 ms |

Reading the table: FB5 inline blobs eliminate blob round trips entirely (21
vs 217); eager pipelining amortizes open/read/close across the batch (~0.7 RT
per blob vs 2 sequential ones on the lazy path). `blobReadAhead` doesn't cut
round trips — it overlaps them with your per-row processing: with 10ms of
consumer work per row (a disk write, an image resize), read-ahead hides the
blob fetches almost completely at 2ms link delay (3.9s ≈ the 3.7s pure-fetch
floor, vs 7.4s on-demand). Use eager (the default) when rows fit in memory;
stream + read-ahead when they don't.

## Round-trip design

Why the driver wins on ordinary queries too:

- statement allocate+prepare pipelined into one round trip (lazy-send)
- execute+first-fetch and execute+record-counts coalesced into single packets
- deferred `op_free_statement`/`op_close_blob` (they ride the next packet)
- adaptive fetch batching sized from the described row width
- [`executeBatch`](./batch): thousands of DML rows per round trip

`Attachment.roundTrips` exposes the flush counter for your own budget
assertions — many of the driver's own tests assert exact counts.
