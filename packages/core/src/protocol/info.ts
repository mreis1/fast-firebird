import { SqlInfo, StmtType } from './constants.js';
import { FirebirdProtocolError } from '../api/errors.js';

/** One described column or parameter (an XSQLVAR equivalent). */
export interface SqlVarDesc {
  /** SQL type with the nullable bit stripped (SqlType). */
  type: number;
  nullable: boolean;
  subType: number;
  scale: number;
  /** Wire byte length for the value. */
  length: number;
  field?: string;
  relation?: string;
  owner?: string;
  alias?: string;
}

export interface StatementDescription {
  stmtType: StmtType;
  inputs: SqlVarDesc[];
  outputs: SqlVarDesc[];
}

/**
 * Reads Firebird info-response clumplets: `item(1) len(UInt16LE) data`.
 * Numeric data is little-endian, 1/2/4 bytes.
 */
export class ClumpletReader {
  pos = 0;

  constructor(readonly buf: Buffer) {}

  get done(): boolean {
    return this.pos >= this.buf.length || this.buf[this.pos] === SqlInfo.end;
  }

  peekItem(): number {
    return this.buf[this.pos]!;
  }

  nextItem(): number {
    return this.buf[this.pos++]!;
  }

  readInt(): number {
    const len = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    let v: number;
    switch (len) {
      case 0:
        v = 0;
        break;
      case 1:
        v = this.buf.readInt8(this.pos);
        break;
      case 2:
        v = this.buf.readInt16LE(this.pos);
        break;
      case 4:
        v = this.buf.readInt32LE(this.pos);
        break;
      default:
        throw new FirebirdProtocolError(`Unexpected info integer length ${len}`);
    }
    this.pos += len;
    return v;
  }

  readString(): string {
    const len = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    const s = this.buf.toString('utf8', this.pos, this.pos + len);
    this.pos += len;
    return s;
  }

  skipCluster(): void {
    const len = this.buf.readUInt16LE(this.pos);
    this.pos += 2 + len;
  }
}

/** Info items sent with op_prepare_statement (full describe of both sides). */
export const DESCRIBE_INFO_ITEMS = Buffer.from([
  SqlInfo.stmt_type,
  SqlInfo.select,
  SqlInfo.describe_vars,
  SqlInfo.sqlda_seq,
  SqlInfo.type,
  SqlInfo.sub_type,
  SqlInfo.scale,
  SqlInfo.length,
  SqlInfo.field,
  SqlInfo.relation,
  SqlInfo.owner,
  SqlInfo.alias,
  SqlInfo.describe_end,
  SqlInfo.bind,
  SqlInfo.describe_vars,
  SqlInfo.sqlda_seq,
  SqlInfo.type,
  SqlInfo.sub_type,
  SqlInfo.scale,
  SqlInfo.length,
  SqlInfo.field,
  SqlInfo.relation,
  SqlInfo.owner,
  SqlInfo.alias,
  SqlInfo.describe_end,
]);

/** Parse the prepare-describe response buffer into a statement description. */
export function parseDescribe(buf: Buffer): StatementDescription {
  const r = new ClumpletReader(buf);
  const desc: StatementDescription = { stmtType: 0 as StmtType, inputs: [], outputs: [] };
  let vars: SqlVarDesc[] = desc.outputs;
  let current: SqlVarDesc | null = null;

  while (!r.done) {
    const item = r.nextItem();
    switch (item) {
      case SqlInfo.stmt_type:
        desc.stmtType = r.readInt() as StmtType;
        break;
      case SqlInfo.select:
        vars = desc.outputs;
        break;
      case SqlInfo.bind:
        vars = desc.inputs;
        break;
      case SqlInfo.describe_vars:
        r.readInt(); // declared count; we build from sqlda_seq entries
        break;
      case SqlInfo.describe_end:
        current = null;
        break;
      case SqlInfo.sqlda_seq: {
        const seq = r.readInt(); // 1-based
        current = { type: 0, nullable: false, subType: 0, scale: 0, length: 0 };
        vars[seq - 1] = current;
        break;
      }
      case SqlInfo.type: {
        const t = r.readInt();
        current!.type = t & ~1;
        current!.nullable = (t & 1) === 1;
        break;
      }
      case SqlInfo.sub_type:
        current!.subType = r.readInt();
        break;
      case SqlInfo.scale:
        current!.scale = r.readInt();
        break;
      case SqlInfo.length:
        current!.length = r.readInt();
        break;
      case SqlInfo.null_ind:
        current!.nullable = r.readInt() !== 0;
        break;
      case SqlInfo.field:
        current!.field = r.readString();
        break;
      case SqlInfo.relation:
        current!.relation = r.readString();
        break;
      case SqlInfo.owner:
        current!.owner = r.readString();
        break;
      case SqlInfo.alias:
        current!.alias = r.readString();
        break;
      case SqlInfo.truncated:
        throw new FirebirdProtocolError('Statement describe info truncated (too many columns)');
      default:
        // Unknown trailing item — stop parsing defensively.
        return desc;
    }
  }
  return desc;
}

// isc_info_req_* record counts (inf_pub.h)
const REQ_SELECT_COUNT = 13;
const REQ_INSERT_COUNT = 14;
const REQ_UPDATE_COUNT = 15;
const REQ_DELETE_COUNT = 16;

export interface RecordCounts {
  selected: number;
  inserted: number;
  updated: number;
  deleted: number;
}

/** Parse an isc_info_sql_records response (affected row counts). */
export function parseRecordCounts(buf: Buffer): RecordCounts {
  const counts: RecordCounts = { selected: 0, inserted: 0, updated: 0, deleted: 0 };
  const r = new ClumpletReader(buf);
  while (!r.done) {
    const item = r.nextItem();
    if (item !== SqlInfo.records) {
      r.skipCluster();
      continue;
    }
    const len = buf.readUInt16LE(r.pos);
    r.pos += 2;
    const end = r.pos + len;
    while (r.pos < end && buf[r.pos] !== SqlInfo.end) {
      const sub = r.nextItem();
      const v = r.readInt();
      if (sub === REQ_SELECT_COUNT) counts.selected = v;
      else if (sub === REQ_INSERT_COUNT) counts.inserted = v;
      else if (sub === REQ_UPDATE_COUNT) counts.updated = v;
      else if (sub === REQ_DELETE_COUNT) counts.deleted = v;
    }
    break;
  }
  return counts;
}
