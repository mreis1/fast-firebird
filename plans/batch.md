# Wire batch API (backlog #17) — bulk DML in one round trip

Status: implementing (2026-07-20). FB4+/protocol ≥ 16. Public API:
`executeBatch(sql, rows, options?)` on Attachment / Transaction / Pool /
PreparedStatement.

## Wire protocol (verified against firebird v5.0.1 + jaybird master sources)

Sources read for this plan: `src/remote/protocol.cpp` (op encodings,
`xdr_packed_message`), `src/remote/server/server.cpp` (`rem_port::batch_*`),
`src/dsql/DsqlBatch.{h,cpp}` (buffer limits, blob registration, PB tags),
jaybird `V16Statement.java` + `wire/DefaultBlrCalculator.java`
(`calculateBatchMessageLength`, descriptor-driven BLR). Op codes 99–106 were
already in `constants.ts` (099 create, 100 msg, 101 exec, 102 rls, 103 cs,
104 regblob, 105 blob_stream, 106 set_bpb; cancel=109/sync=110 are p17+).

- **op_batch_create (99)**: int32 stmt handle · opaque BLR (input message
  format) · uint32 msglen · opaque PB. The server parses OUR BLR into the
  batch message format (`PARSE_msg_format`) and validates msglen against it
  (`InternalMessageBuffer`). One batch per statement (`isc_batch_open` if a
  second create arrives before release).
- **op_batch_msg (100)**: int32 stmt handle · uint32 count · count packed
  messages back-to-back. Each packed message = null bitmap (xdr_opaque,
  4-padded) + non-NULL values XDR-encoded — byte-identical to the protocol-13
  `op_execute` message encoding, but against the FIXED format from create.
- **op_batch_exec (101)**: int32 stmt handle · int32 tx handle. Replies with
  **op_batch_cs (103)** (or an error op_response): int32 stmt · uint32
  reccount · uint32 updates · uint32 vectors · uint32 errors · updates×int32
  per-row update counts · vectors×(uint32 pos + status vector) ·
  errors×uint32 pos (status-less; beyond TAG_DETAILED_ERRORS cap).
- **op_batch_regblob (104)**: int32 stmt · 8-byte existing blob id · 8-byte
  batch blob id. We upload blobs with the existing `writeBlob` machinery and
  register each id as itself (jaybird does the same). The remote server
  rewrites TAG_BLOB_POLICY to BLOB_STREAM internally; client sends
  BLOB_ID_USER when blob params exist.
- **op_batch_rls (102)**: int32 stmt handle. Deferred (rides next packet),
  like op_free_statement.
- **PB**: WideTagged clumplets — buffer tag byte `IBatch::VERSION1 (1)`, then
  per clumplet: tag byte + uint32 LE length + LE int value. Tags:
  MULTIERROR=1, RECORD_COUNTS=2, BUFFER_BYTES_SIZE=3, BLOB_POLICY=4,
  DETAILED_ERRORS=5 (server caps at 64×4; default 64).
- Server buffer: `BUFFER_LIMIT` 16 MiB default (HARD 256 MiB). Data budget
  counted as `alignedStride × rows`, stride = `FB_ALIGN(msglen, 8)`.

### One round trip

create + all msg chunks + exec go out in ONE flush; responses come back FIFO
(create response, one per msg, then batch_cs) because both sides run
ptype_lazy_send. We read them **explicitly in order** — no deferred-response
drop — so a create/msg error (e.g. isc_batch_too_big) surfaces as itself, not
as a misleading downstream failure. On error mid-sequence the remaining
expected responses are marked deferred so the reader drains them (same
pattern as executeStatement's piggyback error path).

## Fixed-format strategy (the key design decision)

Batch differs from our normal execute path: normal execute sends a
**value-driven** BLR per call; batch fixes ONE format at create for all rows.
We therefore build the format from the statement's **described inputs**, but
emit our own wire-friendly types and let the server coerce (CVT), exactly as
it already does for our value-driven messages:

| described input          | emitted BLR              | wire encoding per row |
|--------------------------|--------------------------|------------------------|
| TEXT / VARYING           | varying(desc.length)     | uint32 count + bytes + pad (codec-encoded; length-checked) |
| SHORT / LONG (scale s)   | long(s)                  | int32, value scaled client-side (exact decimal-string shift) |
| INT64 (scale s)          | int64(s)                 | 8-byte BE |
| INT128 (scale s)         | int128(s)                | 16-byte BE |
| FLOAT                    | float                    | 4-byte |
| DOUBLE / D_FLOAT         | double                   | 8-byte |
| DATE / TIME / TIMESTAMP  | timestamp                | days+fractions (server truncates to date/time — same as the value-driven path today) |
| TIMESTAMP_TZ(_EX)        | timestamp_tz             | days+frac+tzId (never EX; ZonedDate, or Date as UTC offset-zone) |
| TIME_TZ(_EX)             | sql_time_tz              | frac+tzId |
| BLOB / QUAD / ARRAY      | quad(0)                  | 8-byte id (uploaded + regblob'd beforehand) |
| DEC16 / DEC34            | dec64 / dec128           | raw DPD (prepareParams already coerces) |
| BOOLEAN                  | bool                     | 1 byte + pad |

`msglen` is computed for the EMITTED types with the engine's layout rules
(jaybird's calculateBatchMessageLength table): per field, align to the
type's alignment then add its internal length (varying = len+2 align 2,
long 4/4, int64 8/8, int128 16/8, double 8/8, timestamp 8/4,
timestamp_tz 10/4, time_tz 6/4, quad 8/4, dec64 8/8, dec128 16/8, bool 1/1),
then align 2 + 2 for the null-indicator short after every field.

Scaled columns: values (number|bigint|string) are converted with exact
decimal-string arithmetic (no float multiply), rounding half-away-from-zero
on excess fraction digits — matching server text→numeric coercion.

## Execution flow (api/batch.ts)

1. Gate: `wire.protocolVersion >= 16` else FirebirdError (FB3 = protocol 13).
   Statement must have inputs; outputs (RETURNING) are rejected client-side.
2. Named params: `rewriteNamedParams` once; object rows bound per row,
   array rows pass through (same rules as PreparedStatement).
3. Prepare via statement cache (same reuse/stale-retry semantics as
   runStatement); rows run through the existing `prepareParams` (arity check,
   blob upload, DECFLOAT/INT128 coercions) then `encodeBatchRow`.
4. Sub-batch cycles bound memory AND stay under the server's 16 MiB batch
   buffer: rows accumulate until `alignedStride × n ≥ chunkBytes`
   (default 8 MiB) → create (first cycle) + regblobs + msg(s) + exec in one
   flush → read completion → next cycle. Blob uploads for a cycle happen
   BEFORE its batch ops are written, so the wire is clean for writeBlob's own
   round trips.
5. Combine per-cycle completions (indices offset by rows already submitted).
   Release: op_batch_rls (deferred) + finishStatement (cache/drop).

## Error semantics

- Default (`continueOnError` unset): server stops at first failed row
  (MULTIERROR off) → we throw `FirebirdBatchError` (extends FirebirdError)
  carrying `.index` (0-based row) and `.result` (partial BatchResult). In the
  own-transaction wrappers nothing commits.
- `continueOnError: true` (MULTIERROR on): resolves with
  `errors: {index, error}[]`; successful rows commit (own-tx) / remain
  pending (in-tx). Rows beyond the detailed-errors cap come back status-less
  → `error: null`.
- `BatchResult`: `{ rowCount, rowsAffected, updateCounts: number[],
  errors: BatchRowError[] }`. updateCounts uses -1 for "failed" and counts
  from TAG_RECORD_COUNTS otherwise; rowsAffected = Σ counts ≥ 0.

## Out of scope (follow-ups)

- op_batch_blob_stream inline blob transport (we use upload+regblob; already
  correct, one extra RT per blob — the streaming transport is a perf upgrade).
- op_batch_set_bpb, op_batch_cancel/sync (p17+), op_info_batch.
- exec_procedure batches with RETURNING.

## Test plan

- Unit (no server): msglen table per type, BLR bytes, row encoding (bitmap,
  varying, null skip), exact scaled-decimal conversion incl. rounding, PB
  clumplet bytes.
- Integration (FB4/5/6; FB3 asserts the clear unsupported error): 1000-row
  insert (counts + select-back), full type-matrix round trip, named-param
  rows, nulls, error row throw ± continueOnError, tiny chunkBytes forcing
  multi-cycle, blob params (text+binary), update-statement batch, RETURNING
  rejection, in-tx rollback, round-trip budget (cached stmt, blob-less:
  ≤ 2 flushes for the whole batch).
