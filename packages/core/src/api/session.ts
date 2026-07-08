import { FreeStatement, SqlType, StmtType } from '../protocol/constants.js';
import { allocateAndPrepare, executeStatement, fetchAffectedRows, fetchRows, freeStatement } from '../protocol/statement.js';
import { readBlob, writeBlob } from '../protocol/blob.js';
import { BlobRef, makeColumnReader, type ParamValue } from '../protocol/msgcodec.js';
import { resolveTextCodec, type TextCodec, type TextCodecOptions } from '../charset/decoder.js';
import { FirebirdError } from './errors.js';
import type { SqlVarDesc } from '../protocol/info.js';
import type { WireConnection } from '../protocol/wire.js';
import type { ResolvedOptions } from './options.js';

export type Row = Record<string, unknown>;

export interface QueryResult {
  rows: Row[];
  /** Affected-record counts for DML; zeros for plain selects. */
  rowsAffected: number;
}

function textCodecOptions(opts: ResolvedOptions): TextCodecOptions {
  return {
    connectionCharset: opts.charset,
    charsetNoneEncoding: opts.charsetNoneEncoding,
    transcodeAdapter: opts.transcodeAdapter,
    charsetOverrides: opts.charsetOverrides,
  };
}

function codecForDesc(desc: SqlVarDesc, opts: ResolvedOptions, sqlTypeName: string): TextCodec {
  const isBlob = desc.type === SqlType.BLOB;
  return resolveTextCodec(
    {
      // For text types the charset id lives in subType & 0xFF;
      // for blobs, subType is the blob subtype and scale holds the charset id.
      charsetId: isBlob ? desc.scale & 0xff : desc.subType & 0xff,
      fieldName: desc.field,
      relationName: desc.relation,
      sqlType: sqlTypeName,
      blobSubtype: isBlob ? desc.subType : undefined,
    },
    textCodecOptions(opts),
  );
}

function isTextType(t: number): boolean {
  return t === SqlType.TEXT || t === SqlType.VARYING || t === SqlType.NULL;
}

/**
 * Runs one SQL statement on an open transaction: pipelined
 * allocate+prepare, blob-parameter upload, execute, batched fetch, blob
 * materialization, affected counts, deferred statement drop.
 */
export async function runStatement(
  wire: WireConnection,
  dbHandle: number,
  txHandle: number,
  sql: string,
  params: ParamValue[],
  opts: ResolvedOptions,
): Promise<QueryResult> {
  const stmt = await allocateAndPrepare(wire, dbHandle, txHandle, sql);
  // Attach text codecs now that column metadata is known.
  const stmtOutputs = stmt.description.outputs;
  for (let i = 0; i < stmtOutputs.length; i++) {
    const d = stmtOutputs[i]!;
    if (isTextType(d.type)) {
      stmt.columnReaders[i] = makeColumnReader(d, codecForDesc(d, opts, 'text'), 'auto');
    }
  }

  try {
    // Upload blob params first (described type BLOB + string/Buffer value).
    const inputs = stmt.description.inputs;
    if (params.length !== inputs.length) {
      throw new FirebirdError(`Statement expects ${inputs.length} parameter(s), got ${params.length}`);
    }
    const prepared: ParamValue[] = new Array(params.length);
    const paramCodecs = new Map<number, TextCodec>();
    for (let i = 0; i < params.length; i++) {
      const v = params[i];
      const d = inputs[i]!;
      if (v != null && d.type === SqlType.BLOB && (typeof v === 'string' || Buffer.isBuffer(v))) {
        const bytes = typeof v === 'string' ? codecForDesc(d, opts, 'blob').encode(v) : v;
        const id = await writeBlob(wire, txHandle, bytes, opts.blobWriteChunkSize);
        prepared[i] = new BlobRef(id, d.subType);
      } else {
        prepared[i] = v;
        if (typeof v === 'string') paramCodecs.set(i, codecForDesc(d, opts, 'text'));
      }
    }

    const encodeText = (i: number, value: string): Buffer => {
      const codec = paramCodecs.get(i);
      const out = codec ? codec.encode(value) : Buffer.from(value, 'utf8');
      return out;
    };

    const exec = await executeStatement(wire, stmt, txHandle, prepared, encodeText);

    const rows: unknown[][] = [];
    const isSelect =
      stmt.description.stmtType === StmtType.select || stmt.description.stmtType === StmtType.select_for_upd;
    if (isSelect) {
      for (;;) {
        const batch = await fetchRows(wire, stmt, opts.fetchSize);
        rows.push(...batch.rows);
        if (batch.eof) break;
      }
    } else if (exec.procRow) {
      rows.push(exec.procRow);
    }

    // Materialize blob cells (after the fetch stream is fully consumed).
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        const cell = row[i];
        if (cell instanceof BlobRef) {
          const data = await readBlob(wire, txHandle, cell.id, opts.blobReadChunkSize);
          if (cell.subType === 1) {
            const d = stmtOutputs[i]!;
            row[i] = codecForDesc(d, opts, 'blob').decode(data);
          } else {
            row[i] = data;
          }
        }
      }
    }

    let rowsAffected = 0;
    const st = stmt.description.stmtType;
    if (st === StmtType.insert || st === StmtType.update || st === StmtType.delete || st === StmtType.exec_procedure) {
      const counts = await fetchAffectedRows(wire, stmt.handle);
      rowsAffected = counts.inserted + counts.updated + counts.deleted;
    }

    return { rows: shapeRows(rows, stmtOutputs, opts.lowercaseKeys), rowsAffected };
  } finally {
    freeStatement(wire, stmt.handle, FreeStatement.DSQL_drop);
  }
}

function shapeRows(rows: unknown[][], descs: SqlVarDesc[], lowercaseKeys: boolean): Row[] {
  const keys = descs.map((d, i) => {
    let k = d.alias || d.field || `F${i + 1}`;
    if (lowercaseKeys) k = k.toLowerCase();
    return k;
  });
  return rows.map((r) => {
    const obj: Row = {};
    for (let i = 0; i < keys.length; i++) obj[keys[i]!] = r[i];
    return obj;
  });
}
