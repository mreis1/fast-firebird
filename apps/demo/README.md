# @fast-firebird/demo

A live dashboard that drives Firebird 3/4/5 through the whole stack on one screen:
`@fast-firebird/core`, `@fast-firebird/drizzle`, and the `node-firebird2-ext`
compat backend — the same query, three faces.

![panels: connection · pool · three-way SQL runner · events · streaming · blobs · benchmark]

## What it shows

- **Connection** — protocol version, wire encryption (Arc4/ChaCha), compression, engine + server version (Services API).
- **Connection pool (live)** — acquire/idle/in-use/waiting, streamed over SSE with a sparkline.
- **SQL runner — three stacks** — run one query and time it through raw **core**, **Drizzle** (`db.execute(sql.raw(...))`), and the **node-firebird2-ext** compat facade, side by side.
- **Events (live)** — arm Firebird `POST_EVENT` names and fire them; events stream back over SSE.
- **Row streaming** — a lazy, backpressured `queryStream` of N generated rows with live progress.
- **Blobs** — write + read back a text blob (`café €`) and a binary blob.
- **Micro-benchmark** — N parameterized inserts + a select, per stack.

## Run it

Requires the fast-firebird docker test matrix (FB3/4/5 on ports 30503/4/5) — the
same containers the core test-suite uses — and the `node-firebird2-ext` clone in
`references/` (for the compat lane).

```bash
# from the monorepo root
pnpm install
pnpm --filter @fast-firebird/core build       # core must be built (drizzle/demo consume its dist)
pnpm --filter @fast-firebird/drizzle build

# dev (two processes: API on :5178, Vite web on :5177)
pnpm --filter @fast-firebird/demo dev
# → open http://localhost:5177

# or single-process (API serves the built web on :5178)
pnpm --filter @fast-firebird/demo build
pnpm --filter @fast-firebird/demo start
# → open http://localhost:5178
```

The dashboard creates an isolated `ff_demo.fdb` per server on first use, so it
never touches the test fixtures. Use **+ add server** to point it at any other
database (read/write, wide open).

## Layout

```
apps/demo/
  server/
    index.ts     Fastify API + SSE (pool / events / streaming)
    servers.ts   per-server core pool + Drizzle attachment + node-firebird2-ext manager
    engines.ts   the three-way query runner + benchmark
  web/           React + Vite SPA (single page, panel components in App.tsx)
```
