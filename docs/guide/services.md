# Services API

The Services API talks to the server itself rather than a database — server
info, statistics, and server-side backup/restore.

```ts
import { connectService } from '@fast-firebird/core';

const svc = await connectService({ host, user: 'SYSDBA', password: 'masterkey' });
const info = await svc.getServerInfo();      // version, implementation, security db
const stats = await svc.getStatistics('/data/app.fdb');  // gstat output

// Server-side gbak (both paths are SERVER paths); returns the verbose log.
await svc.backup('/data/app.fdb', '/backups/app.fbk');
await svc.restore('/backups/app.fbk', '/data/app_copy.fdb');            // create
await svc.restore('/backups/app.fbk', '/data/app.fdb', { replace: true }); // overwrite

await svc.disconnect();
```

::: warning Server paths
`backup`/`restore` run **on the server** (like `gbak -se`): both the database
path and the backup-file path are paths on the server's filesystem, and the
backup file lands there — nothing is streamed to the client.
:::

## Physical incremental backup (nbackup)

gbak is a logical dump — on a multi-GB database it is far too slow for a
maintenance window. `nbackup` copies **pages**, works while the database is
online, and supports incremental levels: level 0 is a full physical copy,
level *n* captures only pages changed since the last level *n−1* backup.

```ts
await svc.nbackup('/data/app.fdb', '/backups/app.nbk0', { level: 0 }); // full
// … later, much smaller and faster:
await svc.nbackup('/data/app.fdb', '/backups/app.nbk1', { level: 1 }); // delta

// Restore the chain IN ORDER into a NEW database (never overwrites):
await svc.nrestore(['/backups/app.nbk0', '/backups/app.nbk1'], '/data/restored.fdb');
```

Options: `{ guid }` (FB4+) addresses the base backup by GUID from
`RDB$BACKUP_HISTORY` instead of a level; `noDBTriggers` suppresses database
triggers during the run; `direct: true | false` forces direct I/O. Same
server-path caveat as gbak. Like the CLI's `-B`, this backs up to a file — the
lock/copy/unlock dance (`-L`/`-N`/`-F`) for external file copies is not part
of the services API.
