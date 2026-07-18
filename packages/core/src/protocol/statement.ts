import { DEFAULT_FETCH_SIZE, FreeStatement, Op, SqlInfo, StmtType } from './constants.js';
import { DESCRIBE_INFO_ITEMS, parseDescribe, parseRecordCounts, type RecordCounts, type StatementDescription } from './info.js';
import { buildOutputBlr, encodeParams, makeColumnReader, readRow, type ColumnReader, type ParamValue } from './msgcodec.js';
import { estimateRowWidth } from './fetch-plan.js';
import { XdrWriter } from './xdr.js';
import { FirebirdProtocolError } from '../api/errors.js';
import type { WireConnection } from './wire.js';

const SQL_DIALECT_CURRENT = 3;
const STATEMENT_HANDLE_PLACEHOLDER = 0xffff;

export interface PreparedStatementInfo {
  handle: number;
  description: StatementDescription;
  outputBlr: Buffer;
  columnReaders: ColumnReader[];
  /** Estimated wire bytes per output row (drives adaptive fetch sizing). */
  rowWidth: number;
}

/**
 * Allocate + prepare pipelined in ONE round trip (lazy-send):
 * op_allocate_statement and op_prepare_statement (with handle placeholder)
 * go out in a single flush; both responses are read FIFO.
 */
export async function allocateAndPrepare(
  wire: WireConnection,
  dbHandle: number,
  txHandle: number,
  sql: string,
  int64As: 'auto' | 'bigint' | 'number' = 'auto',
  tzMode: 'instant' | 'zoned' = 'instant',
): Promise<PreparedStatementInfo> {
  wire.writer.int32(Op.allocate_statement).int32(dbHandle);
  wire.writer
    .int32(Op.prepare_statement)
    .int32(txHandle)
    .int32(STATEMENT_HANDLE_PLACEHOLDER)
    .int32(SQL_DIALECT_CURRENT)
    .string(sql)
    .opaque(DESCRIBE_INFO_ITEMS)
    .int32(65535);
  // Protocol 20 (FB6): trailing p_sqlst_flags (xdr short = 4 bytes on the
  // wire). Mandatory — a v20 server blocks reading the prepare without it.
  if (wire.protocolVersion >= 20) wire.writer.int32(0);
  wire.flush();

  const allocResp = await wire.readResponse(); // op_allocate_statement
  const handle = allocResp.handle;
  const prepResp = await wire.readResponse(); // op_prepare_statement
  const description = parseDescribe(prepResp.data);

  // Text codecs are attached by the caller once column metadata is known.
  const columnReaders = description.outputs.map((d) => makeColumnReader(d, null, int64As, tzMode));
  const outputBlr = description.outputs.length > 0 ? buildOutputBlr(description.outputs) : Buffer.alloc(0);
  const rowWidth = estimateRowWidth(description.outputs);
  return { handle, description, outputBlr, columnReaders, rowWidth };
}

/** Statement types whose results come back via op_execute2 (singleton row). */
export function usesExecute2(desc: StatementDescription): boolean {
  if (desc.outputs.length === 0) return false;
  const t = desc.stmtType;
  // EXECUTE PROCEDURE and DML with RETURNING are singletons; selects fetch.
  return t === StmtType.exec_procedure || t === StmtType.insert || t === StmtType.update || t === StmtType.delete;
}

export interface ExecutePiggyback {
  /** Also request the first fetch batch in the same flush (open cursors only). */
  fetchSize?: number;
  /** Also request record counts (op_info_sql) in the same flush. */
  recordCounts?: boolean;
}

export interface ExecuteResult {
  /** Single row returned by op_execute2 (EXECUTE PROCEDURE / RETURNING). */
  procRow: unknown[] | null;
  /** A fetch stream was requested and must be consumed next. */
  pendingFetch: boolean;
  /** An info response was requested and must be consumed after the fetch. */
  pendingInfo: boolean;
}

/**
 * op_execute / op_execute2 with optional piggybacked op_fetch and
 * op_info_sql in the SAME packet — the whole statement round trip costs one
 * flush. Responses arrive FIFO: execute → fetch stream → info.
 *
 * If the execute fails, the piggybacked requests fail as plain op_response
 * errors; they are marked deferred so the reader drains them safely.
 */
export async function executeStatement(
  wire: WireConnection,
  stmt: PreparedStatementInfo,
  txHandle: number,
  values: ParamValue[],
  encodeText: (index: number, value: string) => Buffer,
  piggyback: ExecutePiggyback = {},
): Promise<ExecuteResult> {
  const useExecute2 = usesExecute2(stmt.description);

  // Encode the parameters BEFORE touching the shared writer: a bad parameter
  // must fail cleanly, never leave a half-written op_execute in the buffer
  // (which would then be flushed alongside the error-path teardown and desync
  // the wire, deadlocking the connection).
  const encoded = values.length > 0 ? encodeParams(values, encodeText, () => new XdrWriter(256)) : null;

  const w = wire.writer;
  w.int32(useExecute2 ? Op.execute2 : Op.execute).int32(stmt.handle).int32(txHandle);
  if (encoded) {
    w.opaque(encoded.blr).int32(0).int32(1);
    w.raw(encoded.message);
  } else {
    w.opaque(Buffer.alloc(0)).int32(0).int32(0);
  }
  if (useExecute2) {
    w.opaque(stmt.outputBlr).int32(0);
  }
  if (wire.protocolVersion >= 16) w.int32(0); // p_sqldata_timeout
  if (wire.protocolVersion >= 18) w.int32(0); // p_sqldata_cursor_flags
  if (wire.protocolVersion >= 19) w.int32(wire.inlineBlobSize); // p_sqldata_inline_blob_size

  const pendingFetch = !useExecute2 && piggyback.fetchSize !== undefined;
  if (pendingFetch) writeFetchRequest(wire, stmt, piggyback.fetchSize);
  const pendingInfo = piggyback.recordCounts === true;
  if (pendingInfo) writeInfoRequest(wire, stmt.handle);
  wire.flush();

  let procRow: unknown[] | null = null;
  try {
    if (useExecute2) {
      const op = await wire.readOp();
      if (op === Op.sql_response) {
        const count = await wire.readInt32();
        if (count > 0) procRow = await readRow(wire, stmt.columnReaders);
        await wire.readResponse();
      } else if (op === Op.response) {
        await wire.parseResponseBody();
      } else {
        throw new FirebirdProtocolError(`Unexpected op ${op} after op_execute2`);
      }
    } else {
      await wire.readResponse();
    }
  } catch (err) {
    // Failed execute → the piggybacked ops answer with error op_responses;
    // let the deferred-response drain in readOp() swallow them.
    if (pendingFetch) wire.markDeferred();
    if (pendingInfo) wire.markDeferred();
    throw err;
  }
  return { procRow, pendingFetch, pendingInfo };
}

export interface FetchBatch {
  rows: unknown[][];
  /** True when the cursor is exhausted (fetch status 100). */
  eof: boolean;
}

/** Write an op_fetch request without flushing (for piggybacking). */
export function writeFetchRequest(wire: WireConnection, stmt: PreparedStatementInfo, fetchSize = DEFAULT_FETCH_SIZE): void {
  wire.writer.int32(Op.fetch).int32(stmt.handle).opaque(stmt.outputBlr).int32(0).int32(fetchSize);
}

/** Consume one fetch-response stream (rows until the batch terminator). */
export async function readFetchBatch(wire: WireConnection, stmt: PreparedStatementInfo): Promise<FetchBatch> {
  const rows: unknown[][] = [];
  for (;;) {
    const op = await wire.readOp();
    if (op === Op.fetch_response) {
      const status = await wire.readInt32();
      const count = await wire.readInt32();
      if (status === 100) return { rows, eof: true }; // end of cursor
      if (count === 0) return { rows, eof: false }; // batch done, more later
      rows.push(await readRow(wire, stmt.columnReaders));
      continue;
    }
    if (op === Op.response) {
      await wire.parseResponseBody(); // raises the server error
      return { rows, eof: true };
    }
    throw new FirebirdProtocolError(`Unexpected op ${op} in fetch stream`);
  }
}

/** op_fetch — one round trip returning up to `fetchSize` rows. */
export async function fetchRows(
  wire: WireConnection,
  stmt: PreparedStatementInfo,
  fetchSize = DEFAULT_FETCH_SIZE,
): Promise<FetchBatch> {
  writeFetchRequest(wire, stmt, fetchSize);
  wire.flush();
  return readFetchBatch(wire, stmt);
}

/** Write an op_info_sql(records) request without flushing (for piggybacking). */
export function writeInfoRequest(wire: WireConnection, stmtHandle: number): void {
  wire.writer
    .int32(Op.info_sql)
    .int32(stmtHandle)
    .int32(0)
    .opaque(Buffer.from([SqlInfo.records]))
    .int32(64);
}

/** Consume a pending op_info_sql(records) response. */
export async function readRecordCounts(wire: WireConnection): Promise<RecordCounts> {
  const resp = await wire.readResponse();
  return parseRecordCounts(resp.data);
}

/** op_info_sql requesting affected-record counts. One round trip. */
export async function fetchAffectedRows(wire: WireConnection, stmtHandle: number): Promise<RecordCounts> {
  writeInfoRequest(wire, stmtHandle);
  wire.flush();
  return readRecordCounts(wire);
}

/**
 * op_free_statement. DSQL_close/DSQL_drop are deferred (lazy-send): written
 * now, flushed with the next packet, response consumed opportunistically.
 */
export function freeStatement(wire: WireConnection, stmtHandle: number, action: FreeStatement, immediate = false): void {
  wire.writer.int32(Op.free_statement).int32(stmtHandle).int32(action);
  wire.markDeferred();
  if (immediate) wire.flush();
}
