# Connection pooling

```ts
import { createPool } from '@fast-firebird/core';

const pool = await createPool({ host, database, user, password, min: 2, max: 10 });

const rows = await pool.query('select * from users where id = ?', [1]); // acquire→run→release
const one  = await pool.queryOne('select * from users where id = ?', [1]);
await pool.transaction(async (tx) => { /* … */ });
await pool.use(async (conn) => { /* borrow explicitly */ });

await pool.close();          // or: await using pool = await createPool({ … })
```

Each pooled connection is a full `Attachment` with its own statement cache, so
warm statements survive across acquire/release. The pool enforces `max`
concurrency, validates connections with `op_ping` on borrow, evicts idle
connections down to `min`, and times out `acquire` when saturated.

The pool also exposes [`executeBatch`](./batch) directly:

```ts
await pool.executeBatch('insert into t (a) values (?)', rows);
```

## Parallel work: `pool.map`

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
