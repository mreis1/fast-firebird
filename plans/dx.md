# M5.5 — Core hardening & DX plan

Agreed in the 2026-07-09 design discussion. Harden core BEFORE Drizzle (M6):
lazy blobs, projection, and transaction lifecycle all sit under the adapter,
so changing them after Drizzle would churn the adapter twice.

## 1. Legacy_Auth (migration blocker — do FIRST)

User currently runs Firebird in legacy auth mode; SRP-only would block
adoption. Implement the `Legacy_Auth` plugin: pure-JS DES `crypt(3)`
(`crypt(password, '9z').substring(2)`), plugin negotiation in the handshake,
`isc_dpb_password_enc` path. Verify LIVE against a Legacy_Auth-configured
server (our test containers are Srp256,Srp — add a legacy-enabled config).
Wire flow already mapped in `plans/research/node-firebird-notes.md` §4.5.

OPEN: confirm the user's real server config (AuthServer, security db, gsec) to
mirror the exact migration path in a test container.

## 2. Lazy blobs + blob streaming (DX centerpiece)

Today blobs are eager + sequential: after each fetch, every blob cell is
materialized one-by-one (each = extra round trips). Add an opt-in lazy mode
returning a `Blob` accessor instead of the value:

```ts
const [row] = await db.query('select id, photo, notes from t', [], { blobs: 'lazy' });
await row.PHOTO.buffer();                 // materialize fully
await row.NOTES.text();                   // subtype-1 → decoded via charset layer
row.PHOTO.stream({ chunkSize: 64*1024 }); // Readable, backpressured (M4 blob-streaming)
```

- Default stays **eager** (non-breaking).
- `Blob`: `.buffer()`, `.text(encoding?)`, `.stream({chunkSize})`, `.size()` if cheap.
- Parallelism honesty: ONE connection serializes the wire (opChain), so
  `Promise.all` of blob reads on a single connection is still sequential. TRUE
  parallel blob fetch = N pooled connections. Provide `pool.materialize(rows,
  { concurrency })` helper; document the constraint.

## 3. Column `exclude` (decode-time) — LOCKED semantics

Primary goal (user): `SELECT *` while NOT fetching unneeded BLOB columns,
without typing every column.

```ts
db.query('SELECT * FROM T', [], { exclude: ['PHOTO', 'NOTES'] });
// non-excluded columns returned as usual; excluded blobs are NEVER materialized
```

- Decode-time only: excluded columns dropped from the row object.
- For BLOB columns this skips materialization → real round-trip savings
  (the intended use). For scalar columns it's cosmetic (bytes already sent).
- `only: [...]` as the inverse allow-list.
- NO SQL rewrite here — that's `plans/projection.md` (`expandStar`), deferred.
- Column-name match case-insensitive against alias||field.

## 4. Transaction lifecycle DX

Store the options a transaction started with; add `restart()`:

```ts
const tx = await con.transaction({ isolation: 'readCommitted', readOnly: true });
await tx.restart();                    // commit + reopen, same options
await tx.restart({ readOnly: false }); // commit + reopen, new options
```

- Keep the plain `TransactionOptions` object (idiomatic TS); optional
  `Isolation` alias for node-firebird2 familiarity.
- Opt-in `autoUpgradeReadOnly: true`: on "attempted update during read-only
  transaction", commit+reopen RW and retry once. OFF by default (upgrading a
  RO snapshot silently changes consistency semantics — documented caveat).

## 5. Docs

README sections for lazy blobs, exclude, tx.restart; migration notes for
node-firebird2 users (Isolation, autoupgrade, RETURNING already work).

## Build order

1 Legacy_Auth → 2 lazy blobs + streaming → 3 exclude → 4 tx.restart → 5 pool
blob helper + docs. Then M6 (Drizzle) on a stable core.
