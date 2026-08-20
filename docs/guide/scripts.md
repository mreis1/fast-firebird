# Multi-statement scripts

```ts
await db.executeScript(`
  set term ^ ;
  create or alter procedure add_log (msg varchar(100)) as
  begin
    insert into audit_log (message) values (:msg);
  end^
  set term ; ^
  execute procedure add_log('migrated');
`);
```

The parser is isql-faithful: honors `SET TERM`, PSQL bodies (no naive `;`
splitting), string/quoted-identifier/`q'…'` literals, and `--` / `/* */`
comments, with line/column error positions.

`executeScript` supports:

- `transaction: 'perScript' | 'perStatement' | 'none'` — one transaction
  around the whole script, one per statement, or none (each statement
  auto-commits) — **or a `Transaction` instance**: every statement runs on
  YOUR transaction and the script never commits or rolls it back, so a
  migration script composes atomically with your own statements
- `transactionOptions` — `TransactionOptions` for the transaction(s) the
  script opens (`'perScript'`/`'perStatement'`), e.g.
  `{ isolation: 'readCommitted', wait: false }` for fail-fast DDL
- `continueOnError` — collect per-statement errors instead of stopping;
  each failed `StatementResult` carries `error` plus `gdsCode`/`sqlState`
  when the server raised it, so retry-vs-stop classification needs no
  `instanceof` dance (e.g. `335544345` lock conflict → retry)
- `onProgress` — a callback per executed statement (with rows affected)

```ts
// Compose a script with your own work in ONE atomic unit:
const tx = await db.startTransaction({ isolation: 'readCommitted' });
await db.executeScript(migrationDdl, { transaction: tx });
await tx.execute('update schema_version set v = ?', [42]);
await tx.commit(); // or rollback — the script never finishes YOUR tx
```

`parseScript(sql)` is also exported standalone if you only want the
statement-splitting. Each `ParsedStatement` carries `sql`, `line`/`column`,
and `kind: 'ddl' | 'dml' | 'other' | 'client'` — ddl/dml/other is a
leading-keyword heuristic (`EXECUTE BLOCK` is 'other'; it can hide DDL) that
makes commit-after-DDL policies easy to build; 'client' marks the
client-side commands below (exact, with the parsed command in
`statement.client`).

## Client commands

Installer/migration scripts written for isql or IBExpert contain commands
that were never meant for the server: `COMMIT;` between DDL blocks,
`RECONNECT;` to refresh metadata, `SET AUTODDL ON;`. `executeScript`
processes these driver-side, the way an interactive tool does:

| Command | `perScript` (default) | `perStatement` / `'none'` | caller `Transaction` |
|---|---|---|---|
| `COMMIT` / `ROLLBACK` `[WORK]` | Finish the script's transaction and open a fresh one — script-controlled checkpoints | No-op success (statements already autocommit) | Error |
| `COMMIT` / `ROLLBACK` `RETAIN` | `commitRetaining()` / `rollbackRetaining()` | No-op success | Error |
| `SET TRANSACTION <options>` | Restart with the mapped `TransactionOptions` (the current transaction must be clean — `COMMIT`/`ROLLBACK` first); becomes the template for later reopens | `perStatement`: options for subsequent statements; `'none'`: error (that's `defaultTransaction`'s job) | Error |
| `RECONNECT` | Commit, then re-attach on the same `Attachment`, then a fresh transaction | Re-attach between statements | Error |
| `SET AUTODDL ON|OFF` | Commit + reopen after each `kind: 'ddl'` statement | No-op success | Error |

```ts
await db.executeScript(`
  create table cfg (k varchar(30), v varchar(100));
  commit;                       -- checkpoint: cfg survives later failures
  set transaction read committed record_version;
  insert into cfg values ('mode', 'fast');
`);
```

Two rules hold regardless of options:

- **Transaction control never crosses the wire.** `COMMIT`, `ROLLBACK` and
  `SET TRANSACTION` are valid server DSQL — executed server-side they would
  silently finish the transaction the executor manages underneath it. So a
  statement whose head is transaction control is either processed or
  rejected with a named error; a `SET TRANSACTION` variant the driver cannot
  map (`RESERVING …`, `NO AUTO UNDO`, `IGNORE LIMBO`, `READ CONSISTENCY`) is
  rejected by clause name, never forwarded.
- **Savepoints stay server-side.** `SAVEPOINT x`, `RELEASE SAVEPOINT x` and
  `ROLLBACK TO [SAVEPOINT] x` operate safely *inside* the current
  transaction and go to the server as normal DSQL.

Every processed command still yields a `StatementResult` (with
`statement.client` describing what ran) and fires `onProgress`;
`continueOnError` applies to client-command failures like any other
statement. Set `clientCommands: 'error'` to reject them all instead
(strict-DSQL scripts). With a caller-supplied `Transaction` every client
command is an error — the executor never finishes, replaces, or reconnects
what the caller owns.

`SET TRANSACTION` maps grammar-faithfully: bare `READ COMMITTED` means **no**
record version (append `RECORD_VERSION` — or FB4+'s `VERSION` — for
`isolation: 'readCommitted'`), `SNAPSHOT TABLE [STABILITY]` is
`'serializable'`, `LOCK TIMEOUT n` is `wait: n`, and `AUTO COMMIT` is
`autoCommit: true`. Unspecified clauses fall back to the connection's
`defaultTransaction`, like every other transaction the driver starts.

### `Attachment.reconnect()`

`RECONNECT` is powered by a general API: re-attach to the database on the
same `Attachment` object (pools and long-lived references keep working; also
useful to retry after a network drop). Everything created before the
reconnect — `Transaction`s, `PreparedStatement`s, lazy blob handles, event
listeners — throws a clear "attachment was reconnected" error when used;
`roundTrips` keeps counting cumulatively; the statement cache starts fresh.

## Comment-aware preprocessing

Script preprocessors (directive markers, conditional sections) need to know
whether an offset sits inside a comment — and a hand-rolled scanner will
disagree with the parser on exactly the hard cases (q-literals, `--` inside
quoted identifiers, a `/*` inside a string). `commentRanges` and
`stripComments` run the SAME scanner `parseScript` uses, so they cannot
diverge:

```ts
import { commentRanges, stripComments } from '@fast-firebird/core';

const ranges = commentRanges(sql);        // [start, end) index pairs
const active = (idx: number) => !ranges.some(([s, e]) => idx >= s && idx < e);

stripComments(sql);  // comments blanked to spaces, LENGTH-PRESERVING:
                     // newlines survive, so indexes and line/column
                     // positions still match the original
```

Both throw the same `ScriptParseError` (with line/column) that `parseScript`
throws on malformed input.
