import { PgDialect, type PgInsertConfig, type PgSelectConfig, type SelectedFieldsOrdered } from 'drizzle-orm/pg-core';
import * as drizzle from 'drizzle-orm';
import { is, Param, sql, SQL, Table, type SQLChunk } from 'drizzle-orm';

// `orderSelectedFields` is exported from drizzle's runtime barrel (utils.js)
// but not from its public .d.ts — bind it once, typed via cast.
const orderSelectedFields = (drizzle as unknown as { orderSelectedFields(fields: Record<string, unknown>): SelectedFieldsOrdered })
  .orderSelectedFields;

/**
 * Firebird SQL dialect. Firebird is close to Postgres (RETURNING, `"..."`
 * quoting, generators), so we reuse pg-core's builders and only change:
 *  - parameter placeholder → `?` (positional, like the Firebird wire protocol),
 *  - identifiers upper-folded before quoting (Firebird stores unquoted names
 *    uppercase; drizzle always quotes, so `"users"` would miss table USERS),
 *  - pagination → `SELECT FIRST n SKIP m …` (Firebird rejects LIMIT/OFFSET).
 *
 * `buildSelectQuery` is adapted from drizzle-orm pg-core/dialect.ts; private
 * helpers are reached via a cast (they are TS-`private`, present on the
 * prototype at runtime). Re-sync on drizzle upgrades.
 */
export class FirebirdDialect extends PgDialect {
  /** Firebird binds `?` positionally, in appearance order. */
  override escapeParam(_num: number): string {
    return '?';
  }

  /** Upper-fold then quote, to match Firebird's unquoted-name folding. */
  override escapeName(name: string): string {
    return `"${name.toUpperCase().replace(/"/g, '""')}"`;
  }

  override buildSelectQuery(config: PgSelectConfig): SQL {
    const { withList, fields, fieldsFlat, where, having, table, joins, orderBy, groupBy, limit, offset, distinct, setOperators } =
      config;
    const self = this as unknown as {
      buildWithCTE(w: unknown): SQL | undefined;
      buildSelection(f: unknown, o: { isSingleTable: boolean }): SQL;
      buildFromTable(t: unknown): SQL;
      buildJoins(j: unknown): SQL | undefined;
      buildSetOperations(q: SQL, s: unknown): SQL;
    };

    const fieldsList = fieldsFlat ?? orderSelectedFields(fields);
    const isSingleTable = !joins || joins.length === 0;
    const withSql = self.buildWithCTE(withList);
    const distinctSql = distinct ? sql` distinct` : undefined;
    const selection = self.buildSelection(fieldsList, { isSingleTable });
    const tableSql = self.buildFromTable(table);
    const joinsSql = self.buildJoins(joins);
    const whereSql = where ? sql` where ${where}` : undefined;
    const havingSql = having ? sql` having ${having}` : undefined;
    const orderBySql = orderBy && orderBy.length > 0 ? sql` order by ${sql.join(orderBy, sql`, `)}` : undefined;
    const groupBySql = groupBy && groupBy.length > 0 ? sql` group by ${sql.join(groupBy, sql`, `)}` : undefined;

    // Firebird pagination: FIRST/SKIP right after SELECT (no LIMIT/OFFSET).
    const firstSql =
      typeof limit === 'object' || (typeof limit === 'number' && limit >= 0) ? sql` first ${limit}` : undefined;
    const skipSql = offset ? sql` skip ${offset}` : undefined;

    const finalQuery = sql`${withSql}select${firstSql}${skipSql}${distinctSql} ${selection} from ${tableSql}${joinsSql}${whereSql}${groupBySql}${havingSql}${orderBySql}`;

    return setOperators.length > 0 ? self.buildSetOperations(finalQuery, setOperators) : finalQuery;
  }

  /**
   * Firebird has no multi-row `VALUES (…),(…)` — a batch insert must be
   * `INSERT … SELECT … UNION ALL SELECT …`. Single-row inserts keep the native
   * `VALUES` form (which is also the only shape that supports `RETURNING`).
   * A `default` placeholder can't appear in a UNION SELECT, so batches that
   * rely on column defaults (or that combine RETURNING with multiple rows,
   * which Firebird can't do anyway) fall back to the pg builder.
   */
  override buildInsertQuery(config: PgInsertConfig): SQL {
    const { table, values, select, returning } = config as unknown as {
      table: Table;
      values: Record<string, Param | SQL>[];
      select?: unknown;
      returning?: unknown;
    };

    const multiRow = !select && Array.isArray(values) && values.length > 1 && !returning;
    if (!multiRow) return super.buildInsertQuery(config);

    // `casing` is TS-protected on PgDialect; Table.Symbol is not in the typed
    // surface. Both exist at runtime — reach them via casts.
    const casing = (this as unknown as { casing: { getColumnCasing(col: unknown): string } }).casing;
    const columnsSymbol = (Table as unknown as { Symbol: { Columns: symbol } }).Symbol.Columns;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const columns: Record<string, any> = (table as any)[columnsSymbol];
    const colEntries = Object.entries(columns).filter(([, col]) => !col.shouldDisableInsert());
    const insertOrder = colEntries.map(([, col]) => sql.identifier(casing.getColumnCasing(col)));

    // Any column resolving to `default` can't go through UNION SELECT.
    const usesDefault = values.some((row) =>
      colEntries.some(([field]) => {
        const v = row[field];
        return v === undefined || (is(v, Param) && v.value === undefined);
      }),
    );
    if (usesDefault) return super.buildInsertQuery(config);

    // A `?` in a bare SELECT list has no type context (Firebird -804), so each
    // bound value is CAST to its column's SQL type. SQL expressions carry their
    // own type and are passed through untouched.
    const selects = values.map((row) => {
      const cells: (SQLChunk | SQL)[] = [];
      colEntries.forEach(([field, col], i) => {
        if (i > 0) cells.push(sql`, `);
        const value = row[field]!;
        if (is(value, Param)) {
          const sqlType = (col as { getSQLType(): string }).getSQLType();
          cells.push(sql`cast(${value} as ${sql.raw(sqlType)})`);
        } else {
          cells.push(value);
        }
      });
      return sql`select ${sql.join(cells)} from rdb$database`;
    });

    const body = sql.join(selects, sql` union all `);
    return sql`insert into ${table} ${insertOrder} ${body}`;
  }
}
