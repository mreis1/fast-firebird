# Script-runner field report — triage & work plan

Source: a field report from an internal script-runner/installer consumer that
built a migration tool on `parseScript`/`executeScript` (2026-08). Ranked by
the friction it caused them. Confidential project details deliberately omitted.

Status legend: ☐ planned ◐ partial ☑ done

## Batch A — quick wins (one session, no design risk)

### A1 ☑ `StatementResult.error` typing + classification fields (report #3)
`script/execute.ts:10` types the caught error as plain `Error`, hiding
`FirebirdError.gdsCode/sqlState` that every consumer needs for
retry-vs-stop classification (e.g. 335544345 lock conflict → retry;
constraint violation → stop).
- Type it `Error | FirebirdError` AND lift `gdsCode?: number` /
  `sqlState?: string` onto `StatementResult` (populated when the error is a
  `FirebirdError`) so classification needs no `instanceof` dance.
- Unit test over a failing script with `continueOnError`.

### A2 ☑ Naive TIMESTAMP JSDoc (report #5a)
`types/datetime.ts` `encodeTimestamp` uses local wall-clock components
(`getFullYear()/getHours()`) — correct for timezone-naive columns, but
undocumented; a consumer shipped a `toISOString()` banner 2h off before
reading the source. Add JSDoc on the `Date` branch of param binding +
a warning in the types guide page: a JS `Date` binds as LOCAL wall-clock to
naive TIMESTAMP; use `ZonedDate`/`timeZones: 'zoned'` for instants.

### A3 ☑ Document `RETURNING` needs `run()` (report #5b)
`INSERT … RETURNING` yields its row via op_execute2 — `db.run()` exposes it
(`rows[0]` + `rowsAffected`); `queryOne` works but the idiom is undocumented
and consumers guess wrong. Add an example to README + `docs/guide/queries.md`
(the "everywhere" Firebird idiom: `insert … returning id` → `db.run(...)`).

### A4 ☑ `ParsedStatement.kind` hint (report #4)
`kind: 'ddl' | 'dml' | 'other'` from the leading keyword(s), enabling
Delphi-style `AutoDDL` (commit after DDL) emulation without a per-statement
transaction for everything.
- ddl: CREATE / ALTER / DROP / RECREATE / COMMENT / GRANT / REVOKE /
  SET GENERATOR / DECLARE (filter/external).
- dml: INSERT / UPDATE / DELETE / MERGE / UPDATE OR INSERT / EXECUTE PROCEDURE.
- other: SELECT, EXECUTE BLOCK, SET TRANSACTION, COMMIT/ROLLBACK, etc.
- Documented as a HEURISTIC (EXECUTE BLOCK can hide DDL via
  EXECUTE STATEMENT). Unit tests per keyword incl. leading comments/quoted
  identifiers before the keyword.

## Batch B — executeScript transaction control (report #1, the blocker)

### B1 ☑ `transactionOptions` + caller-supplied `Transaction`
This blocked the consumer outright: `executeScript` calls bare
`startTransaction()` (`script/execute.ts:67/80`), so per-script isolation /
nowait was unreachable and they rebuilt ~40 lines around `parseScript`.
`defaultTransaction` (shipped 2026-08-18) already reaches these implicitly —
but per-script control and composition with caller work still need:
```ts
export interface ExecuteScriptOptions extends ParseScriptOptions {
  transaction?: 'perScript' | 'perStatement' | 'none' | Transaction;
  transactionOptions?: TransactionOptions; // for the modes that open one
}
```
- `Transaction` instance: run every statement on it; NEVER commit/rollback it
  (caller owns the lifecycle); on error without `continueOnError`, throw and
  leave the tx alive. `transactionOptions` + instance together = error.
- `transactionOptions` ignored for 'none'? No — 'none' uses `attachment.run`
  whose implicit tx already honors `defaultTransaction`; document that
  `transactionOptions` applies to 'perScript'/'perStatement' only (throw or
  document-ignore for 'none' — decide at implementation; leaning throw).
- Integration tests: perScript with `{ wait: false }`; caller-tx composition
  (script + caller statements commit atomically; rollback undoes both).

### B2 ☐ (optional, demand-driven) `transaction: 'autoDdl'`
Commit-after-DDL mode built on A4's `kind`. Parked until someone asks —
A4 + 'perStatement'/caller-loop already lets consumers emulate it.
**2026-08-19: absorbed into `plans/script-client-commands.md`** — delivered
as script-driven `SET AUTODDL ON` processing (phase 2 there).

## Batch C — comment/string-aware scanning API (report #2)

### C1 ☑ `commentRanges(sql)` / `stripComments(sql)`
Consumers preprocessing scripts (e.g. directive markers in comments) need to
know whether index N is inside a comment. The parser already owns this logic
(`skipLineComment`/`skipBlockComment`/quote/q-literal handling) but exposes
none of it — so they hand-rolled a scanner, with divergence risk on exactly
the hard cases (q-literals, `--` inside quoted identifiers, `/*` inside
strings).
- Refactor: extract one shared low-level scanner used by BOTH `parseScript`
  and the new functions, so consistency is guaranteed by construction —
  that, not the 35 saved lines, is the point.
- API: `commentRanges(sql): Array<[start, end]>` (end exclusive) and
  `stripComments(sql): string` (comments → single space, positions otherwise
  preserved? decide: length-preserving replacement keeps indexes valid —
  leaning length-preserving with spaces).
- Unit tests: q-literals `q'{…}'`, quoted identifiers containing `--`,
  `/*` inside string literals, unterminated comment at EOF, nested `/*` (not
  nested in Firebird), `SET TERM` interplay irrelevant by design.

## Batch D — services: nbackup (report #6)

### D1 ☑ Typed `nbackup` / `nrestore`
gbak-style `backup`/`restore` exist (`services/service.ts:124/139`); nbackup
doesn't — and physical incremental backup (`-L` lock / copy / `-N` unlock,
or level-based deltas) is what maintenance windows actually use on multi-GB
databases. Buildable today via `serviceStart(spb)` but that defeats a typed
driver.
- Actions: `isc_action_svc_nbak` / `isc_action_svc_nrest` (+ FB4 GUID-based
  increments). SPB items: `nbk_level`, `nbk_file`, `nbk_direct`,
  `nbk_no_triggers`, `nbk_guid`.
- API sketch: `svc.nbackup({ database, file, level })` (or `{ guid }` on
  FB4+), `svc.nrestore({ database, files: [...] })`, options for
  direct/no-triggers.
- Integration tests: level-0 backup → level-1 → nrestore into a fresh path →
  connect and verify rows. Files live inside the container FS — restore into
  a new database path under the project volume and query it (no host access
  needed).
- Follow-on (separate item): gfix-family (validation/sweep/shutdown) via the
  same pattern.

## Sequencing
1. **Session 1: B1 + A1–A4** — B1 is the reported blocker and is small now
   that `defaultTransaction` exists; A items are near-free and ride along.
2. **Session 2: C1** — parser refactor with its own test surface.
3. **Session 3: D1** — new service actions + container-side verification.

## Explicitly praised — do not regress
Lazy-blob error message listing its three fixes; `parseScript` deliberately
NOT tracking `BEGIN…END` (isql-faithful, FrontendLexer.cpp rationale comment);
`lowercaseKeys: false` default; `blobs: 'lazy-binary'` default.
