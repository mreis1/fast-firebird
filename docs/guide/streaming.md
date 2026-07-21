# Streaming large result sets

`queryStream` yields rows lazily in adaptively-sized batches — the next
`op_fetch` only fires as you consume, so a huge table never lands in memory at
once and an early `break` stops after just a batch or two:

```ts
for await (const row of db.queryStream<Order>('select * from big_table order by id')) {
  process(row);            // backpressure-friendly; break any time
}

// Node stream ergonomics:
import { Readable } from 'node:stream';
const stream = Readable.from(db.queryStream('select * from big_table'));
```

`db.queryStream` runs in its own transaction (committed at end, rolled back on
error/break); `tx.queryStream` streams within a transaction you own.

::: warning Concurrency
Don't run other statements on the *same* connection mid-stream — use another
connection or the [pool](./pooling) for concurrency.
:::

## Streaming with blobs

Combine `queryStream` with lazy blobs and `blobReadAhead` to export large blob
tables at full wire utilization — see
[Blobs → Performance](./blobs#performance-pipelining-read-ahead-prefetch-inline).

```ts
await db.transaction(async (tx) => {
  for await (const row of tx.queryStream('select id, doc from files', [], {
    blobs: 'lazy',
    blobReadAhead: 2,
  })) {
    await (row.DOC as Blob).toFile(`out/${row.ID}.bin`);
  }
});
```
