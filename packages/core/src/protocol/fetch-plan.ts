import { SqlType } from './constants.js';
import type { SqlVarDesc } from './info.js';

/**
 * Adaptive fetch sizing.
 *
 * A blind fixed batch (e.g. always 400 rows) either wastes memory on wide rows
 * or wastes round trips on narrow ones. Instead we size each op_fetch from the
 * row width (known from the prepare describe) against a byte budget, and ramp
 * the batch up across successive fetches so short result sets don't pull a
 * huge first batch while long scans quickly reach the budget ceiling.
 */

/** Target bytes per fetch batch (before the ceiling of `maxRows`). */
const TARGET_BATCH_BYTES = 256 * 1024;
/** Minimum rows per batch — keeps tiny-row scans from thousands of RTs. */
const MIN_BATCH_ROWS = 10;
/** First-batch row count (ramps upward from here). */
const RAMP_START_ROWS = 40;

/** Estimate the wire width of one row from its column descriptors. */
export function estimateRowWidth(descs: SqlVarDesc[]): number {
  let bytes = 4 + ((descs.length + 7) >> 3); // null bitmap (padded-ish)
  for (const d of descs) {
    switch (d.type) {
      case SqlType.TEXT:
      case SqlType.VARYING:
        bytes += 4 + d.length; // length prefix + declared max
        break;
      case SqlType.SHORT:
      case SqlType.LONG:
      case SqlType.FLOAT:
        bytes += 4;
        break;
      case SqlType.INT128:
      case SqlType.DEC34:
        bytes += 16;
        break;
      case SqlType.BLOB:
      case SqlType.ARRAY:
      case SqlType.QUAD:
        bytes += 8; // just the blob id on the wire
        break;
      default:
        bytes += 8; // int64, double, timestamp, dec16, tz, …
    }
  }
  return Math.max(bytes, 16);
}

/**
 * Rows to request in the next fetch. `maxRows` is the user's `fetchSize` cap;
 * `prevCount` is the previous batch's requested count (0 for the first fetch).
 */
export function nextFetchCount(rowWidth: number, maxRows: number, prevCount: number): number {
  const budgetRows = Math.max(MIN_BATCH_ROWS, Math.floor(TARGET_BATCH_BYTES / rowWidth));
  const ceiling = Math.min(maxRows, budgetRows);
  if (prevCount <= 0) return Math.min(RAMP_START_ROWS, ceiling);
  return Math.min(prevCount * 2, ceiling); // double each batch up to the ceiling
}
