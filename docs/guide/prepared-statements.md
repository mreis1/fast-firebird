# Prepared statements & the statement cache

Every connection keeps an LRU cache of prepared statements keyed by SQL text
(`statementCacheSize`, default 64; `0` disables). Measured round trips,
asserted by integration tests on FB 3/4/5/6:

| Operation (inside an open transaction) | Round trips |
|-----------------------------------------|-------------|
| cold query (prepare → rows)             | 2           |
| warm query, one batch                   | **1** (execute + fetch coalesced) |
| warm DML including affected count       | **1** (execute + counts coalesced) |

For hot paths you can also pin a statement explicitly:

```ts
await using stmt = await db.prepare('select name from users where id = ?');
const rows = await stmt.query([42], tx);       // 1 round trip per execution
const one  = await stmt.queryOne([42], tx);
```

Prepared statements also expose [`executeBatch`](./batch) — repeat batches
skip the prepare round trip entirely:

```ts
const stmt = await db.prepare('insert into t (a, b) values (?, ?)');
await stmt.executeBatch(rowsA);
await stmt.executeBatch(rowsB);
await stmt.close();
```

::: warning Metadata-lock caveat (standard Firebird behavior)
A prepared statement — cached or pinned — holds existence locks on the objects
it references, so DDL on those tables from *other* connections waits until the
statement is released. DDL executed through the same connection clears the
cache automatically; `db.clearStatementCache()` / `pool.clearStatementCaches()`
release the handles explicitly before external migrations.
:::
