export { drizzle, FirebirdDatabase } from './driver.js';
export { FirebirdDialect } from './dialect.js';
export { FirebirdSession, FirebirdTransaction, FirebirdPreparedQuery } from './session.js';

// Table + column definitions. Firebird is Postgres-shaped, so the pg-core
// table factory and the value-round-tripping column types are reused directly.
// `firebirdTable` is `pgTable` (Firebird has no schemas). See ./columns for
// Firebird-specific date/time/blob types with correct value mapping.
export { pgTable as firebirdTable } from 'drizzle-orm/pg-core';
export {
  integer,
  smallint,
  bigint,
  doublePrecision,
  real,
  numeric,
  decimal,
  varchar,
  char,
  text,
  boolean,
} from 'drizzle-orm/pg-core';
export { timestamp, date, time, blob, blobText } from './columns.js';
