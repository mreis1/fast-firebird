# fast-firebird

A next-generation Firebird SQL driver for Node.js. Pure TypeScript, zero native
dependencies, speaking the Firebird wire protocol directly (protocol 13–16) with
first-class support for **Firebird 3, 4, and 5**.

> **Status: early but real.** Connect (SRP256/Srp + Arc4 wire encryption),
> transactions, prepared statements, all scalar types, text & binary blobs, and
> the legacy `CHARSET NONE` toolkit are implemented and verified by integration
> tests against real FB 3/4/5 servers. See `plans/000-roadmap.md` for what's next.

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

## Design highlights

- **Round-trip frugality**: statement allocate+prepare pipelined into one round
  trip (lazy-send), deferred `op_free_statement`/`op_close_blob`, batched fetch
  (400 rows/trip by default, configurable).
- **Faithful SRP**: Firebird's non-standard SRP-6a variant (modPow proof mixing,
  `(a + u·x) mod N`, SHA-1 session key) implemented with `node:crypto` + BigInt.
- **Real error messages**: complete gds→message table (2539 entries) generated
  from the Firebird source, with SQLSTATE.
- **Charset layer resolved at prepare time**: zero per-cell branching; UTF8 and
  latin1 use native Buffer fast paths, everything else iconv-lite.
