# @fast-firebird/demo

A live dashboard that drives Firebird 3/4/5/6 through the whole stack on one screen:
`@fast-firebird/core`, `@fast-firebird/drizzle`, and the `node-firebird2-ext`
compat backend — the same query, three faces.

![panels: connection · pool · three-way SQL runner · events · streaming · blobs · benchmark]

## What it shows

- **Connection** — protocol version, wire encryption (Arc4/ChaCha), compression, engine + server version (Services API).
- **Connection pool (live)** — acquire/idle/in-use/waiting, streamed over SSE with a sparkline.
- **SQL runner — three stacks** — run one query and time it through raw **core**, **Drizzle** (`db.execute(sql.raw(...))`), and the **node-firebird2-ext** compat facade, side by side.
- **Feature explorer** — a version-aware catalog of what each Firebird release unlocks (FB3: BOOLEAN, window functions, IDENTITY; FB4: DECFLOAT, INT128, TIME ZONE, crypto hashes; FB5: multi-row RETURNING, SKIP LOCKED, MERGE … RETURNING; FB6: SQL schemas, CAST … FORMAT, GREATEST/LEAST/BTRIM, ANY_VALUE). Each has runnable SQL; features above the selected server's version are shown but locked.
- **Events (live)** — arm Firebird `POST_EVENT` names and fire them; events stream back over SSE.
- **Row streaming** — a lazy, backpressured `queryStream` of N generated rows with live progress.
- **Blobs** — write + read back a text blob (`café €`) and a binary blob.
- **Micro-benchmark** — N parameterized inserts + a select, per stack.
- **Custom benchmark** — design a table structure (name + type per column, blob
  columns get a file picker for the payload), then time X parameterized inserts
  (one transaction, statement-cache reuse) and a full fetch including eager blob
  materialization — rows/s and MB/s of blob throughput. A **lock wait** picker
  controls the DDL transaction (default: wait up to 10 s; statement caches are
  evicted pool-wide first so re-runs never hit "object in use").
- **Connection lifecycle** — a *disconnect* button on the Connection panel
  tears down the server's pools and attachments (Connect re-establishes them);
  the SQL runner has the same **lock wait** picker (wait / no wait / wait N s,
  applied on the core lane's transaction).

> **No JSON panel?** Firebird (3/4/5) has no JSON data type or `JSON_VALUE`-style
> functions (verified against all three servers — `cast(… as json)` and
> `json_value` both error). The Firebird idiom is a `BLOB SUB_TYPE TEXT` (or
> varchar) column holding JSON handled by the application.

## Run it

Requires the fast-firebird docker test matrix (FB3/4/5/6 on ports 30503/4/5/7) — the
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
database (read/write, wide open); custom servers can be removed with the ✕ on
their tab (built-in FB3/4/5/6 are protected).

## Layout

```
apps/demo/
  server/
    index.ts     Fastify API + SSE (pool / events / streaming)
    servers.ts   per-server core pool + Drizzle attachment + node-firebird2-ext manager
    engines.ts   the three-way query runner + benchmark
  web/           React + Vite SPA (single page, panel components in App.tsx)
```
