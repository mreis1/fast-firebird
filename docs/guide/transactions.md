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
read-only mode, and lock-wait behavior (`wait: seconds | false | true`,
where `true` is Firebird's unbounded wait).

`restart` reuses the same `Transaction` object (its `handle` changes) — handy
for long-running loops that periodically checkpoint. Lazy blob handles from
before a restart become invalid (reading one throws `FirebirdBlobError`).

## Connection-wide transaction defaults

Without options, every transaction — including the implicit one behind
`db.query`/`execute`/`executeBatch`/`queryStream`/`executeScript` — uses
snapshot / read-write / **lock wait 10 s**. Isolation and access mode are
Firebird's classic defaults; the lock wait deliberately is not: Firebird's
native default is WAIT with no timeout, so any lock conflict — or DDL
against metadata pinned by a prepared statement in *any* connection — reads
as a hang. With the driver default, blocked work fails after 10 s with a
clear "lock time-out on wait transaction" error; opt back into unbounded
waiting explicitly with `wait: true`. Snapshot isolation still pins garbage
collection, so high-concurrency services usually want read committed too.
Set it once with `defaultTransaction`; per-call options still override
field-by-field:

```ts
const db = await connect({
  // …
  defaultTransaction: {
    isolation: 'readCommitted',   // per-statement visibility, GC-friendly
    readOnly: true,               // reads are near-free for the server
    wait: 5,                      // lock conflicts fail after 5s, never hang
    autoUpgradeReadOnly: true,    // one-shot writes upgrade + replay transparently
  },
});

await db.query('select …');                          // read committed, read-only
await db.execute('insert …');                        // auto-upgrades to read-write
await db.transaction(fn, { isolation: 'snapshot' }); // per-call override wins
```

The pool passes connect options through, so pooled connections inherit the
same defaults. `executeBatch` is the one exception: it always opens its
implicit transaction read-write (batch is DML by contract and is not
upgrade-replayed).

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
