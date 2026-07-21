# Blobs

## Eager by default, lazy on request

By default blob columns are materialized during decode — text blobs (memos)
arrive as decoded strings, binary blobs as Buffers. This default is
deliberate: *"SELECT gives me values" is the near-universal driver
expectation, and lazy leaks transaction-lifetime concerns into ordinary code.*

For big or optional blobs, lazy modes return a `Blob` handle per non-null
cell — nothing is fetched until you ask, so blobs you don't touch cost
**zero** round trips:

```ts
blobs: 'lazy'          // every blob column → Blob handle
blobs: 'lazy-binary'   // binary blobs lazy, memos eager (the file-export sweet spot)
blobs: 'lazy-text'     // memos lazy, binary eager
blobs: { default: 'lazy-binary', eager: ['THUMB'], lazy: ['A.HUGE_XML'] } // per column
```

Available per query or as a connection default. Column names are alias-aware
(`'DOC'` or `'A.DOC'`, case-insensitive); naming a column in both lists throws.

```ts
await db.transaction(async (tx) => {
  for await (const row of tx.queryStream('select id, photo, notes from docs', [], { blobs: 'lazy-binary' })) {
    // row.NOTES is already a string (eager memo); row.PHOTO is a Blob handle
    if (wanted(row.ID)) await (row.PHOTO as Blob).toFile(`out/${row.ID}.jpg`);
  }
});
```

::: warning Transaction-scoped handles
`Blob` handles are **transaction-scoped** — read them before the transaction
ends (a stale handle throws `FirebirdBlobError`). Lazy-capable configurations
therefore require `tx.query`/`queryStream`; `db.query` with a lazy config
throws with guidance.
:::

## Reading: buffer, text, stream, file, size

```ts
const buf  = await blob.buffer();                    // whole blob, cached
const txt  = await blob.text();                      // subtype-1 decoded via column charset
const size = await blob.size();                      // op_info_blob, 1 round trip
const n    = await blob.toFile('/exports/doc.pdf');  // streamed to disk, returns bytes

await pipeline(blob.stream({ chunkSize: 64 * 1024 }), fs.createWriteStream('out.jpg'));
```

Streams are backpressured and one-shot; abandoning one (destroy, `break`, or
error) closes the server-side handle immediately — nothing leaks until
transaction end.

## Partial reads: `head()` + resume

For magic-number sniffing and content-type detection:

```ts
const magic = await blob.head(16);      // first 16 bytes, cursor stays open
if (isPng(magic)) {
  const all = await blob.buffer();      // RESUMES — no re-open, no re-transfer
} else {
  await blob.close();                   // release the cursor early
}
```

`head(n)` keeps the server handle open at its position; a later `buffer()`,
`stream()` or wider `head()` continues from byte n instead of starting over.
Reading to the end promotes the bytes into the regular cache.

## Writing: Buffers, strings, streams

Blob parameters accept `Buffer`, `string` (encoded via the column charset) —
or any `Readable`/`AsyncIterable<Buffer | string>`, uploaded in pipelined
64KB segments without buffering the source in memory:

```ts
await tx.execute('insert into files (id, doc) values (?, ?)', [1, fs.createReadStream('big.iso')]);
```

(A lazy `Blob` handle can't be bound directly as a parameter — it would
deadlock the connection's operation lock; pass `await blob.buffer()`.)

## Performance: pipelining, read-ahead, prefetch, inline

Blob transfer is round-trip-bound, so the driver attacks round trips:

- **64KB segments + cross-blob pipelining** — batch reads keep a deep window
  of segment requests in flight *across* blobs (openings pipelined ahead,
  closes deferred), instead of one segment per round trip.
- **`blobReadAhead`** (lazy blobs in `queryStream`) — while you process row N,
  the driver prefetches upcoming rows' blob contents in bounded background
  slices, so `.buffer()/.text()/.stream()` usually resolve without touching
  the wire. `true` | depth | `{ columns, depth, maxBytes }` (default 16MiB
  budget), per query or as a connection default; purely an optimization —
  skipped rows and budget overruns fall back to on-demand reads.

  ```ts
  for await (const row of tx.queryStream(sql, [], { blobs: 'lazy', blobReadAhead: 2 })) {
    await (row.DOC as Blob).toFile(path(row));   // usually zero extra round trips
  }
  ```

- **`prefetchBlobs(blobs)`** — batch-fetch an explicit set of handles (e.g.
  every `THUMB` of a page of rows) in one pipelined burst before use.
- **FB5 inline blobs (protocol 19, Firebird 5.0.2+)** — small blobs/memos ride
  *with the row data*: zero extra round trips, no opt-in needed. The driver
  announces `maxInlineBlobSize` (default 65535 bytes, `0` disables) on every
  execute; received-but-unread inline blobs are budgeted by
  `maxBlobCacheSize` (default 10MiB) and scoped to their transaction. All
  read paths — eager, lazy, streams, read-ahead — consult the inline cache
  first.

For measured numbers (21–152× vs legacy drivers on blob workloads, and how
each strategy behaves at different link latencies), see
[Performance](./performance).
