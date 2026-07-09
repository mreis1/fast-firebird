/** One entry of a decoded Firebird status vector. */
export interface StatusVectorArg {
  type: 'gds' | 'string' | 'number' | 'interpreted' | 'sql_state';
  value: number | string;
}

export class FirebirdError extends Error {
  override name = 'FirebirdError';

  constructor(
    message: string,
    /** Primary isc_* / gds error code (first arg_gds in the vector), if any. */
    readonly gdsCode?: number,
    /** SQLSTATE (arg_sql_state) when the server provided one. */
    readonly sqlState?: string,
    /** Full decoded status vector for advanced consumers. */
    readonly statusVector: StatusVectorArg[] = [],
  ) {
    super(message);
  }
}

export class FirebirdConnectionError extends FirebirdError {
  override name = 'FirebirdConnectionError';
}

export class FirebirdAuthError extends FirebirdError {
  override name = 'FirebirdAuthError';
}

export class FirebirdProtocolError extends FirebirdError {
  override name = 'FirebirdProtocolError';
}

/** Misuse of a lazy Blob handle (e.g. read after its transaction closed). */
export class FirebirdBlobError extends FirebirdError {
  override name = 'FirebirdBlobError';
}
