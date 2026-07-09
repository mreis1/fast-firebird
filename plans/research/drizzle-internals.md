# Drizzle ORM internals — implementation reference for a first-party Firebird dialect

Version studied: **drizzle-orm 0.45.3**
Source root: `references/drizzle-orm/drizzle-orm/src`

This document is a blueprint for writing `@fast-firebird/drizzle`. It maps the exact object
graph, class hierarchy, method signatures, and the SQL-generation seams we must reimplement or
subclass. All quoted code is verbatim from the source at the version above. `~/` in imports means
the `src/` root.

Firebird's dialect is closest to **pg-core** (RETURNING, `"..."` identifier quoting, generators).
The two things that differ structurally are:
- **pagination**: Firebird uses `SELECT FIRST n SKIP m ...` (or `... ROWS`/`FETCH FIRST n ROWS ONLY`)
  instead of trailing `LIMIT n OFFSET m`. Postgres emits `limit`/`offset` at the very *end* of the
  query; Firebird's `FIRST/SKIP` go *right after* the `SELECT` keyword. This is the single most
  invasive override.
- **placeholders**: pg emits `$1, $2, ...`; Firebird's driver wants `?`. This is a one-line change
  in `escapeParam` (mysql-core already does exactly this — see §3).

---

## 0. The layering, top to bottom

```
drizzle(client, config)                       node-postgres/driver.ts  (entry point / factory)
   │  constructs
   ├─ PgDialect            pg-core/dialect.ts   (pure SQL string builder; NO db access)
   ├─ NodePgSession        node-postgres/session.ts  ⟶ extends PgSession (pg-core/session.ts)
   │     │ wraps the raw driver client; owns prepareQuery / execute / transaction
   │     └─ NodePgPreparedQuery ⟶ extends PgPreparedQuery  (one built query; runs client.query)
   └─ NodePgDatabase       node-postgres/driver.ts ⟶ extends PgDatabase (pg-core/db.ts)
         └─ public API: .select() .insert() .update() .delete() .execute() .transaction() .query.*
              returns query-builder objects (pg-core/query-builders/*) that:
                1. accumulate a *Config object (PgSelectConfig, PgInsertConfig, ...)
                2. on getSQL() call  dialect.buildXxxQuery(config)  ⟶ SQL object
                3. on execute()      session.prepareQuery(dialect.sqlToQuery(sql), fields, ...).execute()
```

Key mental model: **the dialect never touches the database**. It only turns config objects and
`SQL` template trees into `{ sql: string, params: unknown[] }`. The **session** is the only thing
that knows the real driver. To add Firebird we implement (a) a dialect subclass and (b) a session +
prepared-query pair over the Firebird client. Everything else (query builders, column builders,
table factory) is dialect-parameterized and can be copied structurally from pg-core.

---

## 1. The full object graph for a driver — `drizzle(client)`

File: `node-postgres/driver.ts`.

`drizzle()` is a thin overloaded entry point; the real wiring is in `construct()`:

```ts
function construct<TSchema, TClient extends NodePgClient = NodePgClient>(
    client: TClient,
    config: DrizzleConfig<TSchema> = {},
): NodePgDatabase<TSchema> & { $client: ... } {
    const dialect = new PgDialect({ casing: config.casing });
    let logger;
    if (config.logger === true) logger = new DefaultLogger();
    else if (config.logger !== false) logger = config.logger;

    let schema: RelationalSchemaConfig<TablesRelationalConfig> | undefined;
    if (config.schema) {
        const tablesConfig = extractTablesRelationalConfig(config.schema, createTableRelationsHelpers);
        schema = {
            fullSchema: config.schema,
            schema: tablesConfig.tables,
            tableNamesMap: tablesConfig.tableNamesMap,
        };
    }

    const driver  = new NodePgDriver(client, dialect, { logger, cache: config.cache });
    const session = driver.createSession(schema);
    const db = new NodePgDatabase(dialect, session, schema as any) as NodePgDatabase<TSchema>;
    (<any> db).$client = client;
    (<any> db).$cache = config.cache;
    if ((<any> db).$cache) { (<any> db).$cache['invalidate'] = config.cache?.onMutate; }
    return db as any;
}
```

`NodePgDriver` is trivial — it just holds `(client, dialect, options)` and builds a session:

```ts
export class NodePgDriver {
    static readonly [entityKind]: string = 'NodePgDriver';
    constructor(private client: NodePgClient, private dialect: PgDialect,
                private options: PgDriverOptions = {}) {}
    createSession(schema): NodePgSession<Record<string, unknown>, TablesRelationalConfig> {
        return new NodePgSession(this.client, this.dialect, schema,
            { logger: this.options.logger, cache: this.options.cache });
    }
}
```

`NodePgDatabase` adds nothing but the entityKind — the whole public API lives in the base
`PgDatabase` (pg-core/db.ts):

```ts
export class NodePgDatabase<TSchema extends Record<string, unknown> = Record<string, never>>
    extends PgDatabase<NodePgQueryResultHKT, TSchema> {
    static override readonly [entityKind]: string = 'NodePgDatabase';
}
```

**What `drizzle()` returns:** a `PgDatabase` instance (branded `NodePgDatabase`) with `.$client`
and `.$cache` bolted on. `PgDatabase`'s constructor stores `dialect`, `session`, and (if a relational
`schema` was passed) builds `db.query.<table>` `RelationalQueryBuilder`s:

```ts
constructor(readonly dialect: PgDialect, readonly session: PgSession<any,any,any>,
            schema: RelationalSchemaConfig<TSchema> | undefined) {
    this._ = schema ? { schema: schema.schema, fullSchema: ..., tableNamesMap: ..., session }
                    : { schema: undefined, fullSchema: {} as TFullSchema, tableNamesMap: {}, session };
    this.query = {} as ...;
    if (this._.schema) { for (const [tableName, columns] of Object.entries(this._.schema)) {
        this.query[tableName] = new RelationalQueryBuilder(schema.fullSchema, this._.schema,
            this._.tableNamesMap, schema.fullSchema[tableName] as PgTable, columns, dialect, session);
    }}
    this.$cache = { invalidate: async () => {} };
}
```

**Firebird equivalents to build:**
`FirebirdDialect`, `FirebirdSession extends ??? ` (we should mirror `PgSession`), `FirebirdPreparedQuery`,
`FirebirdDatabase extends FirebirdBaseDatabase`, and a `drizzle(client, config)` doing the same
`new Dialect → driver.createSession → new Database(dialect, session, schema)` dance. If we don't
need relational queries at first, we can pass `schema = undefined` and skip
`extractTablesRelationalConfig`.

---

## 2. Dialect — `pg-core/dialect.ts` (class `PgDialect`)

Constructor + the escape/param primitives (these are the *only* dialect-specific string bits):

```ts
export class PgDialect {
    static readonly [entityKind]: string = 'PgDialect';
    readonly casing: CasingCache;
    constructor(config?: PgDialectConfig) { this.casing = new CasingCache(config?.casing); }

    escapeName(name: string): string   { return `"${name.replace(/"/g, '""')}"`; }   // ← Firebird: SAME
    escapeParam(num: number): string   { return `$${num + 1}`; }                     // ← Firebird: return `?`
    escapeString(str: string): string  { return `'${str.replace(/'/g, "''")}'`; }    // ← Firebird: SAME
}
```

For Firebird: keep `escapeName` (double-quoted, doubled-quote escaping — identical to pg) and
`escapeString`; change `escapeParam` to `` return '?' `` (exactly what mysql-core does, §3). Note the
escaped identifier is **case-sensitive** in Firebird when quoted — see §9 risk note on casing.

### Methods the query builders actually call on the dialect

These are the public methods a working dialect MUST provide (query builders reference them directly):

| Method | Signature | Called by |
|---|---|---|
| `sqlToQuery` | `(sql: SQL, invokeSource?) => QueryWithTypings` | every builder's `_prepare`/`toSQL`, `db.execute`, `session.execute/all` |
| `buildSelectQuery` | `(config: PgSelectConfig) => SQL` | `PgSelectBase.getSQL()` |
| `buildInsertQuery` | `(config: PgInsertConfig) => SQL` | `PgInsertBase.getSQL()` |
| `buildUpdateQuery` | `(config: PgUpdateConfig) => SQL` | `PgUpdateBase.getSQL()` |
| `buildUpdateSet` | `(table, set: UpdateSet) => SQL` | update builder + insert `onConflictDoUpdate` |
| `buildDeleteQuery` | `(config: PgDeleteConfig) => SQL` | `PgDeleteBase.getSQL()` |
| `escapeName` | `(name) => string` | insert `onConflict` target list (called directly), and inside `sqlToQuery` |
| `casing.getColumnCasing(col)` | `(col) => string` | builders, when emitting column names |
| `buildRelationalQueryWithoutPK` | (big) | only `db.query.*` (relational API) — **skippable initially** |
| `migrate` | `(migrations, session, config)` | only the migrator — **skippable initially** |
| `buildRefreshMaterializedViewQuery` | — | only `refreshMaterializedView` — skippable |
| `buildSetOperations` / `buildSetOperationQuery` | — | union/intersect/except — skippable |
| `prepareTyping` | `(encoder) => QueryTypingsValue` | passed into `sqlToQuery`; pg uses it for `$n::type` casts. Firebird can return `'none'` always. |

`sqlToQuery` is the universal seam — it feeds all four escape hooks into `SQL.toQuery`:

```ts
sqlToQuery(sql: SQL, invokeSource?: 'indexes' | undefined): QueryWithTypings {
    return sql.toQuery({
        casing: this.casing,
        escapeName: this.escapeName,
        escapeParam: this.escapeParam,
        escapeString: this.escapeString,
        prepareTyping: this.prepareTyping,
        invokeSource,
    });
}
```

### RETURNING (identical for Firebird — Firebird supports it)

Emitted by each mutating builder via a shared private `buildSelection`:

```ts
// delete
const returningSql = returning
    ? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}` : undefined;
return sql`${withSql}delete from ${table}${whereSql}${returningSql}`;
// insert
const returningSql = returning
    ? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}` : undefined;
return sql`${withSql}insert into ${table} ${insertOrder} ${overridingSql}${valuesSql}${onConflictSql}${returningSql}`;
// update
const returningSql = returning
    ? sql` returning ${this.buildSelection(returning, { isSingleTable: !from })}` : undefined;
```

> Firebird caveat (not a code change, a behavior note): classic Firebird `RETURNING` on a
> single-row DML returns *one* row and historically errored on multi-row DML. FB5 relaxes this.
> The SQL string generation is identical; the runtime/driver must tolerate the row-count semantics.

### buildInsertQuery (verbatim, the part that matters)

```ts
buildInsertQuery({ table, values: valuesOrSelect, onConflict, returning, withList, select, overridingSystemValue_ }: PgInsertConfig): SQL {
    const valuesSqlList: ((SQLChunk | SQL)[] | SQL)[] = [];
    const columns: Record<string, PgColumn> = table[Table.Symbol.Columns];
    const colEntries: [string, PgColumn][] = Object.entries(columns).filter(([_, col]) => !col.shouldDisableInsert());
    const insertOrder = colEntries.map(([, column]) => sql.identifier(this.casing.getColumnCasing(column)));
    ...
    // for each row, for each column: push value, or col.defaultFn(), or sql`default`
    const valuesSql = sql.join(valuesSqlList);
    const returningSql = returning ? sql` returning ${this.buildSelection(returning, { isSingleTable: true })}` : undefined;
    const onConflictSql = onConflict ? sql` on conflict ${onConflict}` : undefined;
    const overridingSql = overridingSystemValue_ === true ? sql`overriding system value ` : undefined;
    return sql`${withSql}insert into ${table} ${insertOrder} ${overridingSql}${valuesSql}${onConflictSql}${returningSql}`;
}
```

Firebird changes for insert: drop `overriding system value`, and `ON CONFLICT` doesn't exist —
Firebird uses `UPDATE OR INSERT ... MATCHING (...)` or `MERGE`. For the MVP, we can simply **not
support `.onConflictDoNothing/DoUpdate`** (leave `onConflict` undefined) and emit plain
`INSERT INTO t (cols) VALUES (...) RETURNING ...`. `sql\`default\`` for omitted columns works in
Firebird (`DEFAULT` keyword is supported inside VALUES).

### buildUpdateSet / buildUpdateQuery (largely reusable)

```ts
buildUpdateSet(table: PgTable, set: UpdateSet): SQL {
    const tableColumns = table[Table.Symbol.Columns];
    const columnNames = Object.keys(tableColumns).filter((colName) =>
        set[colName] !== undefined || tableColumns[colName]?.onUpdateFn !== undefined);
    const setSize = columnNames.length;
    return sql.join(columnNames.flatMap((colName, i) => {
        const col = tableColumns[colName]!;
        const onUpdateFnResult = col.onUpdateFn?.();
        const value = set[colName] ?? (is(onUpdateFnResult, SQL) ? onUpdateFnResult : sql.param(onUpdateFnResult, col));
        const res = sql`${sql.identifier(this.casing.getColumnCasing(col))} = ${value}`;
        if (i < setSize - 1) return [res, sql.raw(', ')];
        return [res];
    }));
}
```

`buildUpdateQuery` in pg supports `from`/`joins` (Postgres `UPDATE ... FROM`). Firebird has no
`UPDATE ... FROM`; MVP should emit `update <table> set <set> where <where> returning <returning>`
and ignore `from`/`joins`.

### buildSelectQuery + the LIMIT/OFFSET code we must override (§2 focus)

Full method is at `dialect.ts:341-448`. The pagination bit:

```ts
const limitSql = typeof limit === 'object' || (typeof limit === 'number' && limit >= 0)
    ? sql` limit ${limit}`
    : undefined;

const offsetSql = offset ? sql` offset ${offset}` : undefined;

const lockingClauseSql = sql.empty();
// ... lockingClause building ...

const finalQuery =
    sql`${withSql}select${distinctSql} ${selection} from ${tableSql}${joinsSql}${whereSql}${groupBySql}${havingSql}${orderBySql}${limitSql}${offsetSql}${lockingClauseSql}`;
```

Note the placement: `${limitSql}${offsetSql}` come **after** everything, appended to the tail. For
Firebird we must instead inject `FIRST/SKIP` **immediately after `select`** (and drop the trailing
limit/offset). The cleanest override in a `FirebirdDialect.buildSelectQuery` is to copy the whole
method and change two things:

```ts
// Firebird pagination — goes right after SELECT (and after DISTINCT):
const firstSql = (typeof limit === 'object' || (typeof limit === 'number' && limit >= 0))
    ? sql` first ${limit}` : undefined;
const skipSql = offset ? sql` skip ${offset}` : undefined;
// ... build selection/table/joins/where/... as pg does, WITHOUT limitSql/offsetSql ...
const finalQuery =
    sql`${withSql}select${firstSql}${skipSql}${distinctSql} ${selection} from ${tableSql}${joinsSql}${whereSql}${groupBySql}${havingSql}${orderBySql}${lockingClauseSql}`;
```

Alternative (SQL-standard, FB3+ friendly and better for parameter binding): emit the
`OFFSET n ROWS FETCH NEXT m ROWS ONLY` form at the tail — closer to pg's shape (only the keywords
change), so you override less. Either works; `FIRST/SKIP` is the traditional Firebird idiom and
accepts parameters (`FIRST ? SKIP ?`). Decide based on driver placeholder support for these
positions.

`distinct on (...)` (the `distinct` object form) is Postgres-only — Firebird only has plain
`DISTINCT`, so treat `distinct` as boolean.

The reference for "how little you can change" is **mysql-core**, which factored pagination into a
tiny helper `buildLimit` (mysql-core/dialect.ts:285):

```ts
private buildLimit(limit: number | Placeholder | undefined): SQL | undefined {
    return typeof limit === 'object' || (typeof limit === 'number' && limit >= 0)
        ? sql` limit ${limit}` : undefined;
}
```

We should introduce the same kind of helper (`buildFirst`/`buildSkip`) but call it in the
post-`select` position.

### buildRelationalQuery — can we skip it? YES (initially)

The huge commented-out `buildRelationalQueryWithPK` (dialect.ts:620-1148) is dead code. The live one
is `buildRelationalQueryWithoutPK` (dialect.ts:1150-1445). It is **only** invoked by the relational
`db.query.<table>.findMany/findFirst` API and relies heavily on Postgres `json_build_array` /
`json_agg` / `coalesce(..., '[]'::json)`. Firebird lacks these exact JSON aggregates, so this is the
hardest part to port and should be **deferred**. To not break construction: if we never pass a
relational `schema` to the DB constructor, `db.query` is `{}` and this method is never called. If a
schema *is* passed but we don't want relational queries yet, we can leave the method throwing
`new DrizzleError('relational queries not supported')` — it is only reached lazily on a
`db.query.x` call, never at construction.

---

## 3. The `sql` template + `Query` — `sql/sql.ts`

`sql\`...\`` builds a `SQL` object whose `queryChunks` interleave `StringChunk`s and params:

```ts
export function sql(strings: TemplateStringsArray, ...params: SQLChunk[]): SQL {
    const queryChunks: SQLChunk[] = [];
    if (params.length > 0 || (strings.length > 0 && strings[0] !== '')) {
        queryChunks.push(new StringChunk(strings[0]!));
    }
    for (const [paramIndex, param] of params.entries()) {
        queryChunks.push(param, new StringChunk(strings[paramIndex + 1]!));
    }
    return new SQL(queryChunks);
}
```

A `SQLChunk` can be a `StringChunk`, a nested `SQL`, a `Table`, a `Column`, a `Name`
(`sql.identifier`), a `Param` (`sql.param`), a `Placeholder` (`sql.placeholder`), a `Subquery`,
an array (rendered as `(a, b, c)`), or any `SQLWrapper` (rendered wrapped in parens). Helpers:
`sql.raw(str)`, `sql.identifier(name)`, `sql.join(chunks, sep)`, `sql.param(value, encoder)`,
`sql.placeholder(name)`, `sql.empty()`, and `.as(alias)` / `.mapWith(decoder)` / `.if(cond)`.

`dialect.sqlToQuery(sql)` → `SQL.toQuery(config)` → `buildQueryFromSourceParams`, which walks the
chunks and produces `{ sql, params, typings }`. The param-emitting branches (this is where the
placeholder string is generated):

```ts
if (is(chunk, Param)) {
    if (is(chunk.value, Placeholder)) {
        return { sql: escapeParam(paramStartIndex.value++, chunk), params: [chunk], typings: ['none'] };
    }
    const mappedValue = chunk.value === null ? null : chunk.encoder.mapToDriverValue(chunk.value);
    if (is(mappedValue, SQL)) return this.buildQueryFromSourceParams([mappedValue], config);
    if (inlineParams)          return { sql: this.mapInlineParam(mappedValue, config), params: [] };
    let typings: QueryTypingsValue[] = ['none'];
    if (prepareTyping) typings = [prepareTyping(chunk.encoder)];
    return { sql: escapeParam(paramStartIndex.value++, mappedValue), params: [mappedValue], typings };
}
if (is(chunk, Placeholder)) {
    return { sql: escapeParam(paramStartIndex.value++, chunk), params: [chunk], typings: ['none'] };
}
// bare primitive value passed straight into the template:
return { sql: escapeParam(paramStartIndex.value++, chunk), params: [chunk], typings: ['none'] };
```

Identifiers/tables/columns go through `escapeName`; params go through `escapeParam(index, value)`.

**Placeholder format in the generated string:**
- pg (`escapeParam(num){ return \`$${num+1}\` }`) → the Session receives `... where "id" = $1`.
- mysql (`escapeParam(_num){ return \`?\` }`) → `... where \`id\` = ?`.

**Firebird**: emit `?` (like mysql). Because `escapeParam` for `?` ignores the index and every param
is pushed onto `params` in encounter order, **positional `?` placeholders line up 1:1 with
`query.params`** — no remapping needed in the Session. If instead we chose numbered/named Firebird
placeholders we'd have to track order, but `?` is simplest and matches most node Firebird drivers
(`node-firebird`, `node-firebird-driver-native`).

`params` are the *mapped driver values* (already run through `column.mapToDriverValue`), except when
the value is a `Placeholder` — then the raw `Param`/`Placeholder` object is stored and resolved later
by `fillPlaceholders(params, values)` at execute time (sql.ts:612):

```ts
export function fillPlaceholders(params: unknown[], values: Record<string, unknown>): unknown[] {
    return params.map((p) => {
        if (is(p, Placeholder)) { if (!(p.name in values)) throw ...; return values[p.name]; }
        if (is(p, Param) && is(p.value, Placeholder)) { ...; return p.encoder.mapToDriverValue(values[p.value.name]); }
        return p;
    });
}
```

`Query` shape (`sql/sql.ts:45`): `{ sql: string; params: unknown[] }`; `QueryWithTypings` adds
optional `typings?: QueryTypingsValue[]`. **This `{ sql, params }` is exactly what the Session
receives.**

---

## 4. Session + PreparedQuery — `pg-core/session.ts` + `node-postgres/session.ts`

### Abstract contracts (pg-core/session.ts)

`PreparedQueryConfig` shape:
```ts
export interface PreparedQueryConfig { execute: unknown; all: unknown; values: unknown; }
```

`PgPreparedQuery<T>` — abstract, constructed with `(query: Query, cache, queryMetadata, cacheConfig)`.
Abstract members we must implement:
```ts
abstract execute(placeholderValues?: Record<string, unknown>): Promise<T['execute']>;
abstract all(placeholderValues?: Record<string, unknown>): Promise<T['all']>;   // /** @internal */
abstract isResponseInArrayMode(): boolean;                                       // /** @internal */
// provided by base: getQuery(), mapResult(response, isFromBatch?), setToken(), queryWithCache(...)
// public field set by select builder: joinsNotNullableMap?: Record<string, boolean>;
```

`PgSession` — abstract:
```ts
export abstract class PgSession<TQueryResult, TFullSchema, TSchema> {
    constructor(protected dialect: PgDialect) {}
    abstract prepareQuery<T extends PreparedQueryConfig = PreparedQueryConfig>(
        query: Query,
        fields: SelectedFieldsOrdered | undefined,
        name: string | undefined,
        isResponseInArrayMode: boolean,
        customResultMapper?: (rows: unknown[][], mapColumnValue?) => T['execute'],
        queryMetadata?: { type: 'select'|'update'|'delete'|'insert'; tables: string[] },
        cacheConfig?: WithCacheConfig,
    ): PgPreparedQuery<T>;

    execute<T>(query: SQL): Promise<T>   // concrete: prepareQuery(dialect.sqlToQuery(query), undefined, undefined, false).execute()
    all<T>(query: SQL): Promise<T[]>     // concrete: prepareQuery(...).all()
    async count(sql: SQL): Promise<number>  // concrete: Number(res[0].count)
    abstract transaction<T>(transaction, config?): Promise<T>;
}
```

The base `execute` shows the minimal path a raw `db.execute(sql\`...\`)` takes:
```ts
execute<T>(query: SQL, token?): Promise<T> {
    const prepared = this.prepareQuery<PreparedQueryConfig & { execute: T }>(
        this.dialect.sqlToQuery(query), undefined, undefined, false);
    return prepared.setToken(token).execute(undefined, token);
}
```

`PgTransaction<...>` extends `PgDatabase` (so a tx has the same `.select/.insert/...` surface) and
adds `rollback()`, `getTransactionConfigSQL(config)`, `setTransaction(config)`, and an abstract
nested `transaction()`.

Result-type plumbing uses an HKT interface:
```ts
export interface PgQueryResultHKT { readonly $brand: 'PgQueryResultHKT'; readonly row: unknown; readonly type: unknown; }
export type PgQueryResultKind<TKind, TRow> = (TKind & { readonly row: TRow })['type'];
```
node-postgres binds it to pg's `QueryResult`:
```ts
export interface NodePgQueryResultHKT extends PgQueryResultHKT { type: QueryResult<Assume<this['row'], QueryResultRow>>; }
```
For Firebird we define a `FirebirdQueryResultHKT` whose `type` is whatever the Firebird driver returns
for a non-select statement (e.g. `{ rowsAffected: number }` or `[]`).

### Concrete implementation (node-postgres/session.ts) — the template to copy

`NodePgSession.prepareQuery` just forwards constructor args:
```ts
prepareQuery<T>(query, fields, name, isResponseInArrayMode, customResultMapper, queryMetadata, cacheConfig): PgPreparedQuery<T> {
    return new NodePgPreparedQuery(this.client, query.sql, query.params, this.logger, this.cache,
        queryMetadata, cacheConfig, fields, name, isResponseInArrayMode, customResultMapper);
}
```

`NodePgPreparedQuery.execute` — the heart of row mapping:
```ts
async execute(placeholderValues = {}): Promise<T['execute']> {
    const params = fillPlaceholders(this.params, placeholderValues);
    this.logger.logQuery(this.rawQueryConfig.text, params);
    const { fields, rawQueryConfig: rawQuery, client, queryConfig: query, joinsNotNullableMap, customResultMapper } = this;

    // No field mapping needed (e.g. raw db.execute, or a mutation w/o returning): return driver result as-is
    if (!fields && !customResultMapper) {
        return this.queryWithCache(rawQuery.text, params, async () => client.query(rawQuery, params));
    }

    // Field mapping needed: run in ARRAY row-mode, then map each row array → object
    const result = await this.queryWithCache(query.text, params, async () => client.query(query, params));
    return customResultMapper
        ? customResultMapper(result.rows)
        : result.rows.map((row) => mapResultRow<T['execute']>(fields!, row, joinsNotNullableMap));
}
```

Two query configs are prepared in the constructor: `rawQueryConfig` (object row-mode, used when no
mapping) and `queryConfig` with `rowMode: 'array'` (used when we must map). **Why array mode:**
`mapResultRow` (utils.ts:15) indexes `row[columnIndex]` positionally against the ordered
`SelectedFieldsOrdered` list and runs each column's `decoder.mapFromDriverValue`, assembling the
nested result object by `path`. So the Firebird prepared query must be able to return rows **as
positional arrays** in the same column order as the SELECT list.

`all()`: `client.query(rawQueryConfig, params).then(r => r.rows)` (object rows, no mapping).
`isResponseInArrayMode()` returns the `_isResponseInArrayMode` flag passed in.

### Transactions (node-postgres/session.ts)

```ts
override async transaction<T>(transaction, config?): Promise<T> {
    const isPool = this.client instanceof Pool || ...;
    const session = isPool ? new NodePgSession(await this.client.connect(), ...) : this;
    const tx = new NodePgTransaction(this.dialect, session, this.schema);
    await tx.execute(sql`begin${config ? sql` ${tx.getTransactionConfigSQL(config)}` : undefined}`);
    try { const result = await transaction(tx); await tx.execute(sql`commit`); return result; }
    catch (error) { await tx.execute(sql`rollback`); throw error; }
    finally { if (isPool) (session.client as PoolClient).release(); }
}
```
Nested transactions use savepoints:
```ts
override async transaction<T>(transaction): Promise<T> {
    const savepointName = `sp${this.nestedIndex + 1}`;
    const tx = new NodePgTransaction(this.dialect, this.session, this.schema, this.nestedIndex + 1);
    await tx.execute(sql.raw(`savepoint ${savepointName}`));
    try { const r = await transaction(tx); await tx.execute(sql.raw(`release savepoint ${savepointName}`)); return r; }
    catch (err) { await tx.execute(sql.raw(`rollback to savepoint ${savepointName}`)); throw err; }
}
```

**Firebird transactions:** `begin/commit/rollback` and `SAVEPOINT`/`RELEASE SAVEPOINT`/`ROLLBACK TO
SAVEPOINT` all exist in Firebird, so the structure transfers. But many Firebird drivers manage
transactions via their own API (transaction handle objects) rather than by executing `begin`/`commit`
as SQL text. If our driver is API-based, override `transaction()` to call the driver's
`startTransaction/commit/rollback` and wrap savepoints via `sql.raw` (Firebird accepts savepoint SQL).
`getTransactionConfigSQL` (pg-core/session.ts:261) builds isolation-level text — Firebird's isolation
syntax differs (`SET TRANSACTION ISOLATION LEVEL SNAPSHOT | READ COMMITTED`, `WAIT/NO WAIT`), so
reimplement it if we support tx config.

---

## 5. Column builders + types — `pg-core/columns/`

### Two base layers

`column-builder.ts` defines the dialect-agnostic base `ColumnBuilder` (build-time config accumulator)
and `column.ts` defines the runtime `Column` (the value mapper). Per-dialect layers subclass both.

Base `ColumnBuilder` (column-builder.ts:185) — constructor + fluent config methods:
```ts
constructor(name: T['name'], dataType: T['dataType'], columnType: T['columnType']) {
    this.config = { name, keyAsName: name === '', notNull: false, default: undefined,
        hasDefault: false, primaryKey: false, isUnique: false, uniqueName: undefined,
        uniqueType: undefined, dataType, columnType, generated: undefined } as ...;
}
// fluent: $type(), notNull(), default(v), $defaultFn(fn)/$default, $onUpdateFn(fn)/$onUpdate,
//         primaryKey(), abstract generatedAlwaysAs(...), setName(name)
```

Base runtime `Column` (column.ts:63) — reads config into readonly fields and defines the mapper API:
```ts
abstract class Column<T, ...> implements DriverValueMapper<T['data'], T['driverParam']>, SQLWrapper {
    constructor(readonly table: Table, config: ColumnRuntimeConfig<...>) { /* copies name, notNull, default, ... */ }
    abstract getSQLType(): string;
    mapFromDriverValue(value: unknown): unknown { return value; }   // DB → JS
    mapToDriverValue(value: unknown): unknown   { return value; }   // JS → DB
    shouldDisableInsert(): boolean { return this.config.generated !== undefined && this.config.generated.type !== 'byDefault'; }
}
```
(`Column.prototype.getSQL` is patched in sql/sql.ts:710 to `new SQL([this])`.)

### Pg layer (pg-core/columns/common.ts)

`PgColumnBuilder extends ColumnBuilder` adds pg-specific fluent methods: `.array()`, `.references()`,
`.unique()`, `.generatedAlwaysAs()`, `buildForeignKeys()`, and the abstract:
```ts
abstract build<TTableName extends string>(table: AnyPgTable<{ name: TTableName }>): PgColumn<MakeColumnConfig<T, TTableName>>;
buildExtraConfigColumn(table): ExtraConfigColumn { return new ExtraConfigColumn(table, this.config); }
```
`PgColumn extends Column` mostly just sets `uniqueName` default in its constructor.

### A concrete type is ~50 lines. Anatomy (integer.ts):

```ts
export class PgIntegerBuilder<T> extends PgIntColumnBaseBuilder<T> {
    static override readonly [entityKind]: string = 'PgIntegerBuilder';
    constructor(name: T['name']) { super(name, 'number', 'PgInteger'); }
    override build<TTableName>(table): PgInteger<MakeColumnConfig<T, TTableName>> {
        return new PgInteger(table, this.config as ColumnBuilderRuntimeConfig<any, any>);
    }
}
export class PgInteger<T> extends PgColumn<T> {
    static override readonly [entityKind]: string = 'PgInteger';
    getSQLType(): string { return 'integer'; }
    override mapFromDriverValue(value: number | string): number {
        if (typeof value === 'string') return Number.parseInt(value);
        return value;
    }
}
export function integer(): PgIntegerBuilderInitial<''>;
export function integer<TName extends string>(name: TName): PgIntegerBuilderInitial<TName>;
export function integer(name?: string) { return new PgIntegerBuilder(name ?? ''); }
```

So **each column type = a Builder subclass (sets `dataType`/`columnType`, implements `build()`),
a Column subclass (implements `getSQLType()` and optionally the two mappers), and a factory
function**. `getSQLType()` returns the DDL type string (used by drizzle-kit; not needed for runtime
querying). `mapToDriverValue`/`mapFromDriverValue` convert between JS and driver representations.

Examples of the mapper pattern:
- `boolean.ts`: `getSQLType(){ return 'boolean' }`, no mappers (pg driver handles booleans).
- `varchar.ts`: `getSQLType(){ return length===undefined ? 'varchar' : \`varchar(${length})\` }`.
  Config carries `length` + `enum` (validated only at type level).
- `timestamp.ts`: `getSQLType(){ return \`timestamp${precision}${withTimezone ? ' with time zone' : ''}\` }`;
  `mapToDriverValue = (value: Date) => value.toISOString();`
  `mapFromDriverValue(value){ return typeof value === 'string' ? new Date(withTimezone ? value : value+'+0000') : value; }`

### Firebird column set to implement (map to Firebird SQL types)

| factory | `getSQLType()` | notes |
|---|---|---|
| `integer`/`int` | `integer` | Firebird INTEGER (32-bit) |
| `smallint` | `smallint` | |
| `bigint` | `bigint` | Firebird BIGINT (int64). Decide `data: number|bigint` + mappers. |
| `float`/`doublePrecision` | `double precision` | |
| `numeric`/`decimal` | `numeric(p,s)` | Firebird `NUMERIC`/`DECIMAL`; often returned as string → `mapFromDriverValue` parse. |
| `char` | `char(n)` | fixed CHAR |
| `varchar` | `varchar(n)` | Firebird requires a length for VARCHAR in DDL. |
| `blobText`/`text` | `blob sub_type text` | Firebird TEXT is BLOB SUB_TYPE 1; driver may hand back a stream → mapper needed. |
| `blob` | `blob sub_type binary` | binary BLOB → Buffer. |
| `boolean` | `boolean` | FB3+ has native BOOLEAN. |
| `date` | `date` | |
| `time` | `time` | |
| `timestamp` | `timestamp` | Firebird TIMESTAMP has no TZ; drop `with time zone`. |

The **charset NONE `€` requirement** (from project memory) is relevant here: text column mappers must
respect the connection charset; do not assume UTF-8 round-trips for CHARSET NONE columns.

For serial/identity: Firebird uses generators/sequences + `GENERATED BY DEFAULT AS IDENTITY` (FB3+)
or triggers. This affects `getSQLType()`/DDL only; at query runtime a Firebird "serial" is just an
integer column with `hasDefault: true` and `shouldDisableInsert()`-style behavior when the generator
fills it.

---

## 6. Table definition — `pg-core/table.ts` (`pgTable`)

`PgTable extends Table` (base `table.ts`), adding pg-only internal symbols (`InlineForeignKeys`,
`EnableRLS`). The base `Table` (table.ts:49) stores everything under `Symbol.for('drizzle:...')`
keys, exposed via `Table.Symbol`: `Name`, `Schema`, `OriginalName`, `Columns`, `ExtraConfigColumns`,
`BaseName`, `IsAlias`, `ExtraConfigBuilder`. Constructor: `constructor(name, schema, baseName)`.

The factory `pgTableWithSchema` is the reusable pattern:
```ts
export function pgTableWithSchema(name, columns, extraConfig, schema, baseName = name) {
    const rawTable = new PgTable(name, schema, baseName);
    const parsedColumns = typeof columns === 'function' ? columns(getPgColumnBuilders()) : columns;
    const builtColumns = Object.fromEntries(Object.entries(parsedColumns).map(([name, colBuilderBase]) => {
        const colBuilder = colBuilderBase as PgColumnBuilder;
        colBuilder.setName(name);                              // key becomes column name if none given
        const column = colBuilder.build(rawTable);             // Builder → Column
        rawTable[InlineForeignKeys].push(...colBuilder.buildForeignKeys(column, rawTable));
        return [name, column];
    })) as ...;
    const table = Object.assign(rawTable, builtColumns);       // columns become own props: table.id, table.name
    table[Table.Symbol.Columns] = builtColumns;
    table[Table.Symbol.ExtraConfigColumns] = builtColumnsForExtraConfig;
    if (extraConfig) table[PgTable.Symbol.ExtraConfigBuilder] = extraConfig as any;
    return Object.assign(table, { enableRLS: () => { ...; return table; } });
}
export const pgTable: PgTableFn = (name, columns, extraConfig) => pgTableWithSchema(name, columns, extraConfig, undefined);
```

**Firebird**: implement `FirebirdTable extends Table` (probably no extra symbols needed — no RLS),
and a `firebirdTable(name, columns, extraConfig?)` that mirrors `pgTableWithSchema` minus RLS/inline-FK
if we defer constraints. Firebird has **no schemas** (no `search_path`), so `schema` should always be
`undefined` and we can drop the schema-qualified name branches. The core loop
(`setName → build → assign columns as own props → store in Columns symbol`) is mandatory — query
builders read `table[Table.Symbol.Columns]` and column objects off the table.

---

## 7. The MINIMUM viable dialect — smallest set of files/classes

To support `select` (where/orderBy/limit/offset), `insert (+returning)`, `update (+returning)`,
`delete (+returning)`, and `db.execute(sql\`...\`)`:

**Must implement (new files):**
1. `dialect.ts` — `FirebirdDialect` with: `casing`, `escapeName` (copy pg), `escapeParam`→`'?'`,
   `escapeString` (copy pg), `sqlToQuery` (copy pg), `prepareTyping`→`'none'`, `buildSelectQuery`
   (copy pg but **FIRST/SKIP after `select`, no trailing limit/offset**, and `distinct` as bool only),
   `buildInsertQuery` (copy pg, drop `overriding`/`on conflict`), `buildUpdateQuery` (copy pg, drop
   `from`/`joins`), `buildUpdateSet` (copy pg verbatim), `buildDeleteQuery` (copy pg verbatim),
   `buildSelection`/`buildJoins`/`buildFromTable`/`buildWithCTE` (copy pg — needed by the above).
2. `session.ts` — abstract `FirebirdSession` + `FirebirdPreparedQuery` (copy pg-core/session.ts
   shape: `prepareQuery`, base `execute/all/count`, abstract `transaction`; PreparedQuery abstract
   `execute/all/isResponseInArrayMode`, and `queryWithCache` can be a pass-through initially).
3. `db.ts` — `FirebirdDatabase` (copy pg-core/db.ts: `.select/.selectDistinct/.update/.insert/
   .delete/.execute/.transaction/.with/.$with/.$count`; drop `refreshMaterializedView`, RLS).
   The relational `query` getter can stay `{}`.
4. Driver adapter: `<driver>/driver.ts` (`drizzle()` + `construct()` + `FirebirdDriver`) and
   `<driver>/session.ts` (concrete `FirebirdSession`/`FirebirdPreparedQuery` over the real client —
   the §8 seam).
5. `table.ts` — `FirebirdTable` + `firebirdTable()`.
6. `columns/` — base `common.ts` (`FirebirdColumnBuilder`/`FirebirdColumn`) + the ~13 concrete types
   in §5.
7. Query builders — the simplest path is to **reuse pg-core's query builders wholesale** since they
   only depend on the dialect through the methods in §2 and on `session.prepareQuery`. If we want
   `@fast-firebird/drizzle` self-contained, copy `query-builders/{select,insert,update,delete,
   query-builder}.ts` and `select.types.ts`, swapping the `Pg` types for `Firebird` ones. This is
   mechanical.
8. `index.ts` re-exports.

**Config objects the builders hand to the dialect** (must exist / match field names): `PgSelectConfig`
(select.types.ts:52 — `withList, fields, fieldsFlat, where, having, table, joins, orderBy, groupBy,
limit, offset, lockingClause, distinct, setOperators`), `PgInsertConfig`, `PgUpdateConfig`,
`PgDeleteConfig`. Keep the same field names so copied builders work unchanged.

**Can be deferred (and how to stub so construction doesn't break):**
- **Relational queries** (`db.query.*` + `buildRelationalQueryWithoutPK`): don't pass a `schema`, or
  leave the method throwing. `db.query` stays `{}`. Not reached at construction.
- **Set operators** (union/intersect/except): `setOperators: []` default; `buildSetOperations` can
  throw. Not reached unless `.union()` etc. is called.
- **Views / materialized views**: omit `refreshMaterializedView`, `pgView`. No stub needed.
- **Prepared-statement caching**: `PgPreparedQuery.queryWithCache` — pass a `NoopCache` (cache
  undefined path just runs the query). Implement `.prepare(name)` as a no-op returning the same
  prepared object.
- **Migrations** (`dialect.migrate`, migrator.ts): omit entirely; drizzle-kit is separate.
- **`onConflict` / upsert**: leave `config.onConflict` undefined; don't expose the methods.
- **`$count`**: base `session.count(sql)` does `Number(res[0].count)` — needs a `select count(*)`;
  works once select works.
- **Locking clause** (`FOR UPDATE`): pg emits `for update ...`; Firebird uses `WITH LOCK`. Defer;
  leave `lockingClause` unhandled (undefined → `sql.empty()`).

---

## 8. The node-postgres adapter seam — the exact code we mirror

This is the entire "convert drizzle's query to driver calls" boundary. From
`node-postgres/session.ts`, `NodePgPreparedQuery`:

Constructor receives `query.sql` (the built string with `$1..$n` — for us `?`) and `query.params`,
and prebuilds two pg query configs:
```ts
this.rawQueryConfig = { name, text: queryString, types: { getTypeParser: (typeId, format) => { ... } } };
this.queryConfig    = { name, text: queryString, rowMode: 'array', types: { getTypeParser: ... } };
```
`execute` — the seam (mutations/raw return the driver result object; selects map array-rows):
```ts
const params = fillPlaceholders(this.params, placeholderValues);
this.logger.logQuery(this.rawQueryConfig.text, params);
if (!fields && !customResultMapper) {
    return this.queryWithCache(rawQuery.text, params, async () => await client.query(rawQuery, params));
}
const result = await this.queryWithCache(query.text, params, async () => await client.query(query, params));
return customResultMapper
    ? customResultMapper(result.rows)
    : result.rows.map((row) => mapResultRow<T['execute']>(fields!, row, joinsNotNullableMap));
```
`all`:
```ts
return this.queryWithCache(this.rawQueryConfig.text, params, async () =>
    this.client.query(this.rawQueryConfig, params)).then((result) => result.rows);
```

`NodePgClient = pg.Pool | PoolClient | Client`; the only method drizzle calls on it is
`client.query(configOrText, params)`, expecting `{ rows, ... }`. mysql2 does the analogous thing with
`client.query({ sql, values, rowsAsArray: true })` / `client.execute(sql, params)` returning
`[rows]`.

**Firebird mapping of this seam** — the concrete `FirebirdPreparedQuery.execute` must:
1. `const params = fillPlaceholders(this.params, placeholderValues);`
2. log via `this.logger.logQuery(sql, params)`.
3. Call the Firebird driver. For `node-firebird` (callback-based) wrap in a Promise:
   `db.query(sql, params, (err, rows) => ...)` returns **arrays of objects**; for row mapping we need
   **positional arrays** in SELECT-list order — either request array rows if the driver supports it,
   or convert `Object.values(row)` **carefully in column order** (safer: map by the known field names
   from `SelectedFieldsOrdered`). For `node-firebird-driver-native`, use
   `attachment.executeQuery(transaction, sql, params)` → `resultSet.fetch()` which yields arrays.
4. If `!fields && !customResultMapper` (raw exec / mutation without returning): return the driver's
   result (row count / statement type) as the `FirebirdQueryResultHKT.type`.
5. Otherwise: `rows.map(row => mapResultRow(fields, rowAsArray, joinsNotNullableMap))`.

The critical contract to preserve: **`params` are positional and already mapped; the result rows fed
to `mapResultRow` must be positional arrays aligned with the ordered `fields` list.** That alignment
is the one place a Firebird driver's row shape (objects vs arrays) matters.

---

## 9. Casing, and the biggest risk

`casing.getColumnCasing(col)` (from `~/casing.ts`, configured by `drizzle({ casing })`) decides the
emitted column name (`snake_case`/`camelCase`/as-defined). `escapeName` then wraps it in `"..."`.

**Biggest risk / unknown — identifier case folding.** Postgres folds *unquoted* identifiers to
lower-case but drizzle always emits them **double-quoted**, which in both pg and Firebird makes them
**case-sensitive**. Firebird, however, folds unquoted identifiers to **UPPER**-case, and most existing
Firebird databases have UPPERCASE metadata (`ID`, `NAME`). If we quote a lowercase TS-derived name
(`"id"`) it will **not** match an existing uppercase column `ID` and queries will fail with "column
unknown". Options to resolve before writing much code: (a) default `casing` to emit upper-case names;
(b) don't quote identifiers at all (drop `escapeName` quoting) and let Firebird upper-fold — but then
mixed-case names break; (c) require users to declare exact DB names. This interacts with the CHARSET
NONE `€` requirement (byte-vs-char handling in text mappers). Decide the identifier-quoting/casing
policy first — it colors every generated statement.

---

## Summary — minimal implementation path & biggest risk

1. Copy pg-core's structure; the dialect never hits the DB, so only two components are truly new:
   a `FirebirdDialect` (SQL string builder) and a `FirebirdSession`/`FirebirdPreparedQuery` over the driver.
2. Dialect deltas vs pg: `escapeParam` → `?`; `buildSelectQuery` emits `FIRST n SKIP m` right after
   `select` (no trailing LIMIT/OFFSET); drop `overriding`/`on conflict`, `UPDATE...FROM`, `distinct on`.
3. Session seam mirrors node-postgres: `prepareQuery(dialect.sqlToQuery(sql) → {sql,params})` then
   `client.query(sql, params)`, feeding positional array rows to `mapResultRow(fields, row, joins)`.
4. Reuse (or mechanically copy) pg query builders + column builders; implement `firebirdTable` like
   `pgTableWithSchema` (schema always undefined) and ~13 column types with `getSQLType()`+mappers.
5. Defer relational queries (`buildRelationalQueryWithoutPK`, Postgres JSON aggregates), set operators,
   views, upserts, migrations, and prepared-statement caching (NoopCache) — none block construction.
6. Biggest risk/unknown: **identifier case-folding + quoting** — drizzle always double-quotes names
   (case-sensitive), but Firebird upper-folds unquoted metadata; pick the casing/quoting policy (and
   its CHARSET NONE interaction) before generating any SQL, or every query risks "column unknown".
