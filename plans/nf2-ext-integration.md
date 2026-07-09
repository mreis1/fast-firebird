# node-firebird2-ext → fast-firebird backend swap

**Goal:** back the existing `node-firebird-2-ext` public API with `@fast-firebird/core`
instead of `node-firebird2`, so downstream internal projects migrate with minimum code change.
Branch `fast-firebird` in `a private repository` (cloned
under `references/node-firebird2-ext`). **Full swap** — remove the `node-firebird2`
dependency; keep the public surface identical. Additions beyond the current API are
documented in the repo's `MIGRATION.md` for post-integration review.

## Public surface to preserve (from `src/index.ts` + `src/core/contracts.ts`)
- `createFirebirdManager(config)`, `Firebird2Manager` (exported as `FirebirdXyManager`),
  legacy `FirebirdManager` facade, `factory` default export.
- `IFirebirdConnection`: `queryP` / `readP` / `commitP` / `rollbackP` /
  `commitRetaining` / `rollbackRetaining` / `restart` / `setIsolation` /
  `activateContext` / `attachEvent` / `readBlob` / `release` / `disconnect`,
  plus deprecated no-op/throwing members and `id/connected/inTransaction`.
- `IFirebirdQres` (`fetchAll`/`fetchOne`), pool (`FirebirdPool`, generic-pool based),
  `GeneratorService`, context activation hooks.

## node-firebird2 touch-points → core equivalents
| node-firebird2 | @fast-firebird/core |
|---|---|
| `Fbjs.promises.attach(opts)` → `Db` | `connect(opts)` → `Attachment` |
| `db.transaction(isolation)` → `Transaction` | `attachment.startTransaction(txOptions)` → `Transaction` |
| `tx.query(sql, params)` (objects) | `tx.query(sql, params)` |
| `tx.execute(sql, params)` (arrays) | `tx.run(sql, params, { rowMode: 'array' })` |
| `tx.commit / rollback / commitRetaining / rollbackRetaining` | same names on core `Transaction` |
| `tx.restart(isolation)` | `tx.restart({ ...opts })` |
| `new Isolation({ mode, wait })` | local `Isolation` class → `TransactionOptions` |
| `db.attachEvent()` | `attachment.events(names)` (see additions) |
| `db.detach()` | `attachment.disconnect()` |
| `Fb.promises.readBlob(col, opts)` | eager Buffer/string, or `Blob` handle `.buffer()/.text()` |
| `setDebug` / `transliterate` | no-op / handled by core charset layer |
| attach `Options` | `FirebirdConnectionOptions` (1:1 field names) |

## Isolation mapping (faithful to node-firebird2 defaults)
- default level `ISOLATION_REPEATABLE_READ` → core `isolation: 'snapshot'`.
- `mode: 'read'` → `readOnly: true`; `mode: 'write'` → `readOnly: false`.
- `wait` → core `wait`; `lockTimeout` (n) → core `wait: n`.
- `setIsolation` upgrade (read→write) → `tx.restart({ readOnly: false })`.

## Transaction lifecycle
The facade keeps node-firebird2's manual model: `queryP` lazily starts a tx
(`ensureTx` → `attachment.startTransaction`), reused until `commitP`/`rollbackP`
null it. `*Retaining` keep the tx (and its handle) alive. This maps cleanly onto
core, which exposes an explicit `startTransaction()` + a long-lived `Transaction`.

## Additions to document (MIGRATION.md)
1. **Blobs are materialized eagerly** (Buffer for binary, string for text) instead
   of node-firebird2's lazy read handles. `readBlob(col, { encoding })` still works
   (returns the Buffer/string, or reads a core `Blob` handle). `stringify` option
   unchanged.
2. **`attachEvent()`** now returns a core `EventListener` (needs event names);
   the previous node-firebird2 shape differs. Flag for consumers using events.
3. **`Isolation`** is now provided by the ext package (API-compatible subset:
   `{ mode, wait, rec, lockTimeout }`), not imported from node-firebird2.
4. **Auth/wire**: core speaks SRP + WireCrypt by default and also supports
   Legacy_Auth (WireCrypt=Disabled) for the current server config — pass through
   attach options; document the recommended target settings.

## Consumption
Dev: `@fast-firebird/core` via `file:` link to the monorepo. Real deployment needs
`@fast-firebird/core` published (npm or private registry) — prerequisite noted.

## Status — DONE (2026-07-09, branch `fast-firebird`, local/unpushed)
Full swap implemented and validated: `tsc` green; 9/9 integration tests on FB3/4/5
(DDL, DML, params, RO→RW auto-upgrade, tx, `asObject` arrays, text+binary blobs,
context activation, `setIsolation`, generators, `readQuery`) incl. `é`/`€` under
CHARSET NONE. `MIGRATION.md` written. Public API unchanged.

Charset note (investigated): the transcode-adapter `-303` was NOT a core bug — it
was a UTF8-default test database (win1252 bytes into UTF8 params). Against a real
CHARSET NONE database both the adapter and `charsetNoneEncoding` round-trip `é`/`€`;
`charsetNoneEncoding` is more robust (respects real charsets, wins for NONE), so
the ext layer routes through it. No core change.

Open follow-ups:
- **Publish** `@fast-firebird/core` (npm/private) before real deployment; today
  it's a `file:` link.
- `attachEvent` / event API shape if any consumer uses events.
