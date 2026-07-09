export { connect, create as createDatabase, Attachment, type ConnectInput } from './api/attachment.js';
export { Transaction } from './api/transaction.js';
export { PreparedStatement } from './api/prepared.js';
export { Pool, createPool, type PoolOptions, type PoolStats } from './pool/pool.js';
export { parseScript, ScriptParseError, type ParsedStatement, type ParseScriptOptions } from './script/parser.js';
export {
  type ExecuteScriptOptions,
  type ScriptExecutionResult,
  type StatementResult,
} from './script/execute.js';
export { EventListener, EventChannel } from './events/events.js';
export { Service, connectService, type ServiceConnectOptions, type ServerInfo } from './services/service.js';
export type { QueryResult, Row } from './api/session.js';
export type { TransactionOptions, IsolationLevel } from './protocol/transaction.js';
export type { ParamValue } from './protocol/msgcodec.js';
export type { FirebirdConnectionOptions, LegacyOptionAliases, WireCryptOption } from './api/options.js';
export { FirebirdError, FirebirdAuthError, FirebirdConnectionError, FirebirdProtocolError } from './api/errors.js';
export type { FirebirdTranscodeAdapter, DecodeContext, EncodeContext } from './charset/decoder.js';
