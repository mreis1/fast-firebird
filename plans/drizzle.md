# Drizzle ORM Integration Plan

## Placement decision

**Same monorepo, separate package `@fast-firebird/drizzle`.** Rationale:
- Core stays framework-free (hard requirement).
- Drizzle has no official Firebird dialect; upstream contribution is a possible
  end-game but drizzle-orm's dialect surface is not a stable public extension
  API — shipping our own package keeps release cadence independent. Revisit
  upstreaming once stable.

## Scope

1. **SQL dialect**: Firebird-flavored query builder behavior —
   - `RETURNING` support (Firebird has it — good for insert().returning())
   - Limits: `FIRST/SKIP` (FB3+ also supports `FETCH FIRST ... ROWS ONLY` /
     `OFFSET ... ROWS` — prefer standard syntax, FB3+ only)
   - Identifier quoting `"..."`, default uppercase semantics
   - No `ON CONFLICT`; use `UPDATE OR INSERT` / `MERGE` mapping where feasible
2. **Driver adapter**: session/transaction wrappers over `@fast-firebird/core`
   (pattern: study drizzle-orm/node-postgres session, dialect, migrator layout).
3. **Type mapping**: int/bigint(int64→bigint), varchar/char, blob sub_type 1→text,
   blob binary→Buffer, numeric/decimal (scale) → string|number config, boolean (FB3+),
   date/time/timestamp (+TZ FB4), decfloat/int128 (FB4) → string/bigint.
4. **Migrations**: drizzle-kit has no Firebird support; provide our own migrator
   table + SQL generation initially (drizzle migrate folder format), document limits.
5. **Introspection**: RDB$ system tables → drizzle schema (feasible; later).

## Tests
Drizzle CRUD + transactions against FB3/4/5 docker matrix; type round-trips.

## Implementation approach (decided 2026-07-09, drizzle-orm 0.45.3)

Studied pg-core (Firebird ≈ Postgres: RETURNING, `"..."` quoting, generators).
Key constraints found:
- pg-core `buildSelectQuery` (dialect.ts:341) builds `limit`/`offset` INLINE
  (lines 414-418) — no `buildLimit` hook. Firebird rejects the `LIMIT` keyword;
  it needs `OFFSET n ROWS FETCH FIRST m ROWS ONLY` (FB3+, offset before fetch).
  → must override `buildSelectQuery` (+ set-operator variant).
- pg placeholders are `$1,$2,…`; the Session receives the built SQL string and
  must translate to Firebird `?` positional params (our driver uses `?`).
- Reusing pg COLUMN types risks wrong `mapToDriverValue` (e.g. pg timestamp →
  string) vs our encoder (native Date/number/bigint/Buffer). Correct value
  mapping needs Firebird-aware column types.

**Chosen path — reuse pg-core machinery, Firebird-correct where it matters:**
- Reuse `PgDatabase` + query builders (they call the dialect; pg insert/update/
  delete already emit RETURNING + `"` quoting — Firebird-compatible).
- `FirebirdDialect extends PgDialect`, override `buildSelectQuery` /
  set-operator building for `OFFSET/FETCH` (FB rejects `LIMIT`).
- Firebird column types that EXTEND `PgColumn`/`PgColumnBuilder` with:
  `getSQLType()` → Firebird types, and IDENTITY `mapFromDriverValue`/
  `mapToDriverValue` (our driver already returns native Date/number/Buffer, so
  pg's string-based mappers would corrupt SELECT results — this is the crux).
  `firebirdTable` = thin wrapper over `pgTable`.
- Custom `FirebirdSession`/`FirebirdPreparedQuery` over `@fast-firebird/core`:
  translate `$n` → `?` (track param order), run via `Attachment`/`Transaction`,
  map rows via drizzle `mapResultRow`, transactions via our tx.
- `drizzle(connection)` entry mirroring node-postgres/driver.ts `construct()`.
- Defer: relational query API, views, migrations (drizzle-kit).

Alternative (rejected for v1): reuse `pgTable` + pg columns verbatim — faster
but emits pg value mappings and reads oddly ("pg" tables for Firebird).

## Status
Package scaffolded (`@fast-firebird/drizzle`). Architecture research in
`plans/research/drizzle-internals.md`. Implementing the dialect next.
(Later: dialect, session, migrator, introspection all shipped — see roadmap.)

## Relational `with:` — fix paths (researched 2026-07-16)

Current state: flat findMany/findFirst work; `with:` throws a guidance error
(Firebird lacks the JSON aggregation Drizzle's RQB compiles to).

Options assessed:
- **A. String-built JSON via LIST()** — rejected: JSON escaping via REPLACE
  chains is fragile, LIST() element order undefined, blob/date/number
  formatting matrix too error-prone for a driver.
- **B. Client-side query decomposition (Prisma-style)** — RECOMMENDED when
  demand shows up: intercept the relational query config, run root query +
  one `WHERE fk IN (…)` query per relation, stitch nested objects in JS.
  Per-parent relation limits via `ROW_NUMBER() OVER (PARTITION BY fk)`
  (FB3+). Works on all supported servers, stock. Multi-day effort + test
  matrix. Post-publish, demand-driven.
- **C. JSON UDR plugin** — rejected as primary path: UDRs cannot define
  AGGREGATE functions (only scalar/proc/trigger), so json_agg needs the
  LIST() hybrid anyway; requires native code installed on the customer's
  server (breaks the pure-TS/stock-server positioning; admin access often
  unavailable); Drizzle RQB SQL also leans on LATERAL (FB4+ only).

**Upstream status (checked 2026-07-16 — do NOT file a json_agg issue, it
would be a duplicate):**
- FirebirdSQL/firebird#5431 (2016, 32+ votes) is the JSON umbrella issue.
- Full SQL-standard JSON support (ISO/IEC TR 19075-6) **already exists in
  the Red Database fork** and is being ported to Firebird 6.0 by @Noremos
  in staged PRs; core dev sim1984 confirmed (May 2026). Plan tree explicitly
  includes **"JSON AggNodes"** (= JSON_ARRAYAGG etc.) plus JSON type,
  JSON_TABLE, path engine.
- First PR of the split: #9062 "JSON Path parser" (June 2026, open);
  earlier infra PR #7221 (2022). FB6 timing uncertain (stabilization after
  shared-metadata-cache merge is the current priority).
- Implication for us: no upstream contribution needed (it's written, just
  being reviewed); watch #5431/#9062. When FB6 ships JSON functions, add a
  capability-gated single-query RQB mode (like inline blobs gate on
  protocol 19) — until then Option B serves the FB3/4/5 installed base.
- CANARY in place (2026-07-18): `packages/drizzle/test/integration/
  fb6-json-canary.test.ts` asserts json_arrayagg/json_object are ABSENT on
  the fb6 snapshot lane. The day a snapshot ships them, CI goes red with a
  message pointing here — that's the trigger to build the single-query mode.
  (Live-verified 2026-07-18 on 6.0.0: no JSON tokens in parse.y, all three
  functions raise syntax errors. node-firebird 2.4.0's release notes mention
  native JSON for FB6 — presumably tracking the in-progress upstream work,
  since the snapshot doesn't accept the functions yet; always verify against
  a live server rather than release notes.)
