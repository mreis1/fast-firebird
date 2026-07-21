# Bulk writes: `executeBatch` (Firebird 4+)

Inserting rows one `execute()` at a time costs one round trip **per row** — on
a real network that dominates everything else. `executeBatch` uses Firebird's
wire batch API (`op_batch_create/msg/exec`, protocol ≥ 16): all rows travel to
the server together and execute in **one round trip** per ~8 MiB of data.

```ts
const r = await db.executeBatch(
  'insert into orders (id, customer, total) values (?, ?, ?)',
  [
    [1, 'ACME', '99.90'],
    [2, 'Globex', '15.00'],
    [3, 'Initech', '7.50'],
  ],
);
r.rowCount;      // 3 — rows submitted
r.rowsAffected;  // 3 — sum of per-row counts
r.updateCounts;  // [1, 1, 1] — per-row affected counts
r.errors;        // [] — filled when continueOnError is set
```

Measured: 300 rows on a cached statement is **3 round trips total**
(transaction start + one batch packet + commit) — versus 300+ for a
row-by-row loop. That ratio is asserted in the driver's test suite.

## Row sources

Rows are positional arrays or `@name` objects, in any key order:

```ts
await db.executeBatch(
  'insert into t (a, b) values (@a, @b)',
  [{ a: 1, b: 'x' }, { b: 'y', a: 2 }],
);
```

The source can be an array **or any sync/async iterable** — stream a million
rows from a file without holding them in memory; the driver flushes a wire
cycle every ~8 MiB:

```ts
async function* rowsFromCsv(path: string) {
  for await (const line of readLines(path)) {
    const [id, name, total] = line.split(';');
    yield [Number(id), name, total];
  }
}
await db.executeBatch(sql, rowsFromCsv('orders.csv'));
```

::: warning One statement at a time
Don't run other statements on the same connection while an async row source is
being consumed — use another connection or the pool for concurrent work.
:::

## Parameter types

Every parameter type works, with a few worth calling out:

- **NUMERIC/DECIMAL** — pass exact decimal **strings** (`'99.90'`); the driver
  scales them exactly (string arithmetic, no float noise). Out-of-range or
  precision-overflow values are rejected client-side with the row index.
- **BLOB** — `Buffer`, `string`, or async iterable; uploaded and registered
  with the batch automatically.
- **DATE/TIME/TIMESTAMP** — JS `Date`; `WITH TIME ZONE` columns take a
  `ZonedDate` (or a `Date`, bound as a UTC-offset instant).
- **BIGINT/INT128** — `number` or `bigint`.

## Error modes

**Default:** the first failed row throws `FirebirdBatchError` — `.index` tells
you which row, `.result` holds the partial `BatchResult` — and **nothing
commits** (in the own-transaction form).

**`continueOnError`:** the call resolves; failed rows are reported per index
and the successful rows commit:

```ts
const r = await db.executeBatch(sql, rows, { continueOnError: true });
r.updateCounts;  // e.g. [1, -1, 1, -1, 1]  (-1 = row failed, -2 = ok, no count)
r.errors;        // [{ index: 1, error: FirebirdError }, { index: 3, error: … }]
```

Options: `{ continueOnError?, detailedErrors? (status-vector cap, default 64),
chunkBytes? (bytes per wire cycle, default 8 MiB) }`.

## Transactions, pool, prepared statements

```ts
// One-shot on the attachment — own transaction, commits on success:
await db.executeBatch(sql, rows);

// Inside a transaction you own (nothing commits until you do):
await db.transaction(async (tx) => {
  await tx.executeBatch(sql, rows);
  await tx.execute('update job set imported = 1 where id = ?', [jobId]);
});

// On the pool (borrows a connection for the call):
await pool.executeBatch(sql, rows);

// Prepared — repeat batches skip the prepare round trip entirely:
const stmt = await db.prepare(sql);
await stmt.executeBatch(rowsA);
await stmt.executeBatch(rowsB, tx);   // optional transaction argument
await stmt.close();
```

## Constraints

- **Firebird 4+ only** (wire protocol ≥ 16). On Firebird 3 the call fails fast
  with a clear error — loop a [prepared statement](./prepared-statements)
  there instead.
- INSERT / UPDATE / DELETE / EXECUTE PROCEDURE, **with parameters**, **without
  `RETURNING`** (the batch protocol has no result-set channel).
