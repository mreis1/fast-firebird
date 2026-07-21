# Transactions

Without an explicit transaction, every call runs in its own auto-committed
transaction. To group work, use the callback form (commit on success, rollback
on error) or manage one explicitly:

```ts
// Callback form — commit/rollback handled for you:
await db.transaction(async (tx) => {
  await tx.execute('insert into users (id, name) values (?, ?)', [2, 'Alice']);
});

// Explicit form:
const tx = await db.startTransaction({ isolation: 'readCommitted', readOnly: true });
const rows = await tx.query('select first 1 1 as v from rdb$database');

await tx.restart();                        // commit + reopen, same strategy
await tx.restart({ action: 'rollback' });  // rollback + reopen, same strategy
await tx.restart({ readOnly: false });     // commit + reopen with a new strategy

await tx.execute('insert into t (id) values (?) returning id', [1]);
await tx.commit();
```

Options cover isolation (`readCommitted`, `snapshot`, `consistency`),
read-only mode, and lock-wait behavior (`wait: true | false | seconds`).

`restart` reuses the same `Transaction` object (its `handle` changes) — handy
for long-running loops that periodically checkpoint. Lazy blob handles from
before a restart become invalid (reading one throws `FirebirdBlobError`).

## Nested transactions (savepoints)

`tx.transaction(fn)` runs `fn` inside a SAVEPOINT: released on success,
rolled back to on error — the outer transaction survives either way, and
scopes nest arbitrarily:

```ts
await db.transaction(async (tx) => {
  await tx.execute('insert into audit (msg) values (?)', ['always kept']);
  await tx.transaction(async () => {
    await tx.execute('insert into risky (x) values (?)', [1]);
    throw new Error('undo just this part');
  }).catch(() => {});
  // the audit row survives; the risky row was rolled back
});
```

## `await using` (explicit resource management)

`Attachment`, `Transaction`, `Pool`, and `PreparedStatement` implement
`Symbol.asyncDispose`:

```ts
{
  await using tx = await db.startTransaction();
  await tx.execute('insert into t (id) values (1)');
  await tx.commit();        // without this line, scope exit ROLLS BACK
}
```

Disposal semantics: an attachment disconnects, an uncommitted transaction
rolls back, a pool closes, a prepared statement is freed.

## Read-only auto-upgrade (opt-in)

Some codebases run read-mostly transactions and occasionally write. With
`autoUpgradeReadOnly` (per transaction, or as a connection-wide default), a
write that fails with *"attempted update during read-only transaction"* makes
the driver commit the (write-free) read-only transaction, reopen it read-write
with the same isolation, and replay that statement once:

```ts
const tx = await db.startTransaction({ readOnly: true, autoUpgradeReadOnly: true });
await tx.execute('insert into audit (msg) values (?)', ['late write']); // upgrades + replays
tx.autoUpgraded; // true
```

::: warning Honest caveats
The upgrade is a real commit + new transaction (the snapshot moves forward and
earlier lazy blob handles die), and only `query`/`run`/`execute` replay —
`queryStream` and prepared statements don't. Off by default.
:::
