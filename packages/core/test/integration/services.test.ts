import { describe, expect, it } from 'vitest';
import { connect, connectService } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, ddl, dropDatabaseAt, freshDb } from './env.js';

const creds = { host: FB_BASE.host, user: FB_BASE.user, password: FB_BASE.password };

describe.each(FB_SERVERS)('Services API on Firebird $version', ({ port, version }) => {
  it('attaches to the service manager and reports server version', async () => {
    const svc = await connectService({ ...creds, port });
    try {
      const info = await svc.getServerInfo();
      expect(info.serverVersion).toMatch(new RegExp(`Firebird ${version}\\.`));
      expect(info.implementation).toMatch(/Firebird/);
      expect(info.securityDatabase).toMatch(/security/);
    } finally {
      await svc.disconnect();
    }
  });

  it('retrieves database statistics (gstat)', async () => {
    const svc = await connectService({ ...creds, port });
    try {
      const stats = await svc.getStatistics('/var/lib/firebird/data/test.fdb');
      expect(stats).toMatch(/Database .*test\.fdb/);
      expect(stats).toMatch(/Gstat|Database header|Generation/i);
      expect(stats.length).toBeGreaterThan(100);
    } finally {
      await svc.disconnect();
    }
  });

  it('works over an unencrypted service connection', async () => {
    const svc = await connectService({ ...creds, port, wireCrypt: 'disabled' });
    try {
      const info = await svc.getServerInfo();
      expect(info.serverVersion).toContain('Firebird');
    } finally {
      await svc.disconnect();
    }
  });

  it('rejects a bad service password', async () => {
    await expect(connectService({ ...creds, port, password: 'wrong' })).rejects.toThrow(/user name|password|login|closed/i);
  });
});

describe.each(FB_SERVERS)('gbak backup/restore on Firebird $version', ({ port, version }) => {
  it('backs up a database and restores it to a new file (round trip)', async () => {
    // Build a small source database with recognizable content.
    const src = await freshDb(port);
    const srcPath = (src as any).options.database as string;
    const fbk = srcPath.replace(/\.fdb$/, '.fbk');
    const restoredPath = srcPath.replace(/\.fdb$/, '_restored.fdb');
    await ddl(src, `recreate table GB_T (id integer not null primary key, val varchar(30))`);
    await src.execute(`insert into GB_T values (1, 'survived gbak €')`);
    await src.disconnect(); // keep the file; backup needs no exclusive access anyway

    const svc = await connectService({ ...creds, port });
    try {
      const log = await svc.backup(srcPath, fbk);
      expect(log).toMatch(/gbak:/i);
      expect(log).toMatch(/closing file|committing|finishing/i);

      const rlog = await svc.restore(fbk, restoredPath);
      expect(rlog).toMatch(/gbak:/i);
      expect(rlog).toMatch(/creating|restoring|committing/i);
    } finally {
      await svc.disconnect();
    }

    // The restored database is a real, working database with the data.
    const restored = await connect({ ...FB_BASE, port, database: restoredPath });
    try {
      expect(await restored.queryOne(`select val from GB_T where id = 1`)).toEqual({ VAL: 'survived gbak €' });
    } finally {
      await restored.dropDatabase();
    }
    await dropDatabaseAt(port, srcPath);
  });

  it('nbackup level 0 + level 1 chain restores with all increments applied', async () => {
    const src = await freshDb(port);
    const srcPath = (src as any).options.database as string;
    const nbk0 = srcPath.replace(/\.fdb$/, '.nbk0');
    const nbk1 = srcPath.replace(/\.fdb$/, '.nbk1');
    const restoredPath = srcPath.replace(/\.fdb$/, '_nrestored.fdb');
    await ddl(src, `recreate table NB_T (id integer not null primary key, val varchar(30))`);
    await src.execute(`insert into NB_T values (1, 'in level 0 €')`);

    const svc = await connectService({ ...creds, port });
    try {
      // Level 0: full physical copy — the database stays ONLINE (src is
      // still attached); that is nbackup's whole point.
      await svc.nbackup(srcPath, nbk0, { level: 0 });
      await src.execute(`insert into NB_T values (2, 'in level 1')`);
      await svc.nbackup(srcPath, nbk1, { level: 1 });
      await src.disconnect();

      // Restore the chain in order into a NEW database.
      await svc.nrestore([nbk0, nbk1], restoredPath);
    } finally {
      if (src.isAlive) await src.disconnect().catch(() => undefined);
      await svc.disconnect();
    }

    const restored = await connect({ ...FB_BASE, port, database: restoredPath });
    try {
      const rows = await restored.query(`select id, val from NB_T order by id`);
      expect(rows).toEqual([
        { ID: 1, VAL: 'in level 0 €' },
        { ID: 2, VAL: 'in level 1' },
      ]);
    } finally {
      await restored.dropDatabase();
    }
    await dropDatabaseAt(port, srcPath);
  });

  it('nrestore refuses an existing target; nbackup rejects level+guid', async () => {
    const src = await freshDb(port);
    const srcPath = (src as any).options.database as string;
    const nbk = srcPath.replace(/\.fdb$/, '.nbkx');
    await src.disconnect();

    const svc = await connectService({ ...creds, port });
    try {
      await expect(svc.nbackup(srcPath, nbk, { level: 0, guid: '{X}' })).rejects.toThrow(/mutually exclusive/);
      await svc.nbackup(srcPath, nbk); // default level 0
      // nbackup never overwrites: restoring onto the live source path fails.
      await expect(svc.nrestore([nbk], srcPath)).rejects.toThrow(/exist|error|failed/i);
      await expect(svc.nrestore([], '/tmp/x.fdb')).rejects.toThrow(/at least one backup file/);
    } finally {
      await svc.disconnect();
    }
    await dropDatabaseAt(port, srcPath);
  });

  it('restore without replace refuses to overwrite an existing database', async () => {
    const src = await freshDb(port);
    const srcPath = (src as any).options.database as string;
    const fbk = srcPath.replace(/\.fdb$/, '.fbk');
    await ddl(src, `recreate table GB_T2 (id integer not null primary key)`);
    await src.disconnect();

    const svc = await connectService({ ...creds, port });
    try {
      await svc.backup(srcPath, fbk);
      // Target exists (the source itself) and replace was not requested.
      await expect(svc.restore(fbk, srcPath)).rejects.toThrow(/exist|already|database/i);
      // replace: true overwrites it.
      const rlog = await svc.restore(fbk, srcPath, { replace: true });
      expect(rlog).toMatch(/gbak:/i);
    } finally {
      await svc.disconnect();
    }
    await dropDatabaseAt(port, srcPath);
  });
});
