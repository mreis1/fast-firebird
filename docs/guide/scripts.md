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
  auto-commits)
- `continueOnError` — collect per-statement errors instead of stopping
- `onProgress` — a callback per executed statement (with rows affected)

`parseScript(sql)` is also exported standalone if you only want the
statement-splitting.
