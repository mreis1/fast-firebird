/**
 * Firebird wire-protocol constants.
 * Values verified against firebird/src/remote/protocol.h and the reference
 * drivers (see plans/research/). Do not "fix" apparent oddities without
 * checking those notes — several are load-bearing quirks.
 */

// ── Operation codes ────────────────────────────────────────────────────────
export const enum Op {
  void = 0,
  connect = 1,
  exit = 2,
  accept = 3,
  reject = 4,
  disconnect = 6,
  response = 9,
  attach = 19,
  create = 20,
  detach = 21,
  transaction = 29,
  commit = 30,
  rollback = 31,
  create_blob = 34,
  open_blob = 35,
  get_segment = 36,
  put_segment = 37,
  cancel_blob = 38,
  close_blob = 39,
  info_database = 40,
  info_transaction = 42,
  info_blob = 43,
  batch_segments = 44,
  que_events = 48,
  cancel_events = 49,
  commit_retaining = 50,
  event = 52,
  connect_request = 53,
  open_blob2 = 56,
  create_blob2 = 57,
  allocate_statement = 62,
  execute = 63,
  exec_immediate = 64,
  fetch = 65,
  fetch_response = 66,
  free_statement = 67,
  prepare_statement = 68,
  set_cursor = 69,
  info_sql = 70,
  dummy = 71,
  response_piggyback = 72,
  execute2 = 76,
  sql_response = 78,
  drop_database = 81,
  service_attach = 82,
  service_detach = 83,
  service_info = 84,
  service_start = 85,
  rollback_retaining = 86,
  partial = 89,
  trusted_auth = 90,
  cancel = 91,
  cont_auth = 92,
  ping = 93,
  accept_data = 94,
  abort_aux_connection = 95,
  crypt = 96,
  crypt_key_callback = 97,
  cond_accept = 98,
  batch_create = 99,
  batch_msg = 100,
  batch_exec = 101,
  batch_rls = 102,
  batch_cs = 103,
  batch_regblob = 104,
  batch_blob_stream = 105,
  batch_set_bpb = 106,
  fetch_scroll = 112,
  info_cursor = 113,
  inline_blob = 114,
}

export const enum FreeStatement {
  DSQL_close = 1,
  DSQL_drop = 2,
  DSQL_unprepare = 4,
}

// ── Connect handshake ──────────────────────────────────────────────────────
export const CONNECT_VERSION3 = 3;
export const ARCHITECTURE_GENERIC = 1;

export const enum Cnct {
  user = 1,
  passwd = 2,
  host = 4,
  group = 5,
  user_verification = 6,
  specific_data = 7,
  plugin_name = 8,
  login = 9,
  plugin_list = 10,
  client_crypt = 11,
}

export const FB_PROTOCOL_FLAG = 0x8000;
export const PROTOCOL_VERSION13 = FB_PROTOCOL_FLAG | 13; // FB3
export const PROTOCOL_VERSION14 = FB_PROTOCOL_FLAG | 14;
export const PROTOCOL_VERSION15 = FB_PROTOCOL_FLAG | 15; // FB4
export const PROTOCOL_VERSION16 = FB_PROTOCOL_FLAG | 16; // FB4/FB5
// Protocol 19 (FB 5.0.2+): op_inline_blob — small blobs ride with the rows.
// We deliberately skip offering 17 (op_batch_sync) and 18 (op_fetch_scroll):
// nothing we send uses their features, and every version-gated field we DO
// send (op_execute timeout/cursor_flags/inline_blob_size) is already encoded
// per negotiated version in executeStatement.
export const PROTOCOL_VERSION19 = FB_PROTOCOL_FLAG | 19; // FB 5.0.2+

export const enum Ptype {
  rpc = 2,
  batch_send = 3,
  out_of_band = 4,
  lazy_send = 5,
  mask = 0xff,
}
export const PFLAG_COMPRESS = 0x100;

/** [version, architecture, minType, maxType, weight] offers, oldest→newest. */
export const SUPPORTED_PROTOCOLS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [PROTOCOL_VERSION13, ARCHITECTURE_GENERIC, Ptype.lazy_send, Ptype.lazy_send, 1],
  [PROTOCOL_VERSION14, ARCHITECTURE_GENERIC, Ptype.lazy_send, Ptype.lazy_send, 2],
  [PROTOCOL_VERSION15, ARCHITECTURE_GENERIC, Ptype.lazy_send, Ptype.lazy_send, 3],
  [PROTOCOL_VERSION16, ARCHITECTURE_GENERIC, Ptype.lazy_send, Ptype.lazy_send, 4],
  [PROTOCOL_VERSION19, ARCHITECTURE_GENERIC, Ptype.lazy_send, Ptype.lazy_send, 5],
];

export const enum WireCryptLevel {
  disabled = 0,
  enabled = 1,
  required = 2,
}

/** Client plugin list — mirrors fbclient's default `AuthClient` so the server
 *  can steer to Legacy_Auth when an account only authenticates there. */
export const AUTH_PLUGIN_LIST = 'Srp256,Srp,Legacy_Auth';

// ── DPB (database parameter buffer) ────────────────────────────────────────
export const enum Dpb {
  version1 = 1,
  page_size = 4,
  force_write = 24,
  user_name = 28,
  password = 29,
  password_enc = 30,
  lc_ctype = 48,
  overwrite = 54,
  connect_timeout = 57,
  sql_role_name = 60,
  sql_dialect = 63,
  set_db_charset = 68,
  process_id = 71,
  process_name = 74,
  utf8_filename = 77,
  client_version = 80,
  specific_auth_data = 84,
  auth_plugin_list = 85,
  auth_plugin_name = 86,
  session_time_zone = 91,
}

// ── TPB (transaction parameter buffer) ─────────────────────────────────────
export const enum Tpb {
  version3 = 3,
  consistency = 1,
  concurrency = 2,
  wait = 6,
  nowait = 7,
  read = 8,
  write = 9,
  ignore_limbo = 14,
  read_committed = 15,
  autocommit = 16,
  rec_version = 17,
  no_rec_version = 18,
  no_auto_undo = 20,
  lock_timeout = 21,
}

// ── SQL info items (op_prepare_statement / op_info_sql) ────────────────────
export const enum SqlInfo {
  end = 1,
  truncated = 2,
  error = 3,
  select = 4,
  bind = 5,
  num_variables = 6,
  describe_vars = 7,
  describe_end = 8,
  sqlda_seq = 9,
  message_seq = 10,
  type = 11,
  sub_type = 12,
  scale = 13,
  length = 14,
  null_ind = 15,
  field = 16,
  relation = 17,
  owner = 18,
  alias = 19,
  sqlda_start = 20,
  stmt_type = 21,
  get_plan = 22,
  records = 23,
  batch_fetch = 24,
  relation_alias = 25,
}

export const enum StmtType {
  select = 1,
  insert = 2,
  update = 3,
  delete = 4,
  ddl = 5,
  get_segment = 6,
  put_segment = 7,
  exec_procedure = 8,
  start_trans = 9,
  commit = 10,
  rollback = 11,
  select_for_upd = 12,
  set_generator = 13,
  savepoint = 14,
}

// ── SQL data types (sqlda_pub.h; low bit = nullable flag) ──────────────────
export const enum SqlType {
  TEXT = 452,
  VARYING = 448,
  SHORT = 500,
  LONG = 496,
  FLOAT = 482,
  DOUBLE = 480,
  D_FLOAT = 530,
  TIMESTAMP = 510,
  BLOB = 520,
  ARRAY = 540,
  QUAD = 550,
  TYPE_TIME = 560,
  TYPE_DATE = 570,
  INT64 = 580,
  INT128 = 32752,
  TIMESTAMP_TZ_EX = 32748,
  TIME_TZ_EX = 32750,
  TIMESTAMP_TZ = 32754,
  TIME_TZ = 32756,
  DEC16 = 32760,
  DEC34 = 32762,
  BOOLEAN = 32764,
  NULL = 32766,
}

// ── BLR codes (blr.h subset used for message descriptors) ──────────────────
export const enum Blr {
  version5 = 5,
  begin = 2,
  message = 4,
  text = 14,
  varying = 37,
  short = 7,
  long = 8,
  int64 = 16,
  int128 = 26,
  quad = 9,
  float = 10,
  double = 27,
  d_float = 11,
  sql_date = 12,
  sql_time = 13,
  timestamp = 35,
  blob = 261,
  blob2 = 17,
  bool = 23,
  dec64 = 24,
  dec128 = 25,
  sql_time_tz = 28,
  timestamp_tz = 29,
  ex_time_tz = 30,
  ex_timestamp_tz = 31,
  end = 255,
  eoc = 76,
}

// ── Status vector argument codes ───────────────────────────────────────────
export const enum IscArg {
  end = 0,
  gds = 1,
  string = 2,
  cstring = 3,
  number = 4,
  interpreted = 5,
  unix = 7,
  warning = 18,
  sql_state = 19,
}

export const ISC_SQLERR = 335544436;
/** gds code carrying the SQLCODE in an isc_arg_number that follows it. */

// ── Services (SPB + service info items) ────────────────────────────────────
export const enum Spb {
  current_version = 2,
  version3 = 3,
  user_name = 28, // = isc_dpb_user_name
  password = 29,
  specific_auth_data = 111, // = isc_spb_trusted_auth
  auth_plugin_name = 116,
  auth_plugin_list = 117,
  utf8_filename = 118,
  dbname = 106,
  expected_db = 124,
}

export const enum SvcInfo {
  svr_db_info = 50,
  get_config = 53,
  version = 54,
  server_version = 55,
  implementation = 56,
  capabilities = 57,
  user_dbpath = 58,
  get_env = 59,
  get_env_lock = 60,
  get_env_msg = 61,
  line = 62,
  to_eof = 63,
  timeout = 64,
  stdin = 78,
}

export const enum SvcAction {
  db_stats = 11,
}

export const enum Info {
  end = 1,
  truncated = 2,
}

export const SERVICE_MGR = 'service_mgr';

// ── Events ─────────────────────────────────────────────────────────────────
export const EPB_VERSION1 = 1;
export const P_REQ_ASYNC = 1;

// ── Blob ───────────────────────────────────────────────────────────────────
/** op_get_segment op_response.handle value meaning end-of-blob. */
export const BLOB_SEGSTR_EOF_HANDLE = 2;

export const DEFAULT_FETCH_SIZE = 400;
export const DEFAULT_BLOB_CHUNK = 16 * 1024;
export const MAX_SEGMENT_SIZE = 65535;
