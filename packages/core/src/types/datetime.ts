/**
 * Firebird date/time wire representation:
 * - DATE: signed days since 17 November 1898 (the "Modified Julian Day" base).
 * - TIME: unsigned fractions of 1/10000 second since midnight.
 * - TIMESTAMP: both, in that order.
 *
 * JS Dates are lossy beyond milliseconds; sub-millisecond fractions are
 * preserved when encoding values produced by our own decoder via the
 * `fractions` carry, and truncated otherwise.
 */

/** Days between 1898-11-17 and Unix epoch 1970-01-01. */
const EPOCH_DIFF_DAYS = 40_587;
const MS_PER_DAY = 86_400_000;
/** Time fractions per millisecond (Firebird stores 1/10000 s). */
const FRAC_PER_MS = 10;

export function decodeDate(days: number): Date {
  return new Date((days - EPOCH_DIFF_DAYS) * MS_PER_DAY);
}

/** Encodes the DATE portion (UTC calendar date of `d`... local-vs-UTC is decided by the codec layer). */
export function dateToDays(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY) + EPOCH_DIFF_DAYS;
}

export function decodeTimeMs(fractions: number): number {
  return fractions / FRAC_PER_MS;
}

export function timeMsToFractions(ms: number): number {
  return Math.round(ms * FRAC_PER_MS);
}

/**
 * Decode a wire TIMESTAMP into a JS Date interpreted as *local* time
 * (Firebird TIMESTAMP without time zone is wall-clock time; matching the
 * behavior users expect from node-firebird).
 */
export function decodeTimestamp(days: number, fractions: number): Date {
  const utcMidnight = new Date((days - EPOCH_DIFF_DAYS) * MS_PER_DAY);
  const localMidnight = new Date(utcMidnight.getUTCFullYear(), utcMidnight.getUTCMonth(), utcMidnight.getUTCDate());
  return new Date(localMidnight.valueOf() + fractions / FRAC_PER_MS);
}

export function encodeTimestamp(value: Date): { days: number; fractions: number } {
  const days = dateToDays(value.getFullYear(), value.getMonth() + 1, value.getDate());
  const ms =
    value.getHours() * 3_600_000 +
    value.getMinutes() * 60_000 +
    value.getSeconds() * 1_000 +
    value.getMilliseconds();
  return { days, fractions: timeMsToFractions(ms) };
}

export function encodeDateOnly(value: Date): number {
  return dateToDays(value.getFullYear(), value.getMonth() + 1, value.getDate());
}
