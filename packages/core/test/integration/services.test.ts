import { describe, expect, it } from 'vitest';
import { connectService } from '../../src/index.js';
import { FB_BASE, FB_SERVERS } from './env.js';

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
