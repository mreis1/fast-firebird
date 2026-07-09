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
