<p align="center">
  <img src="./assets/logo.svg" alt="fast-firebird" width="620">
</p>

<p align="center">
  A next-generation Firebird SQL driver for Node.js — <b>pure TypeScript</b>, zero native
  dependencies, speaking the Firebird wire protocol directly (protocol 13–16) with
  first-class support for <b>Firebird 3, 4, and 5</b>.
</p>

> **Status: early but real.** Connect (SRP256/Srp auth; Arc4/ChaCha wire
> encryption; zlib compression), transactions, a statement cache, prepared
> statements, all scalar types, text & binary blobs, adaptive fetching, row
> streaming, connection pooling, and the legacy `CHARSET NONE` toolkit are
> implemented and verified by 248 tests against real FB 3/4/5 servers.
> Events (`POST_EVENT`), the Services API, and a multi-statement script parser
> round out M5. See `plans/000-roadmap.md` for what's next.

```ts
import { connect } from '@fast-firebird/core';

const db = await connect({
  host: 'localhost',
  port: 3050,
  database: '/data/app.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
  charset: 'UTF8',
});

const rows = await db.query('select id, name from users where id = ?', [1]);

await db.transaction(async (tx) => {
  await tx.execute('insert into users (id, name) values (?, ?)', [2, 'Alice']);
});

await db.disconnect();
```

## Legacy `CHARSET NONE` databases (the € problem)

Databases declared `NONE` whose bytes were written as Windows-1252 by legacy
(Delphi) software round-trip cleanly:

```ts
const db = await connect({
  database: '/data/legacy.fdb',
  charset: 'NONE',
  charsetNoneEncoding: 'win1252',        // simple strategy
  // or full control (node-firebird2-compatible):
  // transcodeAdapter: { text: { fromDb: b => iconv.decode(b, 'win1252'),
  //                             toDb:  s => iconv.encode(s, 'win1252') } },
  // or per-field:
  // charsetOverrides: { 'HISTORY.MEMO': 'win1252' },
});

const rows = await db.query("select memo from history where memo like ?", ['%€%']);
```

## Monorepo layout

```
packages/core          @fast-firebird/core — the wire-protocol driver
plans/                 living design docs (architecture, performance, charsets, …)
plans/research/        protocol notes extracted from node-firebird(2), jaybird,
                       rsfbclient and the Firebird core source
diary/                 daily engineering log
docker/                isolated FB 3/4/5 test matrix (compose project fast-firebird-test)
scripts/               codegen + safe docker cleanup
```

## Development

```sh
pnpm install
pnpm fb:up            # start isolated Firebird 3/4/5 containers (ports 30503-30505)
pnpm test             # unit + integration
pnpm fb:down          # remove ONLY this project's containers/volumes/network
```

Docker usage follows strict isolation rules (`plans/docker-safety.md`): every
resource is named `fast-firebird-test-*`, cleanup is scoped to the compose
project, and no global prune command is ever used.

## Prepared statements & the statement cache

Every connection keeps an LRU cache of prepared statements keyed by SQL text
(`statementCacheSize`, default 64; `0` disables). Measured round trips,
asserted by integration tests on FB 3/4/5:

| Operation (inside an open transaction) | Round trips |
|-----------------------------------------|-------------|
| cold query (prepare → rows)             | 2           |
| warm query, ≤ `fetchSize` rows          | **1** (execute + fetch coalesced) |
| warm DML including affected count       | **1** (execute + counts coalesced) |

For hot paths you can also pin a statement explicitly:

```ts
const stmt = await db.prepare('select name from users where id = ?');
const rows = await stmt.query([42], tx); // 1 round trip per execution
await stmt.close();
```

> **Metadata-lock caveat** (standard Firebird behavior): a prepared statement —
> cached or pinned — holds existence locks on the objects it references, so
> DDL on those tables from *other* connections waits until the statement is
> released. DDL executed through the same connection clears the cache
> automatically. Set `statementCacheSize: 0` if your workload mixes long-lived
> connections with external migrations.

## Performance vs node-firebird

Measured against `node-firebird` 1.1.10 on Firebird 5 with an in-process
latency proxy (`pnpm --filter @fast-firebird/benchmarks bench`), defaults vs
defaults:

| Scenario | 0ms | 10ms RTT link |
|---|---|---|
| warm select ×200 (open tx) | 3.0× | 2.9× |
| 10k-row scan | 1.0× | 1.8× |
| 300-row insert (1 tx) | 2.6× | 2.0× |
| **1MB blob write+read** | **14×** | **44×** |

Blobs dominate because legacy drivers use 1KB segments (~1000 round trips per
MB); fast-firebird uses 64KB segments by default. The one case where
fast-firebird is slower — bare connect — is because it encrypts the wire by
default (SRP256 + `op_crypt`); pass `wireCrypt: 'disabled'` to match.

## Streaming large result sets

`queryStream` yields rows lazily in adaptively-sized batches — the next
`op_fetch` only fires as you consume, so a huge table never lands in memory at
once and an early `break` stops after just a batch or two:

```ts
for await (const row of db.queryStream('select * from big_table order by id')) {
  process(row);            // backpressure-friendly; break any time
}

// Node stream ergonomics:
import { Readable } from 'node:stream';
const stream = Readable.from(db.queryStream('select * from big_table'));
```

`db.queryStream` runs in its own transaction (committed at end, rolled back on
error/break); `tx.queryStream` streams within a transaction you own. Don't run
other statements on the *same* connection mid-stream — use another connection
or the pool for concurrency.

## Transactions

```ts
const tx = await db.startTransaction({ isolation: 'readCommitted', readOnly: true });
const rows = await tx.query('select first 1 1 as v from rdb$database');

await tx.restart();                        // commit + reopen, same strategy
await tx.restart({ action: 'rollback' });  // rollback + reopen, same strategy
await tx.restart({ readOnly: false });     // commit + reopen with a new strategy

await tx.execute('insert into t (id) values (?) returning id', [1]);
await tx.commit();
```

`restart` reuses the same `Transaction` object (its `handle` changes) — handy
for long-running loops that periodically checkpoint. It commits by default;
pass `action: 'rollback'` to discard. Lazy blob handles from before a restart
become invalid (reading one throws `FirebirdBlobError`).

## Blobs: eager (default) or lazy handles

By default blob columns are materialized (Buffer, or decoded string for
subtype-1 text). For big/optional blobs, `blobs: 'lazy'` returns a `Blob`
handle per non-null cell — nothing is fetched until you ask, so blobs you
don't touch cost **zero** round trips:

```ts
await db.transaction(async (tx) => {
  for await (const row of tx.queryStream('select id, photo, notes from docs', [], { blobs: 'lazy' })) {
    const notes = await row.NOTES?.text();        // fetched on demand (subtype-1 decoded)
    // row.PHOTO never touched → never fetched
  }
});

// or stream a large blob in backpressured chunks
await pipeline(row.PHOTO.stream({ chunkSize: 64 * 1024 }), fs.createWriteStream('out.jpg'));
```

`Blob` exposes `buffer()` (cached), `text(encoding?)`, `stream({chunkSize})`,
and `size()`. Handles are **transaction-scoped** — read them before the
transaction commits (reading a stale handle throws `FirebirdBlobError`). Lazy
mode therefore requires `tx.query`/`queryStream`; `db.query` with lazy throws.
Set the default per connection with `connect({ blobs: 'lazy' })`.

Skip specific columns without listing all of them (drops them from the row and,
for blobs, skips fetching entirely in eager mode):

```ts
await db.query('select * from docs', [], { exclude: ['PHOTO'] }); // or { only: ['ID', 'NAME'] }
```

## Connection pooling

```ts
import { createPool } from '@fast-firebird/core';

const pool = await createPool({ host, database, user, password, min: 2, max: 10 });

const rows = await pool.query('select * from users where id = ?', [1]); // acquire→run→release
await pool.transaction(async (tx) => { /* … */ });
await pool.use(async (conn) => { /* borrow explicitly */ });

await pool.close();
```

Each pooled connection is a full `Attachment` with its own statement cache, so
warm statements survive across acquire/release. The pool enforces `max`
concurrency, validates connections with `op_ping` on borrow, evicts idle
connections down to `min`, and times out `acquire` when saturated.

For parallel work, `pool.map` runs a function over items across connections
with bounded concurrency (results in input order):

```ts
const parts = await pool.map(idRanges, (conn, range) =>
  conn.query('select * from big where id between ? and ?', [range.lo, range.hi]),
  { concurrency: 4 },
);
```

(A lazy `Blob` handle is bound to the connection+transaction that produced it,
so parallelize by running the *query* per partition — not by sharing handles.)

## Multi-statement scripts

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
comments, with line/column error positions. `executeScript` supports
`transaction: 'perScript' | 'perStatement' | 'none'`, `continueOnError`, and an
`onProgress` callback. `parseScript(sql)` is also exported standalone.

## Events (POST_EVENT)

```ts
const events = await db.events(['order_placed', 'stock_low']);
events.on('order_placed', (count) => refreshOrders());
events.on('post', (name, count) => console.log(name, count));
// … later
await events.close();
```

Uses Firebird's async event channel (a separate socket), so it never blocks
queries on the connection. The first delivery per event is a silent baseline —
only posts occurring after subscription fire. Firebird's one-shot requests are
re-armed automatically. *(Docker note: the async channel needs a fixed,
published `RemoteAuxPort` — see `docker/docker-compose.yml`.)*

## Services API

```ts
import { connectService } from '@fast-firebird/core';

const svc = await connectService({ host, user: 'SYSDBA', password: 'masterkey' });
const info = await svc.getServerInfo();      // version, implementation, security db
const stats = await svc.getStatistics('/data/app.fdb');  // gstat output
await svc.disconnect();
```

## Wire encryption & compression

```ts
await connect({ /* … */ wireCrypt: 'required', wireCompression: true });
```

## Legacy authentication

For migrating from legacy Firebird setups (`AuthServer = Legacy_Auth`):

```ts
const db = await connect({
  host, database, user: 'MYUSER', password: 'secret',
  authPlugin: 'Legacy_Auth',
  wireCrypt: 'disabled',   // Legacy_Auth servers typically disable wire crypt
});
```

Uses the DES `crypt(3)` hash (UTF-8 password bytes, matching node-firebird and
fbclient). SRP256/SRP remain the default for modern servers.

## Wire encryption & compression (continued)

`wireCrypt` is `'enabled'` by default (Arc4, negotiated); `wireCompression`
(zlib) is off by default and requires `WireCompression = true` on the server.
When both are on, the wire is compressed then encrypted, matching fbclient.

## Design highlights

- **Round-trip frugality**: statement allocate+prepare pipelined into one round
  trip (lazy-send), execute+first-fetch and execute+record-counts coalesced
  into single packets, deferred `op_free_statement`/`op_close_blob`, batched
  fetch (400 rows/trip by default, configurable). `Attachment.roundTrips`
  exposes the flush counter for your own budget assertions.
- **Faithful SRP**: Firebird's non-standard SRP-6a variant (modPow proof mixing,
  `(a + u·x) mod N`, SHA-1 session key) implemented with `node:crypto` + BigInt.
- **Real error messages**: complete gds→message table (2539 entries) generated
  from the Firebird source, with SQLSTATE.
- **Charset layer resolved at prepare time**: zero per-cell branching; UTF8 and
  latin1 use native Buffer fast paths, everything else iconv-lite.
