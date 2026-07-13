import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, ZonedDate, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT, ddl, freshDb } from './env.js';

/**
 * Zone-preserving TIMESTAMP/TIME WITH TIME ZONE (deferred backlog #2).
 * Default 'instant' mode keeps returning UTC-exact JS Dates; the opt-in
 * `timeZones: 'zoned'` connection mode returns ZonedDate {date, zone}.
 * TZ types exist since FB4 — FB3 is excluded.
 */
describe.each(FB_SERVERS.filter((s) => s.version >= 4))('zoned time zones on Firebird $version', ({ port, version }) => {
  let instant: Attachment; // default mode
  let zoned: Attachment; // timeZones: 'zoned'
  const t = `T_TZ_${version}`;

  beforeAll(async () => {
    instant = await freshDb(port);
    await ddl(instant, `recreate table ${t} (id integer not null primary key, ts timestamp with time zone, tt time with time zone)`);
    // Second connection to the SAME database, in zoned mode.
    zoned = await connect({ ...FB_BASE, port, database: (instant as any).options.database, timeZones: 'zoned' });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await zoned?.disconnect();
    await instant?.dropDatabase();
  });

  it("default 'instant' mode: UTC-exact Date, zone dropped (unchanged behavior)", async () => {
    const [r] = await instant.query(
      `select timestamp '2026-01-15 09:30:00 America/New_York' as ts from rdb$database`,
    );
    expect(r!.TS).toBeInstanceOf(Date);
    expect((r!.TS as Date).toISOString()).toBe('2026-01-15T14:30:00.000Z'); // EST = UTC-5
  });

  it("'zoned' mode: same instant PLUS the stored zone name", async () => {
    const [r] = await zoned.query(
      `select timestamp '2026-01-15 09:30:00 America/New_York' as ts from rdb$database`,
    );
    const z = r!.TS as ZonedDate;
    expect(z).toBeInstanceOf(ZonedDate);
    expect(z.date.toISOString()).toBe('2026-01-15T14:30:00.000Z');
    expect(z.zone).toBe('America/New_York');
    expect(z.toString()).toBe('2026-01-15T14:30:00.000Z[America/New_York]');
    expect(+z).toBe(z.date.valueOf()); // sortable via valueOf
  });

  it('offset-based zones decode as ±HH:MM', async () => {
    const [r] = await zoned.query(`select timestamp '2026-01-15 11:30:00 +02:30' as ts from rdb$database`);
    const z = r!.TS as ZonedDate;
    expect(z.date.toISOString()).toBe('2026-01-15T09:00:00.000Z');
    expect(z.zone).toBe('+02:30');
    const [n] = await zoned.query(`select timestamp '2026-01-15 06:30:00 -03:00' as ts from rdb$database`);
    expect((n!.TS as ZonedDate).zone).toBe('-03:00');
  });

  it('TIME WITH TIME ZONE preserves the zone too', async () => {
    const [r] = await zoned.query(`select time '10:00:00 Europe/Lisbon' as tt from rdb$database`);
    const z = r!.TT as ZonedDate;
    expect(z).toBeInstanceOf(ZonedDate);
    expect(z.zone).toBe('Europe/Lisbon');
  });

  it('ZonedDate params round-trip zone AND instant through a table', async () => {
    const written = new ZonedDate(new Date('2026-07-13T14:30:00.000Z'), 'Europe/Lisbon');
    const tod = new ZonedDate(new Date('1970-01-01T10:15:00.000Z'), '+02:30');
    await zoned.execute(`insert into ${t} (id, ts, tt) values (?, ?, ?)`, [1, written, tod]);

    const [r] = await zoned.query(`select ts, tt from ${t} where id = 1`);
    const ts = r!.TS as ZonedDate;
    expect(ts.date.toISOString()).toBe('2026-07-13T14:30:00.000Z');
    expect(ts.zone).toBe('Europe/Lisbon');
    const tt = r!.TT as ZonedDate;
    expect(tt.zone).toBe('+02:30');
    expect(tt.date.toISOString()).toBe('1970-01-01T10:15:00.000Z');

    // The same value read on an 'instant' connection is the plain UTC Date.
    const [plain] = await instant.query(`select ts from ${t} where id = 1`);
    expect((plain!.TS as Date).toISOString()).toBe('2026-07-13T14:30:00.000Z');
  });

  it('ZonedDate params match in WHERE comparisons', async () => {
    const v = new ZonedDate(new Date('2026-07-13T14:30:00.000Z'), 'Europe/Lisbon');
    const rows = await zoned.query(`select id from ${t} where ts = ?`, [v]);
    expect(rows).toEqual([{ ID: 1 }]);
  });

  it('plain Date params still bind to TZ columns (existing behavior)', async () => {
    await instant.execute(`insert into ${t} (id, ts) values (?, ?)`, [2, new Date(2026, 0, 10, 12, 0, 0)]);
    const [r] = await instant.query(`select ts from ${t} where id = 2`);
    expect(r!.TS).toBeInstanceOf(Date);
  });

  it('unknown zone names throw a clear driver-side error', async () => {
    const bad = new ZonedDate(new Date(), 'Mars/Olympus_Mons');
    await expect(zoned.execute(`insert into ${t} (id, ts) values (?, ?)`, [3, bad])).rejects.toThrow(/Unknown time zone/);
  });

  it('zone survives CURRENT_TIMESTAMP with a session zone', async () => {
    await zoned.transaction(async (tx) => {
      await tx.execute(`set time zone 'America/Sao_Paulo'`);
      const [r] = await tx.query(`select current_timestamp as ts from rdb$database`);
      expect((r!.TS as ZonedDate).zone).toBe('America/Sao_Paulo');
    });
  });
});
