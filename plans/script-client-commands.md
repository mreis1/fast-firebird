# Script client-commands: RECONNECT, COMMIT/ROLLBACK, SET TRANSACTION, AUTODDL

**Goal:** `executeScript` should *process* client-side script commands the way
an interactive tool does, instead of shipping them to the server (where they
either die as unknown tokens — `RECONNECT` — or, worse, execute as DSQL and
silently corrupt the executor's transaction bookkeeping — `COMMIT`).

Status legend: ☐ planned ◐ partial ☑ done

## Why (current behavior is a latent bug)

Today every parsed statement goes to the server as DSQL:

| Script line | Today | Problem |
|---|---|---|
| `COMMIT;` / `ROLLBACK;` | **Executes** (they ARE in the server's DSQL grammar, `parse.y` `tra_statement`) | Finishes the executor's `perScript` transaction underneath it → the executor's own later `commit()` throws "invalid transaction handle"; script state silently wrong |
| `SET TRANSACTION …;` | Executes or errors | Fights the transaction the executor already opened |
| `RECONNECT;` | Server error "Token unknown" | It's a client command (IBExpert-style; not even isql grammar) — installers use it after DDL to refresh metadata |
| `SET AUTODDL ON;` | Server error | isql client command; the Delphi-`AutoDDL` behavior consumers emulate by hand |

So intercepting is not just a feature — for `COMMIT`/`ROLLBACK`/`SET
TRANSACTION` it fixes broken semantics. That justifies **process-by-default**.

## The operator model

### 1. Recognition (parser layer — purely lexical, no execution)

New in `script/parser.ts`, reusing `stripComments` (comment-tolerant,
case-insensitive, word-boundary matching on the statement head):

```ts
export type ClientCommand =
  | { op: 'reconnect' }
  | { op: 'commit'; retain: boolean }        // COMMIT [WORK] [RETAIN]
  | { op: 'rollback'; retain: boolean }      // ROLLBACK [WORK] [RETAIN]
  | { op: 'setTransaction'; options: TransactionOptions; raw: string }
  | { op: 'setAutoDdl'; on: boolean };       // SET AUTODDL ON|OFF (isql also: SET AUTO)

export function classifyClientCommand(sql: string): ClientCommand | null;

export interface ParsedStatement {
  sql: string; line: number; column: number;
  kind: StatementKind;            // gains the value 'client'
  client?: ClientCommand;         // set iff kind === 'client'
}
```

Recognition rules (exact, to avoid false positives):
- `RECONNECT` — the whole statement is that single word.
- `COMMIT` / `ROLLBACK` — bare, or followed only by `WORK` and/or `RETAIN`.
  **`ROLLBACK TO [SAVEPOINT] x` is NOT a client command** — it's real DSQL
  inside the current transaction and keeps going to the server. Same for
  `SAVEPOINT x` / `RELEASE SAVEPOINT x`.
- `SET TRANSACTION <options>` — full statement; options parsed (below).
- `SET AUTODDL ON|OFF` / `SET AUTO ON|OFF` — isql spelling; bare `SET AUTODDL`
  (isql's toggle form) → error "use ON or OFF" (a toggle depends on invisible
  state; scripts should be explicit).

`StatementKind` union gains `'client'` (semver-minor; noted in release notes —
exhaustive switches downstream must add a case).

### 2. SET TRANSACTION option mapping

isql/DSQL clause → `TransactionOptions`:

| Clause | Maps to |
|---|---|
| `READ WRITE` / `READ ONLY` | `readOnly: false / true` |
| `WAIT` / `NO WAIT` | `wait: true / false` |
| `LOCK TIMEOUT n` | `wait: n` |
| `ISOLATION LEVEL SNAPSHOT` (or bare `SNAPSHOT`) | `isolation: 'snapshot'` |
| `SNAPSHOT TABLE [STABILITY]` | `isolation: 'serializable'` |
| `READ COMMITTED RECORD_VERSION` (FB4+ spelling: `VERSION`) | `isolation: 'readCommitted'` |
| bare `READ COMMITTED`, or `… NO RECORD_VERSION`/`NO VERSION` | `isolation: 'readCommittedNoRecVersion'` — **grammar-faithful** (parse.y `version_mode` defaults to NO rec version; an earlier draft of this table mapped bare READ COMMITTED to rec_version — corrected 2026-08-20 during implementation) |
| `AUTO COMMIT` | `autoCommit: true` (real grammar, parse.y `tran_option`) |
| `NO AUTO UNDO`, `IGNORE LIMBO`, `RESERVING …`, `READ CONSISTENCY`, `SNAPSHOT AT NUMBER n`, `RESTART REQUESTS`, `AUTO RELEASE TEMP BLOBID` | **error** with a clear message (unsupported clause named) — no silent dropping |

`READ COMMITTED READ CONSISTENCY` (FB4+) is a candidate for a new
`IsolationLevel` (`isc_tpb_read_consistency` = 22) — separate decision,
tracked as an open question; until then it errors honestly.

### 3. Execution (executor layer — the dispatch)

`ExecuteScriptOptions.clientCommands?: 'process' | 'error'`
- **`'process'` (default):** intercept and perform driver-side.
- **`'error'`:** throw on the first client command (strict-DSQL scripts).

There is deliberately **no raw pass-through mode** (an earlier draft had
`'send'`, dropped 2026-08-20): its only effect would be to reproduce the
desync bug — a server-executed `COMMIT` kills the wrapper transaction under
the executor, which no correct program can depend on — and it would be the
one configuration that defeats the wire guard below.

#### Wire guard — transaction control never crosses the wire

Independent of the `clientCommands` setting and of the transaction mode,
`executeScript` enforces one invariant as defense in depth: **a statement
recognized as transaction-control (`COMMIT`/`ROLLBACK` heads except
`ROLLBACK TO …`, and `SET TRANSACTION`) is NEVER transmitted to the
server.** Every path either processes it or rejects it with a clear error —
there is no fall-through to the wire:

- `clientCommands: 'error'` → rejected (that's the mode's contract).
- Caller-supplied `Transaction` mode → rejected ("the caller owns the
  transaction"), never sent.
- `SET TRANSACTION` in `'none'` mode → rejected, never sent.
- A `SET TRANSACTION` whose clauses the mapper does not understand
  (`RESERVING …`, `READ CONSISTENCY`, future syntax) → **rejected by name**,
  never sent — an unparseable variant must not sneak to the server just
  because the recognizer gave up. This is why the recognizer keys on the
  statement HEAD (`commit` / `rollback` / `set transaction`) and only then
  parses details: head match decides "ours, never wire"; detail parsing
  decides "process vs. error".
- `RECONNECT`/`SET AUTODDL` need no guard (the server rejects them as
  unknown tokens anyway) but follow the same process-or-reject dispatch for
  uniformity.

Statements that are transaction-*related* but safe inside the current
transaction (`SAVEPOINT x`, `RELEASE SAVEPOINT x`, `ROLLBACK TO [SAVEPOINT]
x`) intentionally stay server-side — they cannot invalidate the executor's
handle. `EXECUTE BLOCK` bodies cannot commit the attachment's transaction
(PSQL has no COMMIT; autonomous transactions are their own handles), so they
are not a vector.

Dispatch per transaction mode — the core semantics table:

| Command | `perScript` | `perStatement` / `'none'` | caller `Transaction` |
|---|---|---|---|
| `COMMIT` | Commit wrapper tx, **open a fresh one** (same `transactionOptions`, or the last `SET TRANSACTION`) — script-controlled checkpoints | No-op success (each statement already autocommits; isql-targeted scripts sprinkle COMMIT — failing them would be hostile) | **Error** — the executor promised never to finish the caller's tx |
| `ROLLBACK` | Rollback wrapper tx, open a fresh one | No-op success | **Error** |
| `COMMIT/ROLLBACK RETAIN` | `commitRetaining()`/`rollbackRetaining()` on the wrapper | No-op success | **Error** |
| `SET TRANSACTION` | If the current tx is **dirty** (statements ran since it opened) → error "COMMIT or ROLLBACK first" (isql behavior); if clean → restart it with the mapped options; options also become the template for post-COMMIT reopens | Becomes the options for subsequent per-statement transactions (`perStatement`); **error** in `'none'` (its implicit transactions aren't configurable — that's `defaultTransaction`'s job) | **Error** |
| `RECONNECT` | Commit current tx if dirty (installer scripts expect work kept — same choice isql makes for `EXIT`), then `attachment.reconnect()`, then open a fresh tx | `attachment.reconnect()` between statements | **Error** — the caller owns the connection |
| `SET AUTODDL ON` | From here on, after each `kind === 'ddl'` statement: commit wrapper + reopen (delivers parked plan item B2, script-driven) | No-op (already autocommit) | **Error** |
| `SET AUTODDL OFF` | Stop the above | No-op | **Error** |

Every processed command still produces a `StatementResult` (rowsAffected 0,
`statement.client` says what ran) and fires `onProgress` — script tooling sees
a complete, ordered trace. `continueOnError` applies to client-command
failures like any other statement.

### 4. `Attachment.reconnect()` (new core API — the prerequisite)

`RECONNECT` needs the driver to re-attach **the same `Attachment` object**
(the executor — and every other holder of the reference — must keep working).
This is independently valuable (retry-after-network-drop; the nf2-ext swap's
`retryConnectionInterval`).

- **Mutability refactor:** `wire`, `dbHandle`, `handshake` are `readonly`
  constructor params today, and `session` captures them by value
  (`attachment.ts:35-42`) — switch to private mutable fields behind public
  getters; `SessionContext` reads wire/dbHandle through the attachment (or is
  rebuilt on reconnect, which also resets the statement cache and inline-blob
  cache correctly).
- **Sequence:** fail if a transaction is active at the attachment level? No —
  the attachment doesn't track open transactions today; instead: bump an
  attachment **generation** counter; close the old wire (best-effort
  `op_detach`, then socket close); `Transport.connect` + handshake + attach
  from the retained `ResolvedOptions`; rebuild session (fresh statement
  cache, fresh inline-blob cache, re-announce inline blob size).
- **Invalidation:** everything born before the reconnect — `Transaction`s,
  `PreparedStatement`s, lazy `Blob` handles, `EventListener`s — is dead.
  `txAlive`/handle checks gain the generation guard so stale objects throw a
  clear "attachment was reconnected" error instead of talking to the wrong
  handles. Event channels: closed on reconnect; subscribers get an error
  event (re-subscribing is the caller's decision).
- **Counters:** `roundTrips` becomes cumulative across reconnects (keep a
  base offset), so perf assertions stay monotonic.
- **Pool note:** a pooled connection that reconnects stays the same object —
  pool bookkeeping unaffected; document that `pool.use(fn)` callbacks may
  reconnect safely.

### 5. Explicitly out of scope (and why)

- `CONNECT '…' USER … PASSWORD …` / `CREATE DATABASE` / `DROP DATABASE` as
  script commands — credentials in scripts and connection identity changes
  are security- and ownership-sensitive; the API forms exist. If real demand
  appears, the extensible path is an `onClientCommand` hook (phase 3
  decision), not built-ins.
- `INPUT file` — filesystem access from script content; same reasoning.
- `SHOW …`, `SET STATS/ECHO/NAMES/SQL DIALECT`, `SHELL`, `BLOBDUMP` — no
  sensible library semantics.
- `EXIT` / `QUIT` (commit-and-stop / rollback-and-stop) — cheap and
  well-defined; phase 2 nice-to-have, not core.

## Phasing

### Phase 1 ☑ — recognizer + transaction control + RECONNECT (2026-08-20)
1. ☑ `Attachment.reconnect()` (mutability refactor — wire/handshake/dbHandle/
   session are private mutable behind getters, shared `establish()` with
   `open()`; generation guard on Transaction/PreparedStatement/lazy blobs;
   event listeners get an `'error'` and the channel closes; cumulative
   `roundTrips`; failed re-establish leaves the attachment retryable).
2. ☑ Parser: `classifyClientCommand`, `kind: 'client'`, `client` field.
   Implementation note: the recognizer is TOTAL — it never throws; an
   unprocessable head-match comes back as `{ op: 'unsupported', reason }`
   so the executor rejects it by name (this is how the wire guard composes
   with `continueOnError`).
3. ☑ Executor: `clientCommands` option + full dispatch + wire guard.

### Phase 2 ☑ — SET TRANSACTION + AUTODDL (2026-08-20, same session)
4. ☑ `SET TRANSACTION` mapping (grammar-verified against parse.y, incl. the
   bare-READ-COMMITTED correction above) + dirty-tx rule + named rejections.
5. ☑ `SET AUTODDL ON|OFF` (perScript commit-after-DDL; no-op in autocommit
   modes; bare toggle rejected — "use ON or OFF"). Closes parked B2 in
   `plans/script-runner-feedback.md`.

### Phase 3 ☐ — decide, don't build yet
6. `onClientCommand` hook for tool-specific commands; `EXIT`/`QUIT`;
   `READ CONSISTENCY` isolation level.

## Risks / decisions

- ☑ **Default `'process'`, no `'send'` mode** — DECIDED 2026-08-20 (Marcio):
  processing is a bug fix (a server-executed COMMIT desyncs the executor);
  a raw pass-through would be the one config that defeats the wire guard,
  and nothing correct can depend on the old behavior. Release-notes entry.
- ☑ **Wire guard is unconditional** — DECIDED 2026-08-20 (Marcio):
  transaction-control statements are processed or rejected, never
  transmitted, regardless of options/mode.
- **`kind` union widens** with `'client'` — semver-minor with a note.
- **RECONNECT commits a dirty tx** (vs erroring or rolling back) — chosen to
  match installer expectations and isql's `EXIT`; confirm.
- **`perStatement` no-op COMMIT** (vs error) — chosen for isql-script
  compatibility; confirm.
- Docs to update: scripts guide (new "Client commands" section + semantics
  table), README scripts blurb, migration guide (isql compatibility matrix).
- Open (out of executeScript scope, noted while securing this): a direct
  `db.run('COMMIT')` / `tx.run('COMMIT')` has the same desync property at
  the API level. A future hardening could reuse `classifyClientCommand` to
  reject transaction-control DSQL in `run()` paths with a pointer to
  `tx.commit()` — separate decision, not part of this plan's phases.
