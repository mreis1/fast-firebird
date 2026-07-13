import { FirebirdError } from '../api/errors.js';
import { TZ_MAX_ID, TZ_NAMES } from './timezones.js';

/**
 * Firebird's offset-zone bias (TimeZoneUtil): offset-based zone ids are
 * `displacementMinutes + 1439`, occupying 0..2878 (−23:59..+23:59); named
 * (region) zones descend from 65535 through the generated TZ_NAMES table.
 */
const ONE_DAY_MINUTES = 1439;

/**
 * A `TIMESTAMP/TIME WITH TIME ZONE` value with its zone preserved.
 *
 * `date` is the exact UTC instant — the same value the default `'instant'`
 * mode returns — and `zone` is the IANA region name (`'Europe/Lisbon'`) or
 * fixed offset (`'+02:30'`) the value was stored with. Returned by columns
 * when the connection sets `timeZones: 'zoned'`; accepted as a parameter
 * value for WITH TIME ZONE columns in either mode.
 *
 * For wall-clock rendering use the platform's full tzdata via Intl, e.g.
 * `zd.date.toLocaleString('en-GB', { timeZone: zd.zone })`.
 */
export class ZonedDate {
  constructor(
    /** The exact instant (UTC). For TIME WITH TIME ZONE: on 1970-01-01. */
    readonly date: Date,
    /** IANA zone name or '±HH:MM' fixed offset, exactly as stored. */
    readonly zone: string,
  ) {}

  /** Epoch millis of the instant — makes ZonedDate sortable/comparable. */
  valueOf(): number {
    return this.date.valueOf();
  }

  toString(): string {
    return `${this.date.toISOString()}[${this.zone}]`;
  }
}

/** Firebird time zone id → zone string ('Europe/Lisbon' or '+02:30'). */
export function tzIdToZone(id: number): string {
  if (id <= 2 * ONE_DAY_MINUTES) {
    const disp = id - ONE_DAY_MINUTES;
    const abs = Math.abs(disp);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `${disp < 0 ? '-' : '+'}${hh}:${mm}`;
  }
  // Unknown ids (server newer than our generated table) still round-trip
  // through zoneToTzId via this marker form.
  return TZ_NAMES[TZ_MAX_ID - id] ?? `tz#${id}`;
}

let nameToId: Map<string, number> | null = null;

/** Zone string → Firebird time zone id. Throws on unknown names. */
export function zoneToTzId(zone: string): number {
  const offset = /^([+-])(\d{1,2}):?(\d{2})$/.exec(zone);
  if (offset) {
    const disp = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3]));
    if (Math.abs(disp) > ONE_DAY_MINUTES) throw new FirebirdError(`Time zone offset out of range: '${zone}'`);
    return disp + ONE_DAY_MINUTES;
  }
  const marker = /^tz#(\d+)$/.exec(zone);
  if (marker) return Number(marker[1]);
  nameToId ??= new Map(TZ_NAMES.map((n, i) => [n.toLowerCase(), TZ_MAX_ID - i]));
  const id = nameToId.get(zone.toLowerCase());
  if (id === undefined) {
    throw new FirebirdError(`Unknown time zone: '${zone}' (expected an IANA name like 'Europe/Lisbon' or an offset like '+02:00')`);
  }
  return id;
}
