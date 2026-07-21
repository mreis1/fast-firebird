# Firebird 6 (protocol 20, schemas)

Against an FB6 server the driver negotiates protocol 20 automatically (inline
blobs included), and the new attach-time options are exposed:

```ts
// Schema search path — how unqualified names resolve (FB6 default: PUBLIC, SYSTEM)
const db = await connect({ host, database, searchPath: ['APP', 'PUBLIC'] });
await db.query('select * from settings');   // finds APP.SETTINGS

// Create a database owned by another user
await createDatabase({ host, database, owner: 'APP_OWNER' });
```

Both options are silently ignored by pre-FB6 servers, so they're safe to set
in configs shared across versions.

## What Firebird 6 adds

The headline SQL-level features (all exercised by the driver's test suite and
the [demo dashboard](https://github.com/mreis1/fast-firebird/tree/main/apps/demo)'s
feature explorer against the `firebirdsql/firebird:6-snapshot` image):

- **SQL schemas** — `CREATE SCHEMA`, qualified names, `CURRENT_SCHEMA`, and a
  schema search path inside one database.
- **`CAST … FORMAT`** — format and parse datetimes with Oracle-style masks.
- **`GREATEST` / `LEAST` / `BTRIM`** — row-wise min/max and trim-any-character.
- **`ANY_VALUE`** — pick an arbitrary representative per group.

## Tracked continuously

FB6 support is tracked against the `firebirdsql/firebird:6-snapshot` image in
CI (the same suite as FB3/4/5); a canary test watches for the arrival of
upstream JSON support.

::: info Snapshot status
Firebird 6 is pre-release. The driver targets the current snapshot protocol
(20) and follows changes as they land upstream.
:::
