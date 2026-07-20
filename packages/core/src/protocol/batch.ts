/**
 * Wire batch API (FB4+/protocol ≥ 16): op_batch_create/msg/exec/regblob/rls.
 *
 * Unlike the normal execute path (value-driven BLR per call), a batch fixes
 * ONE message format at create time for every row. The format is built from
 * the statement's described inputs, mapped to wire-friendly types the server
 * coerces from (see plans/batch.md for the full table + source references):
 * text → varying, date/time → timestamp, EX time zones → non-EX, short →
 * long. `p_batch_msglen` must equal the engine's internal layout length for
 * OUR emitted BLR (per-type alignment rules from PARSE_msg_format — the same
 * table jaybird's calculateBatchMessageLength implements).
 */

import { BatchPb, Blr, Op, SqlType } from './constants.js';
import {
  BlobRef,
  BlrBuilder,
  DecFloatVal,
  blrFooter,
  blrHeader,
  nullSlot,
  type ParamValue,
} from './msgcodec.js';
import { XdrWriter } from './xdr.js';
import { encodeTimestamp, encodeTimestampUtc } from '../types/datetime.js';
import { ZonedDate, zoneToTzId } from '../types/zoned-date.js';
import { FirebirdError, FirebirdProtocolError } from '../api/errors.js';
import type { SqlVarDesc } from './info.js';
import type { WireConnection } from './wire.js';

/** Firebird zone id for the +00:00 offset zone (offsetMinutes + 1439). */
const TZ_ID_UTC_OFFSET = 1439;

const INT32_MIN = -2_147_483_648n;
const INT32_MAX = 2_147_483_647n;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const INT128_MIN = -(2n ** 127n);
const INT128_MAX = 2n ** 127n - 1n;

export type BatchFieldWriter = (w: XdrWriter, v: NonNullable<ParamValue>, encodeText: (index: number, value: string) => Buffer) => void;

export interface BatchFormat {
  /** Input-message BLR sent in op_batch_create. */
  blr: Buffer;
  /** Engine-side layout length of one message for that BLR (p_batch_msglen). */
  msglen: number;
  /** FB_ALIGN(msglen, 8) — what the server charges per row against its buffer. */
  alignedStride: number;
  /** Per-field wire encoder for non-NULL values, in parameter order. */
  writers: BatchFieldWriter[];
  /** Parameter indices with a described BLOB type (need op_batch_regblob). */
  blobIndices: number[];
}

function fbAlign(len: number, alignment: number): number {
  return (len + alignment - 1) & ~(alignment - 1);
}

/**
 * Exact decimal → scaled integer (value × 10^fracDigits), rounding
 * half-away-from-zero on excess fraction digits. String arithmetic — no
 * float multiplication, so '12.5' at scale -2 is exactly 1250n.
 */
export function decimalToScaled(text: string, fracDigits: number, ctx: string): bigint {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m || !(m[2] || m[3])) {
    throw new FirebirdError(`${ctx}: cannot convert '${text}' to a scaled numeric value`);
  }
  const sign = m[1] === '-' ? -1n : 1n;
  const digits = (m[2] ?? '') + (m[3] ?? '');
  let pointPos = (m[2] ?? '').length;
  if (m[4]) pointPos += Number(m[4]);
  // value = digits × 10^(pointPos − digits.length); scale by 10^fracDigits.
  const shift = pointPos - digits.length + fracDigits;
  if (shift >= 0) return sign * BigInt(digits || '0') * 10n ** BigInt(shift);
  const keep = digits.length + shift;
  let scaled = BigInt(keep > 0 ? digits.slice(0, keep) : '0');
  // keep < 0 means the value's first significant digit already sits more than
  // one place beyond the target scale — the digit being rounded on is a
  // padding zero, so nothing rounds up.
  if (keep >= 0 && digits.charCodeAt(keep) >= 0x35 /* '5' */) scaled += 1n;
  return sign * scaled;
}

function toScaledBigInt(v: NonNullable<ParamValue>, fracDigits: number, ctx: string): bigint {
  if (typeof v === 'bigint') return v * 10n ** BigInt(fracDigits);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new FirebirdError(`${ctx}: cannot bind non-finite number to an integer/numeric column`);
    if (Number.isSafeInteger(v)) return BigInt(v) * 10n ** BigInt(fracDigits);
    return decimalToScaled(String(v), fracDigits, ctx);
  }
  if (typeof v === 'string') return decimalToScaled(v, fracDigits, ctx);
  throw new FirebirdError(`${ctx}: cannot bind a ${typeof v} to an integer/numeric column`);
}

function checkRange(v: bigint, min: bigint, max: bigint, ctx: string): bigint {
  if (v < min || v > max) throw new FirebirdError(`${ctx}: value ${v} out of range for the column type`);
  return v;
}

function asNumber(v: NonNullable<ParamValue>, ctx: string): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isNaN(n) && v.trim().toLowerCase() !== 'nan') {
      throw new FirebirdError(`${ctx}: cannot convert '${v}' to a floating-point value`);
    }
    return n;
  }
  throw new FirebirdError(`${ctx}: cannot bind a ${typeof v} to a floating-point column`);
}

/** Build the fixed batch message format from the described input parameters. */
export function buildBatchFormat(inputs: SqlVarDesc[]): BatchFormat {
  const b = new BlrBuilder();
  blrHeader(b, inputs.length);
  const writers: BatchFieldWriter[] = [];
  const blobIndices: number[] = [];
  let msglen = 0;

  /** Account one field in the engine's message layout, then its null short. */
  const addField = (fieldLen: number, alignment: number): void => {
    if (alignment > 1) msglen = fbAlign(msglen, alignment);
    msglen += fieldLen;
    msglen = fbAlign(msglen, 2) + 2; // null-indicator short after every field
  };

  for (let i = 0; i < inputs.length; i++) {
    const d = inputs[i]!;
    const ctx = `Batch parameter ${i + 1}`;
    const scale = d.scale;
    const fracDigits = -scale;
    switch (d.type) {
      case SqlType.TEXT:
      case SqlType.VARYING:
      case SqlType.NULL: {
        const cap = d.type === SqlType.NULL ? 0 : d.length;
        b.byte(Blr.varying).word(cap);
        addField(cap + 2, 2);
        writers.push((w, v, encodeText) => {
          let bytes: Buffer;
          if (typeof v === 'string') bytes = encodeText(i, v);
          else if (Buffer.isBuffer(v)) bytes = v;
          else if (typeof v === 'number' || typeof v === 'bigint') bytes = Buffer.from(String(v), 'latin1');
          else if (typeof v === 'boolean') bytes = Buffer.from(v ? 'true' : 'false', 'latin1');
          else if (v instanceof Date) throw new FirebirdError(`${ctx}: cannot bind a Date to a text column in a batch`);
          else throw new FirebirdError(`${ctx}: unsupported value for a text column`);
          if (bytes.length > cap) {
            throw new FirebirdError(`${ctx}: encoded value is ${bytes.length} bytes, column allows ${cap}`);
          }
          w.opaque(bytes);
        });
        break;
      }
      case SqlType.SHORT:
      case SqlType.LONG:
        b.byte(Blr.long).byte(scale);
        addField(4, 4);
        writers.push((w, v) => w.int32(Number(checkRange(toScaledBigInt(v, fracDigits, ctx), INT32_MIN, INT32_MAX, ctx))));
        break;
      case SqlType.INT64:
        b.byte(Blr.int64).byte(scale);
        addField(8, 8);
        writers.push((w, v) => w.bigInt64(checkRange(toScaledBigInt(v, fracDigits, ctx), INT64_MIN, INT64_MAX, ctx)));
        break;
      case SqlType.INT128:
        b.byte(Blr.int128).byte(scale);
        addField(16, 8);
        writers.push((w, v) => {
          const big = checkRange(toScaledBigInt(v, fracDigits, ctx), INT128_MIN, INT128_MAX, ctx);
          const buf = Buffer.allocUnsafe(16);
          buf.writeBigInt64BE(big >> 64n, 0);
          buf.writeBigUInt64BE(big & 0xffffffffffffffffn, 8);
          w.raw(buf);
        });
        break;
      case SqlType.FLOAT:
        b.byte(Blr.float);
        addField(4, 4);
        writers.push((w, v) => {
          const buf = Buffer.allocUnsafe(4);
          buf.writeFloatBE(asNumber(v, ctx), 0);
          w.raw(buf);
        });
        break;
      case SqlType.DOUBLE:
      case SqlType.D_FLOAT:
        b.byte(Blr.double);
        addField(8, 8);
        writers.push((w, v) => {
          const buf = Buffer.allocUnsafe(8);
          buf.writeDoubleBE(asNumber(v, ctx), 0);
          w.raw(buf);
        });
        break;
      case SqlType.TYPE_DATE:
      case SqlType.TYPE_TIME:
      case SqlType.TIMESTAMP:
        // One shape for all three: the server truncates timestamp → date/time,
        // exactly as it does for our value-driven execute messages.
        b.byte(Blr.timestamp);
        addField(8, 4);
        writers.push((w, v) => {
          if (!(v instanceof Date)) throw new FirebirdError(`${ctx}: pass a Date for a DATE/TIME/TIMESTAMP column in a batch`);
          const { days, fractions } = encodeTimestamp(v);
          w.int32(days).uint32(fractions);
        });
        break;
      case SqlType.TIMESTAMP_TZ:
      case SqlType.TIMESTAMP_TZ_EX:
        // Internal length is sizeof(ISC_TIMESTAMP_TZ) = 12 — the struct pads
        // its trailing USHORT to the 4-byte struct alignment.
        b.byte(Blr.timestamp_tz);
        addField(12, 4);
        writers.push((w, v) => {
          let days: number, fractions: number, tzId: number;
          if (v instanceof ZonedDate) {
            ({ days, fractions } = encodeTimestampUtc(v.date));
            tzId = zoneToTzId(v.zone);
          } else if (v instanceof Date) {
            ({ days, fractions } = encodeTimestampUtc(v));
            tzId = TZ_ID_UTC_OFFSET;
          } else {
            throw new FirebirdError(`${ctx}: pass a Date or ZonedDate for a TIMESTAMP WITH TIME ZONE column`);
          }
          w.int32(days).uint32(fractions).uint32(tzId);
        });
        break;
      case SqlType.TIME_TZ:
      case SqlType.TIME_TZ_EX:
        // sizeof(ISC_TIME_TZ) = 8 (padded), same as the timestamp case above.
        b.byte(Blr.sql_time_tz);
        addField(8, 4);
        writers.push((w, v) => {
          let date: Date, tzId: number;
          if (v instanceof ZonedDate) {
            date = v.date;
            tzId = zoneToTzId(v.zone);
          } else if (v instanceof Date) {
            date = v;
            tzId = TZ_ID_UTC_OFFSET;
          } else {
            throw new FirebirdError(`${ctx}: pass a Date or ZonedDate for a TIME WITH TIME ZONE column`);
          }
          const msOfDay = ((date.getTime() % 86_400_000) + 86_400_000) % 86_400_000;
          w.uint32(msOfDay * 10).uint32(tzId);
        });
        break;
      case SqlType.BLOB:
      case SqlType.QUAD:
      case SqlType.ARRAY:
        if (d.type === SqlType.BLOB) {
          // Must be blr_blob2 (not quad): DsqlBatch scans the format for blob
          // fields, and registerBlob fails with "no blobs in batch statement"
          // when none are declared. Words: subtype, charset (blob charset
          // lives in desc.scale).
          b.byte(Blr.blob2).word(d.subType).word(d.scale & 0xff);
          blobIndices.push(i);
        } else {
          b.byte(Blr.quad).byte(0);
        }
        addField(8, 4);
        writers.push((w, v) => {
          if (!(v instanceof BlobRef)) {
            // prepareParams uploads string/Buffer/stream blob values and binds
            // BlobRefs — anything else reaching here is unbindable.
            throw new FirebirdError(`${ctx}: unsupported value for a BLOB column in a batch`);
          }
          w.raw(v.id);
        });
        break;
      case SqlType.DEC16:
      case SqlType.DEC34: {
        const size = d.type === SqlType.DEC16 ? 8 : 16;
        b.byte(d.type === SqlType.DEC16 ? Blr.dec64 : Blr.dec128);
        addField(size, 8);
        writers.push((w, v) => {
          if (!(v instanceof DecFloatVal) || v.bytes.length !== size) {
            throw new FirebirdError(`${ctx}: unsupported value for a DECFLOAT column in a batch`);
          }
          w.raw(v.bytes);
        });
        break;
      }
      case SqlType.BOOLEAN:
        b.byte(Blr.bool);
        addField(1, 1);
        writers.push((w, v) => {
          let bit: number;
          if (typeof v === 'boolean') bit = v ? 1 : 0;
          else if (typeof v === 'number') bit = v !== 0 ? 1 : 0;
          else throw new FirebirdError(`${ctx}: pass a boolean for a BOOLEAN column`);
          w.opaqueFixed(Buffer.from([bit]));
        });
        break;
      default:
        throw new FirebirdError(`Batch parameter ${i + 1}: unsupported SQL type ${d.type}`);
    }
    nullSlot(b);
  }

  return {
    blr: blrFooter(b),
    msglen,
    alignedStride: fbAlign(msglen, 8),
    writers,
    blobIndices,
  };
}

/** Encode one row: null bitmap (4-padded), then non-NULL values in order. */
export function encodeBatchRow(
  format: BatchFormat,
  values: ParamValue[],
  encodeText: (index: number, value: string) => Buffer,
): Buffer {
  const n = format.writers.length;
  const w = new XdrWriter(64);
  const bitmap = Buffer.alloc((n + 7) >> 3);
  for (let i = 0; i < n; i++) {
    if (values[i] === null || values[i] === undefined) bitmap[i >> 3] = bitmap[i >> 3]! | (1 << (i & 7));
  }
  w.opaqueFixed(bitmap);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    format.writers[i]!(w, v, encodeText);
  }
  return w.finish();
}

// ── Batch parameter buffer (WideTagged clumplets, tag byte + LE lengths) ───

export interface BatchPbOptions {
  /** TAG_MULTIERROR: keep executing after a failed row. */
  multiError: boolean;
  /** TAG_RECORD_COUNTS: return a per-row update count in the completion. */
  recordCounts: boolean;
  /** TAG_BLOB_POLICY (BatchBlobPolicy value); omit for no blob parameters. */
  blobPolicy?: number;
  /** TAG_DETAILED_ERRORS: status vectors returned per failed row (server default 64, cap 256). */
  detailedErrors?: number;
}

export function buildBatchPb(o: BatchPbOptions): Buffer {
  const bytes: number[] = [BatchPb.version1];
  const intClumplet = (tag: number, value: number): void => {
    bytes.push(tag, 4, 0, 0, 0, value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  };
  if (o.multiError) intClumplet(BatchPb.tag_multierror, 1);
  if (o.recordCounts) intClumplet(BatchPb.tag_record_counts, 1);
  if (o.blobPolicy !== undefined) intClumplet(BatchPb.tag_blob_policy, o.blobPolicy);
  if (o.detailedErrors !== undefined) intClumplet(BatchPb.tag_detailed_errors, o.detailedErrors);
  return Buffer.from(bytes);
}

// ── Wire operations ─────────────────────────────────────────────────────────

export function writeBatchCreate(wire: WireConnection, stmtHandle: number, format: BatchFormat, pb: Buffer): void {
  wire.writer.int32(Op.batch_create).int32(stmtHandle).opaque(format.blr).uint32(format.msglen).opaque(pb);
}

/** op_batch_msg: rows are pre-encoded packed messages, written back-to-back. */
export function writeBatchMsg(wire: WireConnection, stmtHandle: number, rows: Buffer[]): void {
  const w = wire.writer.int32(Op.batch_msg).int32(stmtHandle).uint32(rows.length);
  for (const r of rows) w.raw(r);
}

/** Register an uploaded blob id with the batch (as itself, jaybird-style). */
export function writeBatchRegblob(wire: WireConnection, stmtHandle: number, blobId: Buffer): void {
  wire.writer.int32(Op.batch_regblob).int32(stmtHandle).raw(blobId).raw(blobId);
}

export function writeBatchExec(wire: WireConnection, stmtHandle: number, txHandle: number): void {
  wire.writer.int32(Op.batch_exec).int32(stmtHandle).int32(txHandle);
}

/** op_batch_rls — deferred like op_free_statement (rides the next packet). */
export function writeBatchRelease(wire: WireConnection, stmtHandle: number): void {
  wire.writer.int32(Op.batch_rls).int32(stmtHandle);
  wire.markDeferred();
}

// ── Completion state (op_batch_cs) ──────────────────────────────────────────

export interface BatchCompletion {
  /** Total records processed by this execute. */
  recCount: number;
  /**
   * Per-row update counts when record counts were requested (else empty).
   * Sentinels: -1 executed-but-failed, -2 succeeded-without-count.
   */
  updateCounts: number[];
  /** Failed rows: 0-based index within THIS execute; error null beyond the detailed cap. */
  errors: { index: number; error: FirebirdError | null }[];
}

/**
 * Read the op_batch_exec reply: op_batch_cs on success (even a fully failed
 * batch is a "success" at this level), or an error op_response (bad
 * transaction handle, no batch open, …) which throws.
 */
export async function readBatchCompletion(wire: WireConnection): Promise<BatchCompletion> {
  const op = await wire.readOp();
  if (op === Op.response) {
    await wire.parseResponseBody(); // throws the server error
    throw new FirebirdProtocolError('op_batch_exec answered with a plain op_response and no error');
  }
  if (op !== Op.batch_cs) throw new FirebirdProtocolError(`Unexpected op ${op} after op_batch_exec`);
  await wire.readInt32(); // p_batch_statement
  const recCount = await wire.readInt32();
  const updates = await wire.readInt32();
  const vectors = await wire.readInt32();
  const statusless = await wire.readInt32();
  const updateCounts: number[] = new Array(updates);
  for (let i = 0; i < updates; i++) updateCounts[i] = await wire.readInt32();
  const errors: BatchCompletion['errors'] = [];
  for (let i = 0; i < vectors; i++) {
    const index = await wire.readInt32();
    const { error } = await wire.readStatusVector();
    errors.push({ index, error });
  }
  for (let i = 0; i < statusless; i++) {
    errors.push({ index: await wire.readInt32(), error: null });
  }
  return { recCount, updateCounts, errors };
}
