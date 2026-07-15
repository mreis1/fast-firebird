import { Column, SQL, Subquery, is, getTableName, fillPlaceholders, type Query } from 'drizzle-orm';
import {
  PgPreparedQuery,
  PgSession,
  PgTransaction,
  type PgDialect,
  type PgQueryResultHKT,
  type PgTransactionConfig,
  type PreparedQueryConfig,
  type SelectedFieldsOrdered,
} from 'drizzle-orm/pg-core';
import type { Attachment, Transaction as CoreTransaction, TransactionOptions } from '@fast-firebird/core';

/** What the prepared query runs against — an Attachment or a live Transaction. */
type Runner = Pick<Attachment, 'run'>;

export interface FirebirdQueryResultHKT extends PgQueryResultHKT {
  type: { rows: unknown[]; rowCount: number };
}

interface Decoder {
  mapFromDriverValue(value: unknown): unknown;
}

/** Replicated from drizzle-orm utils.ts (not part of its typed public API). */
function mapResultRow<T>(
  columns: SelectedFieldsOrdered,
  row: unknown[],
  joinsNotNullableMap: Record<string, boolean> | undefined,
): T {
  const nullifyMap: Record<string, string | false> = {};
  const result = columns.reduce<Record<string, unknown>>((acc, { path, field }, columnIndex) => {
    let decoder: Decoder;
    if (is(field, Column)) decoder = field as unknown as Decoder;
    else if (is(field, SQL)) decoder = (field as unknown as { decoder: Decoder }).decoder;
    else if (is(field, Subquery)) decoder = (field as unknown as { _: { sql: { decoder: Decoder } } })._.sql.decoder;
    else decoder = (field as unknown as { sql: { decoder: Decoder } }).sql.decoder;
    let node: Record<string, unknown> = acc;
    for (const [pathChunkIndex, pathChunk] of path.entries()) {
      if (pathChunkIndex < path.length - 1) {
        if (!(pathChunk in node)) node[pathChunk] = {};
        node = node[pathChunk] as Record<string, unknown>;
      } else {
        const rawValue = row[columnIndex];
        const value = (node[pathChunk] = rawValue === null ? null : decoder.mapFromDriverValue(rawValue));
        if (joinsNotNullableMap && is(field, Column) && path.length === 2) {
          const objectName = path[0]!;
          if (!(objectName in nullifyMap)) {
            nullifyMap[objectName] = value === null ? getTableName(field.table) : false;
          } else if (typeof nullifyMap[objectName] === 'string' && nullifyMap[objectName] !== getTableName(field.table)) {
            nullifyMap[objectName] = false;
          }
        }
      }
    }
    return acc;
  }, {});
  if (joinsNotNullableMap && Object.keys(nullifyMap).length > 0) {
    for (const [objectName, tableName] of Object.entries(nullifyMap)) {
      if (typeof tableName === 'string' && !joinsNotNullableMap[tableName]) result[objectName] = null;
    }
  }
  return result as T;
}

export class FirebirdPreparedQuery<T extends PreparedQueryConfig> extends PgPreparedQuery<T> {
  /** Set by the select builder; used to nullify all-null joined tables. */
  joinsNotNullableMap?: Record<string, boolean>;

  constructor(
    private readonly runner: Runner,
    query: Query,
    private readonly fields: SelectedFieldsOrdered | undefined,
    private readonly _isResponseInArrayMode: boolean,
    private readonly customResultMapper?: (rows: unknown[][]) => T['execute'],
  ) {
    super(query, undefined, undefined);
  }

  async execute(placeholderValues: Record<string, unknown> = {}): Promise<T['execute']> {
    const params = fillPlaceholders(this.query.params, placeholderValues);
    const { fields, customResultMapper } = this;
    if (!fields && !customResultMapper) {
      const r = await this.runner.run(this.query.sql, params as never[]);
      return { rows: r.rows, rowCount: r.rowsAffected } as T['execute'];
    }
    const r = await this.runner.run(this.query.sql, params as never[], { rowMode: 'array' });
    const rows = r.rows as unknown as unknown[][];
    return (
      customResultMapper ? customResultMapper(rows) : rows.map((row) => mapResultRow(fields!, row, this.joinsNotNullableMap))
    ) as T['execute'];
  }

  async all(placeholderValues: Record<string, unknown> = {}): Promise<T['all']> {
    const params = fillPlaceholders(this.query.params, placeholderValues);
    const r = await this.runner.run(this.query.sql, params as never[]);
    return r.rows as T['all'];
  }

  isResponseInArrayMode(): boolean {
    return this._isResponseInArrayMode;
  }
}

export class FirebirdSession<
  TFullSchema extends Record<string, unknown> = Record<string, never>,
  TSchema extends Record<string, unknown> = Record<string, never>,
> extends PgSession<FirebirdQueryResultHKT, TFullSchema, TSchema extends Record<string, never> ? never : never> {
  constructor(
    /** Attachment for starting transactions; also the default statement runner. */
    private readonly attachment: Attachment,
    dialect: PgDialect,
    private readonly schema: unknown,
    /** When inside a transaction, statements run here instead of on `attachment`. */
    private readonly runner: Runner = attachment,
  ) {
    super(dialect);
  }

  prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
    query: Query,
    fields: SelectedFieldsOrdered | undefined,
    _name: string | undefined,
    isResponseInArrayMode: boolean,
    customResultMapper?: (rows: unknown[][]) => T['execute'],
  ): PgPreparedQuery<T> {
    return new FirebirdPreparedQuery<T>(this.runner, query, fields, isResponseInArrayMode, customResultMapper);
  }

  override async transaction<T>(
    transaction: (tx: PgTransaction<FirebirdQueryResultHKT, TFullSchema, never>) => Promise<T>,
    config?: PgTransactionConfig,
  ): Promise<T> {
    return this.attachment.transaction(async (coreTx: CoreTransaction) => {
      const txSession = new FirebirdSession<TFullSchema, TSchema>(
        this.attachment,
        this.dialect as PgDialect,
        this.schema,
        coreTx,
      );
      const tx = new FirebirdTransaction<TFullSchema>(this.dialect as PgDialect, txSession, this.schema as never, coreTx);
      return transaction(tx as PgTransaction<FirebirdQueryResultHKT, TFullSchema, never>);
    }, toCoreTxOptions(config));
  }
}

export class FirebirdTransaction<
  TFullSchema extends Record<string, unknown> = Record<string, never>,
> extends PgTransaction<FirebirdQueryResultHKT, TFullSchema, never> {
  constructor(
    private readonly fbDialect: PgDialect,
    private readonly fbSession: FirebirdSession<TFullSchema, Record<string, never>>,
    private readonly fbSchema: never,
    /** The core transaction all statements run on (savepoints nest on it). */
    private readonly coreTx: CoreTransaction,
    private readonly fbNestedIndex = 0,
  ) {
    super(fbDialect, fbSession as never, fbSchema, fbNestedIndex);
  }

  /**
   * Nested transaction = SAVEPOINT on the same core transaction: released on
   * success, rolled back to on error (the outer transaction survives).
   */
  override async transaction<T>(transaction: (tx: FirebirdTransaction<TFullSchema>) => Promise<T>): Promise<T> {
    return this.coreTx.transaction(async () => {
      const nested = new FirebirdTransaction<TFullSchema>(
        this.fbDialect,
        this.fbSession,
        this.fbSchema,
        this.coreTx,
        this.fbNestedIndex + 1,
      );
      return transaction(nested);
    });
  }
}

function toCoreTxOptions(config?: PgTransactionConfig): TransactionOptions | undefined {
  if (!config) return undefined;
  const opts: TransactionOptions = {};
  if (config.accessMode === 'read only') opts.readOnly = true;
  if (config.isolationLevel === 'serializable') opts.isolation = 'serializable';
  else if (config.isolationLevel === 'read committed') opts.isolation = 'readCommitted';
  else if (config.isolationLevel === 'repeatable read') opts.isolation = 'snapshot';
  return opts;
}
