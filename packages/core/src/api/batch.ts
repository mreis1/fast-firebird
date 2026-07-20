/**
 * executeBatch orchestration: many DML rows per round trip via the wire
 * batch API (op_batch_create/msg/exec). See plans/batch.md.
 *
 * Round-trip shape per sub-batch cycle: blob uploads first (the wire must be
 * clean for writeBlob's own reads), then create (first cycle only) +
 * regblobs + one op_batch_msg + op_batch_exec in a single flush; the
 * responses come back FIFO and are read explicitly, so a create/msg failure
 * surfaces as its real error rather than a misleading downstream one.
 */

import {
  buildBatchFormat,
  buildBatchPb,
  encodeBatchRow,
  readBatchCompletion,
  writeBatchCreate,
  writeBatchExec,
  writeBatchMsg,
  writeBatchRegblob,
  writeBatchRelease,
  type BatchCompletion,
  type BatchFormat,
} from '../protocol/batch.js';
import { BatchBlobPolicy, FreeStatement, StmtType } from '../protocol/constants.js';
import { freeStatement, type PreparedStatementInfo } from '../protocol/statement.js';
import { BlobRef, type ParamValue } from '../protocol/msgcodec.js';
import { finishStatement, prepareInfo, prepareParams, type SessionContext } from './session.js';
import { bindNamedParams, isNamedParams, rewriteNamedParams, FirebirdParamError, type NamedParams } from './named-params.js';
import { FirebirdError } from './errors.js';

/** One batch row: positional values, or an object for `@name` SQL. */
export type BatchRow = ParamValue[] | NamedParams;
export type BatchRows = Iterable<BatchRow> | AsyncIterable<BatchRow>;

export interface BatchOptions {
  /**
   * Keep executing after a row fails (server MULTIERROR). Failed rows are
   * reported in `BatchResult.errors` instead of throwing, and the successful
   * rows remain (committed by the own-transaction wrappers).
   */
  continueOnError?: boolean;
  /**
   * Max failed rows for which the server returns a full status vector
   * (default 64, server cap 256). Failures beyond it come back index-only
   * (`error: null`).
   */
  detailedErrors?: number;
  /**
   * Encoded row bytes per wire cycle (default 8 MiB). Each cycle is one
   * round trip and one server-side execute; the default stays well under the
   * server's 16 MiB batch buffer. Mostly a test/tuning knob.
   */
  chunkBytes?: number;
}

export interface BatchRowError {
  /** 0-based index of the failed row in the submitted sequence. */
  index: number;
  /** Server error, or null beyond the `detailedErrors` cap. */
  error: FirebirdError | null;
}

export interface BatchResult {
  /** Rows submitted to the server. */
  rowCount: number;
  /** Sum of the per-row affected-record counts. */
  rowsAffected: number;
  /**
   * Per processed row: affected records, -1 for a failed row, -2 for
   * succeeded-without-count. Without `continueOnError` the server stops at
   * the first failure, so this can be shorter than `rowCount`.
   */
  updateCounts: number[];
  /** Failed rows (empty when everything succeeded). */
  errors: BatchRowError[];
}

/** A batch row was rejected by the server (default, non-`continueOnError` mode). */
export class FirebirdBatchError extends FirebirdError {
  override name = 'FirebirdBatchError';

  constructor(
    message: string,
    /** 0-based index of the first failed row. */
    readonly index: number,
    /** Completion state up to the failure (nothing is committed by own-tx wrappers). */
    readonly result: BatchResult,
    cause?: FirebirdError,
  ) {
    super(message, cause?.gdsCode, cause?.sqlState, cause?.statusVector);
  }
}

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

function bindRow(row: BatchRow, names: string[], index: number): ParamValue[] {
  if (!isNamedParams(row)) return row;
  if (names.length === 0) {
    throw new FirebirdParamError(
      `batch row ${index}: a named-parameter object was passed but the SQL has no @name markers — use @name markers or positional arrays`,
    );
  }
  return bindNamedParams(names, row);
}

function batchable(t: StmtType): boolean {
  return t === StmtType.insert || t === StmtType.update || t === StmtType.delete || t === StmtType.exec_procedure;
}

/**
 * Run one SQL statement against many parameter rows. Must run under the
 * connection op-lock, inside a live transaction owned by the caller.
 */
export async function executeBatchStatement(
  ctx: SessionContext,
  txHandle: number,
  sql: string,
  rows: BatchRows,
  opts: BatchOptions = {},
): Promise<BatchResult> {
  if (ctx.wire.protocolVersion < 16) {
    throw new FirebirdError(
      `executeBatch requires Firebird 4+ (wire protocol 16); this server negotiated protocol ${ctx.wire.protocolVersion}. ` +
        'On Firebird 3, loop a prepared statement instead.',
    );
  }
  const { sql: wireSql, names } = rewriteNamedParams(sql);
  const cached = ctx.cache?.get(wireSql);
  const info = cached ?? (await prepareInfo(ctx, txHandle, wireSql));
  let ok = false;
  try {
    const result = await executeBatchPrepared(ctx, txHandle, info, rows, names, opts);
    ok = true;
    return result;
  } finally {
    if (ok) {
      finishStatement(ctx, wireSql, info);
    } else {
      ctx.cache?.remove(wireSql);
      if (!cached) freeStatement(ctx.wire, info.handle, FreeStatement.DSQL_drop);
    }
  }
}

/**
 * Batch-run an already prepared statement (PreparedStatement path). Must run
 * under the connection op-lock; the caller owns the statement lifecycle.
 */
export async function executeBatchPrepared(
  ctx: SessionContext,
  txHandle: number,
  info: PreparedStatementInfo,
  rows: BatchRows,
  names: string[],
  opts: BatchOptions = {},
): Promise<BatchResult> {
  if (ctx.wire.protocolVersion < 16) {
    throw new FirebirdError(
      `executeBatch requires Firebird 4+ (wire protocol 16); this server negotiated protocol ${ctx.wire.protocolVersion}. ` +
        'On Firebird 3, loop a prepared statement instead.',
    );
  }
  const desc = info.description;
  if (!batchable(desc.stmtType)) {
    throw new FirebirdError('executeBatch supports INSERT/UPDATE/DELETE/EXECUTE PROCEDURE statements');
  }
  if (desc.outputs.length > 0) {
    throw new FirebirdError('executeBatch does not support RETURNING — run those statements individually');
  }
  if (desc.inputs.length === 0) {
    throw new FirebirdError('executeBatch requires a statement with parameters');
  }
  return runBatch(ctx, txHandle, info, rows, names, opts);
}

async function runBatch(
  ctx: SessionContext,
  txHandle: number,
  info: PreparedStatementInfo,
  rows: BatchRows,
  names: string[],
  opts: BatchOptions,
): Promise<BatchResult> {
  const { wire } = ctx;
  const format = buildBatchFormat(info.description.inputs);
  const chunkBytes = Math.max(format.alignedStride, opts.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const pb = buildBatchPb({
    multiError: opts.continueOnError === true,
    recordCounts: true,
    blobPolicy: format.blobIndices.length > 0 ? BatchBlobPolicy.id_user : undefined,
    detailedErrors: opts.detailedErrors,
  });

  const combined: BatchResult = { rowCount: 0, rowsAffected: 0, updateCounts: [], errors: [] };
  let created = false;
  // Per-cycle state. The server clears its blob map on every execute, so the
  // regblob dedup is per cycle as well.
  let rowBufs: Buffer[] = [];
  let cycleBlobIds: Buffer[] = [];
  let seenBlobIds = new Set<string>();

  const execCycle = async (): Promise<void> => {
    let expected = 0;
    if (!created) {
      writeBatchCreate(wire, info.handle, format, pb);
      created = true;
      expected++;
    }
    for (const id of cycleBlobIds) {
      writeBatchRegblob(wire, info.handle, id);
      expected++;
    }
    writeBatchMsg(wire, info.handle, rowBufs);
    expected++;
    writeBatchExec(wire, info.handle, txHandle);
    wire.flush();

    let consumed = 0;
    let completion: BatchCompletion;
    try {
      for (; consumed < expected; consumed++) await wire.readResponse();
      completion = await readBatchCompletion(wire);
    } catch (err) {
      // A failed response was still fully consumed; everything after it —
      // including the exec reply — is still inbound. Mark those deferred so
      // the reader drains them and the connection stays in sync.
      const inbound = consumed < expected ? expected - consumed : 0;
      for (let i = 0; i < inbound; i++) wire.markDeferred();
      throw err;
    }

    const offset = combined.rowCount;
    combined.rowCount += rowBufs.length;
    for (const uc of completion.updateCounts) {
      combined.updateCounts.push(uc);
      if (uc > 0) combined.rowsAffected += uc;
    }
    for (const e of completion.errors) combined.errors.push({ index: offset + e.index, error: e.error });
    rowBufs = [];
    cycleBlobIds = [];
    seenBlobIds = new Set();

    if (opts.continueOnError !== true && combined.errors.length > 0) {
      const first = combined.errors[0]!;
      throw new FirebirdBatchError(
        `batch row ${first.index} failed: ${first.error?.message ?? 'unknown error'}`,
        first.index,
        combined,
        first.error ?? undefined,
      );
    }
  };

  try {
    let index = 0;
    // for await iterates sync iterables too — one loop covers both shapes.
    for await (const row of rows) {
      const values = bindRow(row, names, index);
      // prepareParams uploads blob values (its own round trips — the wire is
      // clean here: cycle ops are only written inside execCycle) and applies
      // the DECFLOAT/INT128 coercions, identically to the execute path.
      const { prepared, encodeText } = await prepareParams(ctx, txHandle, info, values);
      for (const bi of format.blobIndices) {
        const v = prepared[bi];
        if (v instanceof BlobRef) {
          const hex = v.id.toString('hex');
          if (!seenBlobIds.has(hex)) {
            seenBlobIds.add(hex);
            cycleBlobIds.push(v.id);
          }
        }
      }
      try {
        rowBufs.push(encodeBatchRow(format, prepared, encodeText));
      } catch (err) {
        throw err instanceof FirebirdError && !(err instanceof FirebirdBatchError)
          ? new FirebirdError(`batch row ${index}: ${err.message}`, err.gdsCode, err.sqlState, err.statusVector)
          : err;
      }
      index++;
      if (rowBufs.length * format.alignedStride >= chunkBytes) await execCycle();
    }
    if (rowBufs.length > 0) await execCycle();
    return combined;
  } finally {
    if (created) writeBatchRelease(wire, info.handle); // deferred, rides the next packet
  }
}
