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
