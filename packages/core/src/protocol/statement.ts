import { DEFAULT_FETCH_SIZE, FreeStatement, Op, SqlInfo, StmtType } from './constants.js';
import { DESCRIBE_INFO_ITEMS, parseDescribe, parseRecordCounts, type RecordCounts, type StatementDescription } from './info.js';
import { buildOutputBlr, encodeParams, makeColumnReader, readRow, type ColumnReader, type ParamValue } from './msgcodec.js';
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
  wire.flush();

  const allocResp = await wire.readResponse(); // op_allocate_statement
  const handle = allocResp.handle;
  const prepResp = await wire.readResponse(); // op_prepare_statement
  const description = parseDescribe(prepResp.data);

  // Text codecs are attached by the caller once column metadata is known.
  const columnReaders = description.outputs.map((d) => makeColumnReader(d, null, int64As));
  const outputBlr = description.outputs.length > 0 ? buildOutputBlr(description.outputs) : Buffer.alloc(0);
  return { handle, description, outputBlr, columnReaders };
}

export interface ExecuteResult {
  /** Single row returned by op_execute2 (EXECUTE PROCEDURE), if any. */
  procRow: unknown[] | null;
}

/** op_execute / op_execute2. One round trip. */
export async function executeStatement(
  wire: WireConnection,
  stmt: PreparedStatementInfo,
  txHandle: number,
  values: ParamValue[],
  encodeText: (index: number, value: string) => Buffer,
): Promise<ExecuteResult> {
  const useExecute2 =
    stmt.description.stmtType === StmtType.exec_procedure && stmt.description.outputs.length > 0;

  const w = wire.writer;
  w.int32(useExecute2 ? Op.execute2 : Op.execute).int32(stmt.handle).int32(txHandle);
  if (values.length > 0) {
    const { blr, message } = encodeParams(values, encodeText, () => new XdrWriter(256));
    w.opaque(blr).int32(0).int32(1);
    w.raw(message);
  } else {
    w.opaque(Buffer.alloc(0)).int32(0).int32(0);
  }
  if (useExecute2) {
    w.opaque(stmt.outputBlr).int32(0);
  }
  if (wire.protocolVersion >= 16) w.int32(0); // p_sqldata_timeout
  if (wire.protocolVersion >= 18) w.int32(0); // p_sqldata_cursor_flags
  if (wire.protocolVersion >= 19) w.int32(0); // p_sqldata_inline_blob_size
  wire.flush();

  let procRow: unknown[] | null = null;
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
  return { procRow };
}

export interface FetchBatch {
  rows: unknown[][];
  /** True when the cursor is exhausted (fetch status 100). */
  eof: boolean;
}

/** op_fetch — one round trip returning up to `fetchSize` rows. */
export async function fetchRows(
  wire: WireConnection,
  stmt: PreparedStatementInfo,
  fetchSize = DEFAULT_FETCH_SIZE,
): Promise<FetchBatch> {
  wire.writer.int32(Op.fetch).int32(stmt.handle).opaque(stmt.outputBlr).int32(0).int32(fetchSize);
  wire.flush();

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

/** op_info_sql requesting affected-record counts. One round trip. */
export async function fetchAffectedRows(wire: WireConnection, stmtHandle: number): Promise<RecordCounts> {
  wire.writer
    .int32(Op.info_sql)
    .int32(stmtHandle)
    .int32(0)
    .opaque(Buffer.from([SqlInfo.records]))
    .int32(64);
  wire.flush();
  const resp = await wire.readResponse();
  return parseRecordCounts(resp.data);
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
