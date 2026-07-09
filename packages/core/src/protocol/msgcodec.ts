import { Blr, SqlType } from './constants.js';
import type { SqlVarDesc } from './info.js';
import type { WireConnection } from './wire.js';
import type { XdrWriter } from './xdr.js';
import type { TextCodec } from '../charset/decoder.js';
import { decodeDate, decodeTimeMs, decodeTimestamp, encodeTimestamp, encodeDateOnly, timeMsToFractions } from '../types/datetime.js';
import { decodeDecFloat } from '../types/decfloat.js';
import { FirebirdError } from '../api/errors.js';

/** Marker for a blob id decoded from a row; materialized after the fetch. */
export class BlobRef {
  constructor(
    readonly id: Buffer,
    readonly subType: number,
  ) {}
}

export type ColumnReader = (wire: WireConnection) => Promise<unknown>;

export interface Int64Mode {
  int64As: 'auto' | 'bigint' | 'number';
}

function applyScale(v: bigint, scale: number, mode: Int64Mode['int64As']): unknown {
  if (scale < 0) {
    // Scaled NUMERIC/DECIMAL → number (documented: lossy beyond 2^53).
    return Number(v) / 10 ** -scale;
  }
  if (scale > 0) return Number(v) * 10 ** scale;
  if (mode === 'bigint') return v;
  if (mode === 'number') return Number(v);
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

async function readPadded(wire: WireConnection, len: number): Promise<Buffer> {
  if (len === 0) return Buffer.alloc(0);
  const padded = (len + 3) & ~3;
  return (await wire.transport.read(padded)).subarray(0, len);
}

/** Build the reader for one output column, resolved once at prepare time. */
export function makeColumnReader(desc: SqlVarDesc, textCodec: TextCodec | null, int64As: Int64Mode['int64As']): ColumnReader {
  const scale = desc.scale;
  switch (desc.type) {
    case SqlType.TEXT: {
      const len = desc.length;
      if (textCodec) {
        return async (w) => {
          const raw = await readPadded(w, len);
          const v = textCodec.decode(raw);
          // CHAR is blank-padded; trim trailing spaces on strings.
          return typeof v === 'string' ? v.replace(/ +$/, '') : v;
        };
      }
      return async (w) => Buffer.from(await readPadded(w, len));
    }
    case SqlType.VARYING:
      if (textCodec) {
        return async (w) => textCodec.decode(Buffer.from(await w.readOpaque()));
      }
      return async (w) => Buffer.from(await w.readOpaque());
    case SqlType.SHORT:
    case SqlType.LONG:
      return async (w) => applyScale(BigInt(await w.readInt32()), scale, scale === 0 ? 'number' : int64As);
    case SqlType.INT64:
      return async (w) => applyScale((await w.transport.read(8)).readBigInt64BE(0), scale, int64As);
    case SqlType.INT128:
      return async (w) => {
        const b = await w.transport.read(16);
        const v = (b.readBigInt64BE(0) << 64n) | b.readBigUInt64BE(8);
        return applyScale(v, scale, 'bigint');
      };
    case SqlType.FLOAT:
      return async (w) => (await w.transport.read(4)).readFloatBE(0);
    case SqlType.DOUBLE:
    case SqlType.D_FLOAT:
      return async (w) => (await w.transport.read(8)).readDoubleBE(0);
    case SqlType.BOOLEAN:
      return async (w) => (await w.readInt32()) !== 0;
    case SqlType.TYPE_DATE:
      return async (w) => {
        const days = await w.readInt32();
        const d = decodeDate(days);
        return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      };
    case SqlType.TYPE_TIME:
      return async (w) => {
        const ms = decodeTimeMs((await w.readInt32()) >>> 0);
        return new Date(new Date(1970, 0, 1).valueOf() + ms); // local wall-clock time-of-day
      };
    case SqlType.TIMESTAMP:
      return async (w) => {
        const days = await w.readInt32();
        const frac = (await w.readInt32()) >>> 0;
        return decodeTimestamp(days, frac);
      };
    case SqlType.TIMESTAMP_TZ:
    case SqlType.TIMESTAMP_TZ_EX: {
      const extra = desc.type === SqlType.TIMESTAMP_TZ_EX ? 1 : 0;
      return async (w) => {
        const days = await w.readInt32();
        const frac = (await w.readInt32()) >>> 0;
        await w.transport.read(4 + extra * 4); // zone id (+ ext offset) — instant is UTC
        const ms = (days - 40_587) * 86_400_000 + frac / 10;
        return new Date(ms);
      };
    }
    case SqlType.TIME_TZ:
    case SqlType.TIME_TZ_EX: {
      const extra = desc.type === SqlType.TIME_TZ_EX ? 1 : 0;
      return async (w) => {
        const frac = (await w.readInt32()) >>> 0;
        await w.transport.read(4 + extra * 4); // zone id
        return new Date(frac / 10); // UTC time-of-day on 1970-01-01
      };
    }
    case SqlType.BLOB:
    case SqlType.QUAD:
    case SqlType.ARRAY: {
      const subType = desc.subType;
      return async (w) => new BlobRef(Buffer.from(await w.transport.read(8)), subType);
    }
    case SqlType.DEC16:
      // IEEE 754-2008 decimal64/128 (DPD) → exact decimal string.
      return async (w) => decodeDecFloat(Buffer.from(await w.transport.read(8)));
    case SqlType.DEC34:
      return async (w) => decodeDecFloat(Buffer.from(await w.transport.read(16)));
    case SqlType.NULL:
      return async () => null;
    default:
      throw new FirebirdError(`Unsupported SQL type ${desc.type} in result set`);
  }
}

/** Read one row: protocol ≥13 null bitmap, then non-null values in order. */
export async function readRow(wire: WireConnection, readers: ColumnReader[]): Promise<unknown[]> {
  const n = readers.length;
  const bitmapLen = (n + 7) >> 3;
  const bitmap = await readPadded(wire, bitmapLen);
  const row = new Array<unknown>(n);
  for (let i = 0; i < n; i++) {
    if (bitmap[i >> 3]! & (1 << (i & 7))) {
      row[i] = null;
    } else {
      row[i] = await readers[i]!(wire);
    }
  }
  return row;
}

// ── BLR builders ───────────────────────────────────────────────────────────

class BlrBuilder {
  readonly bytes: number[] = [];

  byte(b: number): this {
    this.bytes.push(b & 0xff);
    return this;
  }

  word(w: number): this {
    this.bytes.push(w & 0xff, (w >> 8) & 0xff);
    return this;
  }
}

function blrHeader(b: BlrBuilder, fieldCount: number): void {
  b.byte(Blr.version5).byte(Blr.begin).byte(Blr.message).byte(0).word(fieldCount * 2);
}

function blrFooter(b: BlrBuilder): Buffer {
  b.byte(Blr.end).byte(Blr.eoc);
  return Buffer.from(b.bytes);
}

/** Null-indicator slot that follows every field in a message BLR. */
function nullSlot(b: BlrBuilder): void {
  b.byte(Blr.short).byte(0);
}

/** BLR describing the server's output message, built from the describe info. */
export function buildOutputBlr(descs: SqlVarDesc[]): Buffer {
  const b = new BlrBuilder();
  blrHeader(b, descs.length);
  for (const d of descs) {
    switch (d.type) {
      case SqlType.TEXT:
        b.byte(Blr.text).word(d.length);
        break;
      case SqlType.VARYING:
        b.byte(Blr.varying).word(d.length);
        break;
      case SqlType.SHORT:
        b.byte(Blr.short).byte(d.scale);
        break;
      case SqlType.LONG:
        b.byte(Blr.long).byte(d.scale);
        break;
      case SqlType.INT64:
        b.byte(Blr.int64).byte(d.scale);
        break;
      case SqlType.INT128:
        b.byte(Blr.int128).byte(d.scale);
        break;
      case SqlType.FLOAT:
        b.byte(Blr.float);
        break;
      case SqlType.DOUBLE:
      case SqlType.D_FLOAT:
        b.byte(Blr.double);
        break;
      case SqlType.TYPE_DATE:
        b.byte(Blr.sql_date);
        break;
      case SqlType.TYPE_TIME:
        b.byte(Blr.sql_time);
        break;
      case SqlType.TIMESTAMP:
        b.byte(Blr.timestamp);
        break;
      case SqlType.BLOB:
      case SqlType.QUAD:
      case SqlType.ARRAY:
        b.byte(Blr.quad).byte(0);
        break;
      case SqlType.BOOLEAN:
        b.byte(Blr.bool);
        break;
      case SqlType.DEC16:
        b.byte(Blr.dec64);
        break;
      case SqlType.DEC34:
        b.byte(Blr.dec128);
        break;
      case SqlType.TIME_TZ:
        b.byte(Blr.sql_time_tz);
        break;
      case SqlType.TIMESTAMP_TZ:
        b.byte(Blr.timestamp_tz);
        break;
      case SqlType.TIME_TZ_EX:
        b.byte(Blr.ex_time_tz);
        break;
      case SqlType.TIMESTAMP_TZ_EX:
        b.byte(Blr.ex_timestamp_tz);
        break;
      default:
        throw new FirebirdError(`Unsupported output SQL type ${d.type}`);
    }
    nullSlot(b);
  }
  return blrFooter(b);
}

// ── Parameter encoding (value-driven BLR, matching data) ──────────────────

export type ParamValue =
  | null
  | undefined
  | string
  | number
  | bigint
  | boolean
  | Date
  | Buffer
  | BlobRef;

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export interface EncodedParams {
  blr: Buffer;
  message: Buffer;
}

/**
 * Encode parameter values into a message BLR + message data
 * (null bitmap first, padded with 0xFF, then non-null values).
 * `encodeText` resolves the text codec per parameter index.
 */
export function encodeParams(
  values: ParamValue[],
  encodeText: (index: number, value: string) => Buffer,
  writerFactory: () => XdrWriter,
): EncodedParams {
  const n = values.length;
  const blr = new BlrBuilder();
  blrHeader(blr, n);

  const data = writerFactory();
  const bitmapLen = (n + 7) >> 3;
  const bitmap = Buffer.alloc(bitmapLen);
  const paddedLen = (bitmapLen + 3) & ~3;
  const values2: Array<(w: XdrWriter) => void> = [];

  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined) {
      bitmap[i >> 3] = bitmap[i >> 3]! | (1 << (i & 7));
      blr.byte(Blr.text).word(1); // declared type is irrelevant for NULL
      nullSlot(blr);
      continue;
    }
    if (typeof v === 'string') {
      const bytes = encodeText(i, v);
      if (bytes.length > 0xffff) throw new FirebirdError('String parameter longer than 65535 bytes; use a BLOB column');
      blr.byte(Blr.text).word(bytes.length);
      values2.push((w) => w.opaqueFixed(bytes));
    } else if (typeof v === 'boolean') {
      // Sent as text: SMALLINT→BOOLEAN has no implicit conversion, text does.
      const bytes = Buffer.from(v ? 'true' : 'false', 'latin1');
      blr.byte(Blr.text).word(bytes.length);
      values2.push((w) => w.opaqueFixed(bytes));
    } else if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX) {
        blr.byte(Blr.long).byte(0);
        values2.push((w) => w.int32(v));
      } else if (Number.isInteger(v) && Number.isSafeInteger(v)) {
        blr.byte(Blr.int64).byte(0);
        values2.push((w) => w.bigInt64(BigInt(v)));
      } else {
        blr.byte(Blr.double);
        values2.push((w) => {
          const buf = Buffer.allocUnsafe(8);
          buf.writeDoubleBE(v, 0);
          w.raw(buf);
        });
      }
    } else if (typeof v === 'bigint') {
      if (v >= INT64_MIN && v <= INT64_MAX) {
        blr.byte(Blr.int64).byte(0);
        values2.push((w) => w.bigInt64(v));
      } else {
        blr.byte(Blr.int128).byte(0);
        values2.push((w) => {
          const buf = Buffer.allocUnsafe(16);
          buf.writeBigInt64BE(v >> 64n, 0);
          buf.writeBigUInt64BE(v & 0xffffffffffffffffn, 8);
          w.raw(buf);
        });
      }
    } else if (v instanceof Date) {
      blr.byte(Blr.timestamp);
      const { days, fractions } = encodeTimestamp(v);
      values2.push((w) => w.int32(days).uint32(fractions));
    } else if (v instanceof BlobRef) {
      blr.byte(Blr.quad).byte(0);
      const id = v.id;
      values2.push((w) => w.raw(id));
    } else if (Buffer.isBuffer(v)) {
      if (v.length > 0xffff) throw new FirebirdError('Buffer parameter longer than 65535 bytes; use a BLOB column');
      blr.byte(Blr.text).word(v.length);
      values2.push((w) => w.opaqueFixed(v));
    } else {
      throw new FirebirdError(`Unsupported parameter value type: ${typeof v}`);
    }
    nullSlot(blr);
  }

  data.raw(bitmap);
  for (let p = bitmapLen; p < paddedLen; p++) data.raw(Buffer.from([0xff]));
  for (const write of values2) write(data);

  return { blr: blrFooter(blr), message: data.finish() };
}

export { encodeDateOnly, timeMsToFractions };
