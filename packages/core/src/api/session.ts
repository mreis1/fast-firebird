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
import { readBlobs, writeBlob } from '../protocol/blob.js';
import { BlobRef, DecFloatVal, makeColumnReader, type ParamValue } from '../protocol/msgcodec.js';
import { encodeDecFloat } from '../types/decfloat.js';
import { resolveTextCodec, type TextCodec, type TextCodecOptions } from '../charset/decoder.js';
import { StatementCache } from './statement-cache.js';
import { expandStarSql } from './expand-star.js';
import { BlobPrefetcher } from './blob-prefetch.js';
import { Blob, type BlobScope } from './blob.js';
import { FirebirdError } from './errors.js';
import type { SqlVarDesc } from '../protocol/info.js';
import type { WireConnection } from '../protocol/wire.js';
import { resolveReadAhead, type BlobMode, type BlobReadAheadOption, type BlobsOption, type ResolvedOptions, type ResolvedReadAhead } from './options.js';

export type Row = Record<string, unknown>;

/** One output column of a statement run, in row/position order. */
export interface ColumnInfo {
  /**
   * The key this column has in result rows: alias if the query set one, else
   * the field name (case per `lowercaseKeys`). In `rowMode:'array'` this is
   * the positional header for the same index.
   */
  name: string;
  /** Underlying field name from the server describe (aliases don't hide it). */
  field?: string;
  /** Source table/view; undefined for computed expressions. */
  relation?: string;
  /** Friendly SQL type name: VARCHAR, INTEGER, BLOB SUB_TYPE TEXT, … */
  type: string;
  nullable: boolean;
}

export interface QueryResult {
  rows: Row[];
  /** Affected-record counts for DML; zeros for plain selects. */
  rowsAffected: number;
  /**
   * Columns exactly as they appear in `rows`: every column positionally in
   * array mode, the kept ones (after `only`/`exclude`) in object mode.
   * Answers "what did `select *` actually return?".
   */
  columns: ColumnInfo[];
}

/** Per-statement options. */
export interface QueryOptions {
  /**
   * Blob handling override for this statement: 'eager' (default)
   * materializes; 'lazy' returns Blob handles; 'lazy-binary' / 'lazy-text'
   * lazify only that subtype; `{default?, eager?: [cols], lazy?: [cols]}`
   * names specific columns on top of a base mode.
   */
  blobs?: BlobsOption;
  /** Column names (alias/field, case-insensitive) to omit from rows. */
  exclude?: string[];
  /** If set, keep ONLY these columns (applied before `exclude`). */
  only?: string[];
  /**
   * Row shape: 'object' (default, keyed by column name) or 'array'
   * (positional, preserving duplicate/aliased columns). Array mode is intended
   * for ORM adapters; `exclude`/`only` are ignored. In array mode
   * `QueryResult.rows` holds `unknown[]` per row.
   */
  rowMode?: 'object' | 'array';
  /**
   * Lazy-blob read-ahead for `queryStream` (see `BlobReadAheadOption`).
   * Overrides the connection-level default; `false` disables it.
   */
  blobReadAhead?: BlobReadAheadOption;
  /**
   * Rewrite top-level `*` / `alias.*` / `table.*` into an explicit column
   * list (minus `exclude`, filtered by `only`) BEFORE preparing — excluded
   * columns are then genuinely never sent by the server, scalars included
   * (decode-time exclude only saves blob reads). Costs one extra prepare per
   * unique (sql, only, exclude); cached, invalidated by DDL. Emitted column
   * names are double-quoted (dialect 3). Top-level UNION is not supported.
   */
  expandStar?: boolean;
}

/** A network-op serializer (Attachment.withLock). */
export type OpLock = <T>(fn: () => Promise<T>) => Promise<T>;

/** Everything a statement run needs from its attachment. */
export interface SessionContext {
  wire: WireConnection;
  dbHandle: number;
  opts: ResolvedOptions;
  cache: StatementCache | null;
  /** Connection op-lock; used to build deferred lazy-blob scopes. */
  lock: OpLock;
  /** expandStar rewrite cache: (sql, only, exclude) → rewritten SQL. */
  starCache?: Map<string, string>;
}

/** Per-run context: user query options + transaction liveness for lazy blobs. */
export interface RunContext {
  query: QueryOptions;
  /** True while the owning transaction is open (for lazy blob validity). */
  txAlive: () => boolean;
}

const EMPTY_RUN: RunContext = { query: {}, txAlive: () => true };

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

function isBlobType(t: number): boolean {
  return t === SqlType.BLOB;
}

const SQL_TYPE_NAMES: Record<number, string> = {
  [SqlType.TEXT]: 'CHAR',
  [SqlType.VARYING]: 'VARCHAR',
  [SqlType.SHORT]: 'SMALLINT',
  [SqlType.LONG]: 'INTEGER',
  [SqlType.FLOAT]: 'FLOAT',
  [SqlType.DOUBLE]: 'DOUBLE PRECISION',
  [SqlType.D_FLOAT]: 'DOUBLE PRECISION',
  [SqlType.TIMESTAMP]: 'TIMESTAMP',
  [SqlType.BLOB]: 'BLOB',
  [SqlType.ARRAY]: 'ARRAY',
  [SqlType.QUAD]: 'QUAD',
  [SqlType.TYPE_TIME]: 'TIME',
  [SqlType.TYPE_DATE]: 'DATE',
  [SqlType.INT64]: 'BIGINT',
  [SqlType.INT128]: 'INT128',
  [SqlType.TIMESTAMP_TZ]: 'TIMESTAMP WITH TIME ZONE',
  [SqlType.TIMESTAMP_TZ_EX]: 'TIMESTAMP WITH TIME ZONE',
  [SqlType.TIME_TZ]: 'TIME WITH TIME ZONE',
  [SqlType.TIME_TZ_EX]: 'TIME WITH TIME ZONE',
  [SqlType.DEC16]: 'DECFLOAT(16)',
  [SqlType.DEC34]: 'DECFLOAT(34)',
  [SqlType.BOOLEAN]: 'BOOLEAN',
  [SqlType.NULL]: 'NULL',
};

/** Friendly SQL type name for a described column. */
function sqlTypeName(d: SqlVarDesc): string {
  // Scaled integers are NUMERIC/DECIMAL on the wire (subType 2 = DECIMAL).
  if (d.scale < 0 && (d.type === SqlType.SHORT || d.type === SqlType.LONG || d.type === SqlType.INT64 || d.type === SqlType.INT128)) {
    return d.subType === 2 ? 'DECIMAL' : 'NUMERIC';
  }
  if (d.type === SqlType.BLOB && d.subType === 1) return 'BLOB SUB_TYPE TEXT';
  return SQL_TYPE_NAMES[d.type] ?? `SQL_TYPE_${d.type}`;
}

/**
 * Maps raw row-arrays (with BlobRef cells) to shaped result objects, applying
 * `exclude`/`only` and eager/lazy blob handling. Built once per statement run.
 */
class RowMapper {
  private readonly keys: (string | null)[]; // null = column dropped
  /** Per column: true when a blob column is returned as a lazy handle. */
  private readonly lazyCol: boolean[];
  private readonly arrayMode: boolean;
  private readonly scope: BlobScope | null;
  /** Per column: text codec for a subtype-1 (text) blob, else null. */
  private readonly blobCodec: (TextCodec | null)[];
  readonly hasKeptEagerBlobs: boolean;
  /** Kept output columns, in the order they appear in shaped rows. */
  readonly columns: ColumnInfo[];

  constructor(
    private readonly ctx: SessionContext,
    private readonly txHandle: number,
    outputs: SqlVarDesc[],
    run: RunContext,
  ) {
    const lc = ctx.opts.lowercaseKeys;
    const only = run.query.only?.map((s) => s.toLowerCase());
    const exclude = new Set(run.query.exclude?.map((s) => s.toLowerCase()) ?? []);
    const blobsOpt: BlobsOption = run.query.blobs ?? ctx.opts.blobs;
    const mode: BlobMode = typeof blobsOpt === 'string' ? blobsOpt : (blobsOpt.default ?? 'eager');
    const forceEager = new Set(typeof blobsOpt === 'string' ? [] : (blobsOpt.eager ?? []).map((s) => s.toLowerCase()));
    const forceLazy = new Set(typeof blobsOpt === 'string' ? [] : (blobsOpt.lazy ?? []).map((s) => s.toLowerCase()));
    for (const c of forceEager) {
      if (forceLazy.has(c)) throw new FirebirdError(`blobs: column '${c}' is listed as both eager and lazy`);
    }
    // Subtype 1 = text (memo); everything else counts as binary.
    const lazyFor = (subType: number): boolean =>
      mode === 'lazy' || (mode === 'lazy-binary' && subType !== 1) || (mode === 'lazy-text' && subType === 1);
    this.arrayMode = run.query.rowMode === 'array';
    this.blobCodec = [];
    this.lazyCol = [];
    let keptEagerBlobs = false;
    let keptLazyBlobs = false;

    this.keys = outputs.map((d, i) => {
      const rawName = d.alias || d.field || `F${i + 1}`;
      const lower = rawName.toLowerCase();
      // Entries may be bare (`col`) or qualified by FROM alias (`t2.col`).
      const qual = d.relationAlias ? `${d.relationAlias.toLowerCase()}.${lower}` : null;
      const listed = (list: string[]) => list.includes(lower) || (qual !== null && list.includes(qual));
      const excluded = exclude.has(lower) || (qual !== null && exclude.has(qual));
      // Array mode keeps every column positionally (exclude/only ignored).
      const kept = this.arrayMode || ((!only || listed(only)) && !excluded);
      const isBlob = isBlobType(d.type);
      this.blobCodec[i] = isBlob && d.subType === 1 ? codecForDesc(d, ctx.opts, 'blob') : null;
      // Named overrides (bare or ALIAS.COL) beat the base mode.
      const named = (set: Set<string>) => set.has(lower) || (qual !== null && set.has(qual));
      this.lazyCol[i] = isBlob && (named(forceLazy) ? true : named(forceEager) ? false : lazyFor(d.subType));
      if (kept && isBlob) {
        if (this.lazyCol[i]) keptLazyBlobs = true;
        else keptEagerBlobs = true;
      }
      return kept ? (lc ? lower : rawName) : null;
    });
    this.hasKeptEagerBlobs = keptEagerBlobs;

    this.columns = [];
    for (let i = 0; i < outputs.length; i++) {
      const key = this.keys[i];
      if (key == null) continue;
      const d = outputs[i]!;
      this.columns.push({ name: key, field: d.field, relation: d.relation, type: sqlTypeName(d), nullable: d.nullable });
    }

    this.scope = keptLazyBlobs
      ? {
          wire: ctx.wire,
          lock: ctx.lock,
          txHandle,
          chunkSize: ctx.opts.blobReadChunkSize,
          isAlive: run.txAlive,
        }
      : null;
  }

  /**
   * Eagerly materialize the kept eager blob cells of a whole batch (call
   * while holding the op-lock). All blobs go through `readBlobs`, which
   * overlaps open/read/close across blobs — no idle RTTs between them.
   */
  async materialize(rows: unknown[][]): Promise<void> {
    if (!this.hasKeptEagerBlobs) return;
    const cells: { row: unknown[]; i: number; ref: BlobRef }[] = [];
    for (const row of rows) {
      for (let i = 0; i < row.length; i++) {
        if (this.keys[i] === null || this.lazyCol[i]) continue; // dropped/lazy → not now
        const cell = row[i];
        if (cell instanceof BlobRef) cells.push({ row, i, ref: cell });
      }
    }
    if (cells.length === 0) return;
    const datas = await readBlobs(this.ctx.wire, this.txHandle, cells.map((c) => c.ref.id), this.ctx.opts.blobReadChunkSize);
    for (let k = 0; k < cells.length; k++) {
      const { row, i, ref } = cells[k]!;
      row[i] = ref.subType === 1 && this.blobCodec[i] ? this.blobCodec[i]!.decode(datas[k]!) : datas[k]!;
    }
  }

  /** Kept lazy blob column indices, optionally filtered by (lowercased) names. */
  prefetchableColumns(filter: string[] | null): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[i];
      if (key == null || !this.lazyCol[i]) continue;
      if (filter && !filter.includes(key.toLowerCase())) continue;
      out.push(i);
    }
    return out;
  }

  /** Attach a read-ahead store so lazy Blob handles can serve from it. */
  setPrefetch(p: NonNullable<BlobScope['prefetch']>): void {
    if (this.scope) this.scope.prefetch = p;
  }

  /** Build the result row: an object (default) or a positional array. */
  shape(row: unknown[]): Row {
    const wrap = (cell: unknown, i: number): unknown =>
      cell instanceof BlobRef ? new Blob(cell.id, cell.subType, this.scope!, this.blobCodec[i] ?? null) : cell;
    if (this.arrayMode) {
      // Positional array in column order (cast: callers opting into rowMode
      // 'array' treat QueryResult.rows as unknown[][]).
      return row.map(wrap) as unknown as Row;
    }
    const obj: Row = {};
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[i];
      if (key == null) continue;
      obj[key] = wrap(row[i], i);
    }
    return obj;
  }
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
  run: RunContext = EMPTY_RUN,
): Promise<QueryResult> {
  const { wire, opts } = ctx;
  const mapper = new RowMapper(ctx, txHandle, info.description.outputs, run);
  const { prepared, encodeText } = await prepareParams(ctx, txHandle, info, params);

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

  // 3. Only now is it safe to issue new requests: eagerly materialize the
  //    kept blob cells (lazy columns keep BlobRefs for the mapper to wrap).
  await mapper.materialize(rows);

  // 4. Close the cursor (deferred — rides with the next packet) so the
  //    statement handle can be re-executed later.
  if (closeCursorAfter && isSelect) {
    freeStatement(wire, info.handle, FreeStatement.DSQL_close);
  }

  return { rows: rows.map((r) => mapper.shape(r)), rowsAffected, columns: mapper.columns };
}

/** Validate arity, upload blob params, and build the text encoder. */
async function prepareParams(
  ctx: SessionContext,
  txHandle: number,
  info: PreparedStatementInfo,
  params: ParamValue[],
): Promise<{ prepared: ParamValue[]; encodeText: (i: number, v: string) => Buffer }> {
  const { wire, opts } = ctx;
  const inputs = info.description.inputs;
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
    } else if (v != null && (d.type === SqlType.DEC16 || d.type === SqlType.DEC34) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint')) {
      // Native DECFLOAT encoding: a JS number would otherwise be sent as a
      // binary double (lossy — '0.1' would pick up binary-rounding noise).
      prepared[i] = new DecFloatVal(encodeDecFloat(String(v), d.type === SqlType.DEC16 ? 8 : 16));
    } else if (v != null && d.type === SqlType.INT128 && typeof v === 'string' && /^[+-]?\d+$/.test(v)) {
      // Integer string bound to INT128 → bigint (native 128-bit wire encoding).
      prepared[i] = BigInt(v);
    } else {
      prepared[i] = v;
      // A text codec only applies to genuine text columns: for those, `subType`
      // is a charset id. For non-text targets (NUMERIC, INT, …) `subType` is
      // the numeric/other subtype — misreading it as a charset can pick OCTETS
      // (which rejects strings). Send such string params as plain UTF-8 bytes
      // and let Firebird coerce them to the column type (e.g. '12.5' → NUMERIC).
      if (typeof v === 'string' && isTextType(d.type)) paramCodecs.set(i, codecForDesc(d, opts, 'text'));
    }
  }
  const encodeText = (i: number, value: string): Buffer => {
    const codec = paramCodecs.get(i);
    return codec ? codec.encode(value) : Buffer.from(value, 'utf8');
  };
  return { prepared, encodeText };
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
/**
 * Resolve the SQL to actually execute: with `expandStar`, prepare the
 * original once (describe tells us what each `*` produces), rewrite the star
 * items, and cache the rewrite. Must run under the connection op-lock.
 */
async function resolveExpandStar(ctx: SessionContext, txHandle: number, sql: string, run: RunContext): Promise<string> {
  if (!run.query.expandStar) return sql;
  const key = `${sql} ${(run.query.only ?? []).join(',').toLowerCase()} ${(run.query.exclude ?? []).join(',').toLowerCase()}`;
  const hit = ctx.starCache?.get(key);
  if (hit !== undefined) return hit;

  // The original statement's describe drives the expansion. Reuse a cached
  // prepare when available; otherwise prepare and hand the handle to the
  // statement cache (or drop it deferred) — nothing is wasted.
  let info = ctx.cache?.get(sql);
  const fresh = !info;
  if (!info) info = await prepareInfo(ctx, txHandle, sql);
  const rewritten = expandStarSql(sql, info.description.outputs, run.query) ?? sql;
  if (fresh) finishStatement(ctx, sql, info);

  (ctx.starCache ??= new Map()).set(key, rewritten);
  return rewritten;
}

export async function runStatement(
  ctx: SessionContext,
  txHandle: number,
  sql: string,
  params: ParamValue[],
  run: RunContext = EMPTY_RUN,
): Promise<QueryResult> {
  sql = await resolveExpandStar(ctx, txHandle, sql, run);
  const cached = ctx.cache?.get(sql);
  if (cached) {
    try {
      const result = await executePrepared(ctx, txHandle, cached, params, true, run);
      finishStatement(ctx, sql, cached);
      return result;
    } catch (err) {
      if (!isStaleStatementError(err)) throw err;
      ctx.cache!.remove(sql); // stale — fall through to a fresh prepare
    }
  }

  const info = await prepareInfo(ctx, txHandle, sql);
  try {
    const result = await executePrepared(ctx, txHandle, info, params, true, run);
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
    // Schema may have changed under every cached statement and star rewrite.
    ctx.cache?.clear();
    ctx.starCache?.clear();
  }
  if (ctx.cache && ctx.cache.capacity > 0 && StatementCache.isCacheable(stmtType)) {
    ctx.cache.put(sql, info);
  } else {
    freeStatement(ctx.wire, info.handle, FreeStatement.DSQL_drop);
  }
}

/**
 * Stream rows lazily: each batch is fetched (and, in eager mode, its blobs
 * materialized) under `lock`, then yielded row by row. The NEXT op_fetch only
 * fires when the consumer drains the current batch — natural backpressure at
 * batch granularity. The statement/cursor is closed and cached (or dropped)
 * when iteration ends, breaks early, or throws.
 */
export async function* streamRows(
  ctx: SessionContext,
  txHandle: number,
  sql: string,
  params: ParamValue[],
  lock: OpLock,
  run: RunContext = EMPTY_RUN,
): AsyncGenerator<Row> {
  if (run.query.expandStar) sql = await lock(() => resolveExpandStar(ctx, txHandle, sql, run));
  const cached = ctx.cache?.get(sql);
  let info: PreparedStatementInfo | null = cached ?? null;
  let mapper: RowMapper | null = null;
  let cursorOpen = false;
  let failed = false;
  // Lazy-blob read-ahead (query option overrides the connection default).
  const raCfg: ResolvedReadAhead | null =
    run.query.blobReadAhead !== undefined ? resolveReadAhead(run.query.blobReadAhead) : ctx.opts.blobReadAhead;
  let prefetcher: BlobPrefetcher | null = null;
  let prefetchCols: number[] = [];
  let registeredRows = 0;
  let rowIdx = 0;
  /** Register a batch's lazy blob ids with the prefetcher (raw rows keep BlobRefs). */
  const register = (rows: unknown[][]): void => {
    if (!prefetcher) return;
    for (const r of rows) {
      const ids: Buffer[] = [];
      for (const i of prefetchCols) {
        const c = r[i];
        if (c instanceof BlobRef) ids.push(c.id);
      }
      if (ids.length > 0) prefetcher.addRow(registeredRows, ids);
      registeredRows++;
    }
  };
  try {
    const first = await lock(async () => {
      if (!info) info = await prepareInfo(ctx, txHandle, sql);
      mapper = new RowMapper(ctx, txHandle, info.description.outputs, run);
      const { prepared, encodeText } = await prepareParams(ctx, txHandle, info, params);
      const isSelect = isSelectType(info.description.stmtType);
      const fc = isSelect ? nextFetchCount(info.rowWidth, ctx.opts.fetchSize, 0) : 0;
      const exec = await executeStatement(ctx.wire, info, txHandle, prepared, encodeText, {
        fetchSize: isSelect ? fc : undefined,
        recordCounts: false,
      });
      let batch;
      if (exec.pendingFetch) {
        cursorOpen = true;
        batch = await readFetchBatch(ctx.wire, info);
      } else {
        batch = { rows: exec.procRow ? [exec.procRow] : [], eof: true };
      }
      await mapper.materialize(batch.rows);
      return { batch, fc };
    });

    // Attach read-ahead before any row is shaped (raw rows still hold BlobRefs).
    if (raCfg) {
      prefetchCols = mapper!.prefetchableColumns(raCfg.columns);
      if (prefetchCols.length > 0) {
        prefetcher = new BlobPrefetcher(lock, ctx.wire, txHandle, ctx.opts.blobReadChunkSize, raCfg);
        mapper!.setPrefetch(prefetcher);
      }
    }

    register(first.batch.rows);
    for (const r of first.batch.rows) {
      prefetcher?.advance(rowIdx);
      yield mapper!.shape(r);
      rowIdx++;
    }

    let eof = first.batch.eof;
    let fc = first.fc;
    while (!eof) {
      const b = await lock(async () => {
        fc = nextFetchCount(info!.rowWidth, ctx.opts.fetchSize, fc);
        const batch = await fetchRows(ctx.wire, info!, fc);
        await mapper!.materialize(batch.rows);
        return batch;
      });
      register(b.rows);
      for (const r of b.rows) {
        prefetcher?.advance(rowIdx);
        yield mapper!.shape(r);
        rowIdx++;
      }
      eof = b.eof;
    }
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    prefetcher?.close();
    await lock(async () => {
      if (!info) return;
      if (cursorOpen) freeStatement(ctx.wire, info.handle, FreeStatement.DSQL_close);
      if (failed) {
        ctx.cache?.remove(sql);
        if (!cached) freeStatement(ctx.wire, info.handle, FreeStatement.DSQL_drop);
      } else {
        finishStatement(ctx, sql, info);
      }
    });
  }
}
