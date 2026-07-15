export { drizzle, FirebirdDatabase } from './driver.js';
export { FirebirdDialect } from './dialect.js';
export { FirebirdSession, FirebirdTransaction, FirebirdPreparedQuery } from './session.js';

// Table + column definitions. Firebird is Postgres-shaped, so the pg-core
// table factory and the value-round-tripping column types are reused directly.
// `firebirdTable` is `pgTable` (Firebird has no schemas). See ./columns for
// Firebird-specific date/time/blob types with correct value mapping.
export { migrate, type MigrateConfig, type MigrateResult } from './migrator.js';
export {
  introspectDatabase,
  generateDrizzleSchema,
  type IntrospectedTable,
  type IntrospectedColumn,
} from './introspect.js';

export { pgTable as firebirdTable, primaryKey } from 'drizzle-orm/pg-core';
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
