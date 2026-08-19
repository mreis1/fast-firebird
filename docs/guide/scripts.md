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
and `kind: 'ddl' | 'dml' | 'other'` — a leading-keyword heuristic
(`EXECUTE BLOCK` is 'other'; it can hide DDL) that makes commit-after-DDL
policies (Delphi `AutoDDL` style) easy to build on `parseScript` +
`classifyStatement(sql)`.

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
