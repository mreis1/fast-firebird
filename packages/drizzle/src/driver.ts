import { PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';
import {
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  type ExtractTablesWithRelations,
  type RelationalSchemaConfig,
  type TablesRelationalConfig,
} from 'drizzle-orm';
import type { DrizzleConfig } from 'drizzle-orm';
import type { Attachment } from '@fast-firebird/core';
import { FirebirdDialect } from './dialect.js';
import { FirebirdSession, type FirebirdQueryResultHKT } from './session.js';

export class FirebirdDatabase<TSchema extends Record<string, unknown> = Record<string, never>> extends PgDatabase<
  FirebirdQueryResultHKT & PgQueryResultHKT,
  TSchema,
  ExtractTablesWithRelations<TSchema>
> {
  /** The underlying @fast-firebird/core Attachment. */
  $client!: Attachment;
}

/**
 * Create a Drizzle database over a `@fast-firebird/core` `Attachment`.
 *
 * ```ts
 * const db = await connect({ … });          // @fast-firebird/core
 * const orm = drizzle(db);                   // this package
 * const rows = await orm.select().from(users);
 * ```
 */
export function drizzle<TSchema extends Record<string, unknown> = Record<string, never>>(
  client: Attachment,
  config: DrizzleConfig<TSchema> = {},
): FirebirdDatabase<TSchema> {
  const dialect = new FirebirdDialect({ casing: config.casing });

  let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;
  if (config.schema) {
    const tablesConfig = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
    schema = {
      fullSchema: config.schema,
      schema: tablesConfig.tables,
      tableNamesMap: tablesConfig.tableNamesMap,
    };
  }

  const session = new FirebirdSession(client, dialect, schema);
  const db = new PgDatabase(dialect, session as never, schema as never) as FirebirdDatabase<TSchema>;
  db.$client = client;
  return db;
}
