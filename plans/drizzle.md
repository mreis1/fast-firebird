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

## Status
Not started. Begins after M2 (query layer) stabilizes. Study of drizzle-orm
dialect internals happens right before implementation (fast-moving upstream).
