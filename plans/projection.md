# Projection Rewrite (`expandStar`) — DEFERRED / future

Status: **planned, not scheduled.** Captured from the M5.5 design discussion.
Do not implement until explicitly prioritized.

## Goal

Let a user write `SELECT *` (or `SELECT *, <expr>`) but have specific columns
genuinely NOT fetched over the wire — for ANY column type, not just blobs —
without typing the full column list.

```ts
db.query('SELECT *, (COL_NOTES IS NULL) AS NOTES_ABSENT FROM T', [], {
  exclude: ['COL_NOTES'],
  expandStar: true,
});
// wire actually receives:
// SELECT COL_A, COL_B, COL_C, (COL_NOTES IS NULL) AS NOTES_ABSENT FROM T
```

## Why it's separate from `exclude`

`exclude` alone is **decode-time only**: the server already expanded `*` at
prepare and streams every column; we just drop excluded ones from the row
object (and skip blob materialization — the one case with real savings). For a
scalar column, decode-time exclude saves NOTHING on the wire.

To truly avoid sending a scalar column under `SELECT *`, the `*` must be
replaced with an explicit column list **before** the statement reaches the
server. That is this feature.

## Strategy (no separate schema cache needed)

1. Prepare the original `SELECT *` once; the describe response already gives us
   every output column's `field` + `relation` (we parse these today).
2. Identify the run of columns produced by the `*` (contiguous columns from one
   relation) and, for `alias.*`, the alias's relation.
3. Textually replace the `*` / `alias.*` token in the ORIGINAL SQL with the
   explicit column list minus the blacklist, preserving everything else
   (other select items, FROM/JOIN/WHERE/ORDER).
4. Re-prepare the rewritten SQL; cache it keyed by (original SQL, exclude set).
   One extra prepare per unique query, amortized by the statement cache.

## Aliased rewrites — REQUIRED (user)

Must support qualified stars, not just bare `*`:

```
SELECT ALIAS.* FROM T ALIAS            → SELECT ALIAS.COL_A, ALIAS.COL_B, ...
SELECT TABLE_NAME.* FROM TABLE_NAME    → SELECT TABLE_NAME.COL_A, ...
SELECT a.*, b.* FROM a JOIN b ON ...   → expand each independently, minus exclude
```

The describe response gives each output column's `relation` (source table) and
`field`; combined with the FROM/JOIN aliases parsed from the SQL, map each
`alias.*` / `table.*` to its column run and re-emit as `alias.COL` (preserving
the qualifier so joins stay unambiguous). Bare `SELECT *` expands to all output
columns. Exclude entries may be qualified (`ALIAS.COL_NOTES`) or bare (`COL_NOTES`).

## Why it needs a real parser (not a regex)

- `SELECT t.*` vs bare `SELECT *` vs `SELECT a.*, b.*` — target the correct star(s).
- Joins where multiple tables each contribute a `*`.
- `*` appearing inside a subquery or a string/identifier literal.
- Alias collisions when expanding; preserve qualifiers to avoid ambiguity.

Reuse the tokenizer discipline from `script/parser.ts` (string/quote/comment
states) to locate the star at a true token boundary.

## Ergonomics decision (when built)

Preference from discussion: `expandStar` explicit for now; possibly
auto-enable when an excluded column is non-blob (the only case it helps). TBD
at implementation time.
