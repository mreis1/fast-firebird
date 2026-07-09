import { FreeStatement, SqlType, StmtType } from '../protocol/constants.js';
import {
  allocateAndPrepare,
  executeStatement,
  fetchRows,
  freeStatement,
  readFetchBatch,
  readRecordCounts,
  type PreparedStatementInfo,
} from '../protocol/statement.js';
import { nextFetchCount } from '../protocol/fetch-plan.js';
import { readBlob, writeBlob } from '../protocol/blob.js';
import { BlobRef, makeColumnReader, type ParamValue } from '../protocol/msgcodec.js';
import { resolveTextCodec, type TextCodec, type TextCodecOptions } from '../charset/decoder.js';
import { StatementCache } from './statement-cache.js';
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

/** Everything a statement run needs from its attachment. */
export interface SessionContext {
  wire: WireConnection;
  dbHandle: number;
  opts: ResolvedOptions;
  cache: StatementCache | null;
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

function isSelectType(t: StmtType): boolean {
  return t === StmtType.select || t === StmtType.select_for_upd;
}

function wantsRecordCounts(t: StmtType): boolean {
  return t === StmtType.insert || t === StmtType.update || t === StmtType.delete || t === StmtType.exec_procedure;
}

/** Prepare a statement and attach its per-column text codecs. */
export async function prepareInfo(ctx: SessionContext, txHandle: number, sql: string): Promise<PreparedStatementInfo> {
  const info = await allocateAndPrepare(ctx.wire, ctx.dbHandle, txHandle, sql);
  const outputs = info.description.outputs;
  for (let i = 0; i < outputs.length; i++) {
    const d = outputs[i]!;
    if (isTextType(d.type)) {
      info.columnReaders[i] = makeColumnReader(d, codecForDesc(d, ctx.opts, 'text'), 'auto');
    }
  }
  return info;
}

/**
 * Execute a prepared statement: blob-parameter upload, execute with
 * piggybacked first-fetch (selects) or record-counts (DML) in ONE flush,
 * remaining fetch batches, blob materialization, optional cursor close.
 *
 * Response-order invariant: piggybacked responses (fetch stream, info) are
 * fully consumed BEFORE any new request (blob reads) is issued.
 */
export async function executePrepared(
  ctx: SessionContext,
  txHandle: number,
  info: PreparedStatementInfo,
  params: ParamValue[],
  closeCursorAfter: boolean,
): Promise<QueryResult> {
  const { wire, opts } = ctx;
  const inputs = info.description.inputs;
  const outputs = info.description.outputs;
  if (params.length !== inputs.length) {
    throw new FirebirdError(`Statement expects ${inputs.length} parameter(s), got ${params.length}`);
  }

  // Upload blob params first (described type BLOB + string/Buffer value).
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
    return codec ? codec.encode(value) : Buffer.from(value, 'utf8');
  };

  const stmtType = info.description.stmtType;
  const isSelect = isSelectType(stmtType);
  // Adaptive fetch: the piggybacked first batch starts modest, later batches
  // ramp toward the byte budget (see fetch-plan.ts).
  let fetchCount = isSelect ? nextFetchCount(info.rowWidth, opts.fetchSize, 0) : 0;
  const exec = await executeStatement(wire, info, txHandle, prepared, encodeText, {
    fetchSize: isSelect ? fetchCount : undefined,
    recordCounts: wantsRecordCounts(stmtType),
  });

  // 1. Drain the piggybacked fetch stream (and any follow-up batches).
  const rows: unknown[][] = [];
  if (exec.pendingFetch) {
    let batch = await readFetchBatch(wire, info);
    rows.push(...batch.rows);
    while (!batch.eof) {
      fetchCount = nextFetchCount(info.rowWidth, opts.fetchSize, fetchCount);
      batch = await fetchRows(wire, info, fetchCount);
      rows.push(...batch.rows);
    }
  } else if (exec.procRow) {
    rows.push(exec.procRow);
  }

  // 2. Drain the piggybacked info response.
  let rowsAffected = 0;
  if (exec.pendingInfo) {
    const counts = await readRecordCounts(wire);
    rowsAffected = counts.inserted + counts.updated + counts.deleted;
  }

  // 3. Only now is it safe to issue new requests: materialize blob cells.
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      if (cell instanceof BlobRef) {
        const data = await readBlob(wire, txHandle, cell.id, opts.blobReadChunkSize);
        row[i] = cell.subType === 1 ? codecForDesc(outputs[i]!, opts, 'blob').decode(data) : data;
      }
    }
  }

  // 4. Close the cursor (deferred — rides with the next packet) so the
  //    statement handle can be re-executed later.
  if (closeCursorAfter && isSelect) {
    freeStatement(wire, info.handle, FreeStatement.DSQL_close);
  }

  return { rows: shapeRows(rows, outputs, opts.lowercaseKeys), rowsAffected };
}

/**
 * gds codes indicating the cached statement handle is stale (e.g. the table
 * was recreated by another attachment) and a re-prepare should be attempted.
 */
const STALE_STATEMENT_GDS = new Set([
  335544343, // invalid request BLR / format mismatch
  335544485, // invalid statement handle
]);

function isStaleStatementError(err: unknown): boolean {
  return err instanceof FirebirdError && err.gdsCode !== undefined && STALE_STATEMENT_GDS.has(err.gdsCode);
}

/**
 * Run one SQL statement, using the attachment statement cache when possible.
 * Cache hits cost a single round trip for small selects and DML.
 */
export async function runStatement(
  ctx: SessionContext,
  txHandle: number,
  sql: string,
  params: ParamValue[],
): Promise<QueryResult> {
  const cached = ctx.cache?.get(sql);
  if (cached) {
    try {
      const result = await executePrepared(ctx, txHandle, cached, params, true);
      finishStatement(ctx, sql, cached);
      return result;
    } catch (err) {
      if (!isStaleStatementError(err)) throw err;
      ctx.cache!.remove(sql); // stale — fall through to a fresh prepare
    }
  }

  const info = await prepareInfo(ctx, txHandle, sql);
  try {
    const result = await executePrepared(ctx, txHandle, info, params, true);
    finishStatement(ctx, sql, info);
    return result;
  } catch (err) {
    freeStatement(ctx.wire, info.handle, FreeStatement.DSQL_drop);
    throw err;
  }
}

/** Post-success statement lifecycle: cache it, or drop it lazily. */
function finishStatement(ctx: SessionContext, sql: string, info: PreparedStatementInfo): void {
  const stmtType = info.description.stmtType;
  if (stmtType === StmtType.ddl) {
    // Schema may have changed under every cached statement.
    ctx.cache?.clear();
  }
  if (ctx.cache && ctx.cache.capacity > 0 && StatementCache.isCacheable(stmtType)) {
    ctx.cache.put(sql, info);
  } else {
    freeStatement(ctx.wire, info.handle, FreeStatement.DSQL_drop);
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
