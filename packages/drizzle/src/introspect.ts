import type { Attachment } from '@fast-firebird/core';

/**
 * RDB$ system-table introspection → Drizzle schema code generation.
 *
 * `introspectDatabase(att)` reads user tables (views and system tables are
 * skipped) into a structured model; `generateDrizzleSchema(tables)` emits a
 * ready-to-import TypeScript module of `firebirdTable` definitions.
 */

export interface IntrospectedColumn {
  /** Column name as stored (usually upper-case). */
  name: string;
  /** Friendly SQL type, e.g. `VARCHAR(60)`, `NUMERIC(9,2)`, `BLOB SUB_TYPE TEXT`. */
  sqlType: string;
  /** Drizzle builder call for codegen, e.g. `varchar('NAME', { length: 60 })`. */
  builder: string;
  nullable: boolean;
  identity: boolean;
  /** Raw `RDB$DEFAULT_SOURCE` (e.g. `DEFAULT 0`), when present. */
  defaultSource?: string;
}

export interface IntrospectedTable {
  name: string;
  columns: IntrospectedColumn[];
  /** Primary-key column names in index order (empty = no PK). */
  primaryKey: string[];
}

interface RawColumn {
  TBL: string;
  COL: string;
  NOTNULL: number | null;
  DOM_NOTNULL: number | null;
  IDENT: number | null;
  DEFSRC: string | null;
  FTYPE: number;
  FSUB: number | null;
  FSCALE: number | null;
  FPREC: number | null;
  FCHARS: number | null;
}

/** Map RDB$FIELDS metadata to (sqlType, drizzle builder, import used). */
function mapType(c: RawColumn): { sqlType: string; builder: (col: string) => string; imports: string[] } {
  const scale = -(c.FSCALE ?? 0);
  const sub = c.FSUB ?? 0;
  const prec = c.FPREC ?? 0;
  const numeric = (bits: string): { sqlType: string; builder: (col: string) => string; imports: string[] } => {
    if (scale > 0 || sub === 1 || sub === 2) {
      const name = sub === 2 ? 'DECIMAL' : 'NUMERIC';
      const fn = sub === 2 ? 'decimal' : 'numeric';
      return {
        sqlType: `${name}(${prec || 18},${scale})`,
        builder: (col) => `${fn}('${col}', { precision: ${prec || 18}, scale: ${scale} })`,
        imports: [fn],
      };
    }
    return bits === 'SMALLINT'
      ? { sqlType: 'SMALLINT', builder: (col) => `smallint('${col}')`, imports: ['smallint'] }
      : bits === 'INTEGER'
        ? { sqlType: 'INTEGER', builder: (col) => `integer('${col}')`, imports: ['integer'] }
        : { sqlType: bits, builder: (col) => `bigint('${col}', { mode: 'bigint' })`, imports: ['bigint'] };
  };
  switch (c.FTYPE) {
    case 7:
      return numeric('SMALLINT');
    case 8:
      return numeric('INTEGER');
    case 16:
      return numeric('BIGINT');
    case 26:
      return numeric('INT128'); // maps to bigint(mode bigint) when integral
    case 10:
      return { sqlType: 'FLOAT', builder: (col) => `real('${col}')`, imports: ['real'] };
    case 27:
      return { sqlType: 'DOUBLE PRECISION', builder: (col) => `doublePrecision('${col}')`, imports: ['doublePrecision'] };
    case 12:
      return { sqlType: 'DATE', builder: (col) => `date('${col}')`, imports: ['date'] };
    case 13:
      return { sqlType: 'TIME', builder: (col) => `time('${col}')`, imports: ['time'] };
    case 35:
      return { sqlType: 'TIMESTAMP', builder: (col) => `timestamp('${col}')`, imports: ['timestamp'] };
    case 28:
      return { sqlType: 'TIME WITH TIME ZONE', builder: (col) => `time('${col}') /* WITH TIME ZONE */`, imports: ['time'] };
    case 29:
      return {
        sqlType: 'TIMESTAMP WITH TIME ZONE',
        builder: (col) => `timestamp('${col}') /* WITH TIME ZONE */`,
        imports: ['timestamp'],
      };
    case 14:
      return {
        sqlType: `CHAR(${c.FCHARS ?? 1})`,
        builder: (col) => `char('${col}', { length: ${c.FCHARS ?? 1} })`,
        imports: ['char'],
      };
    case 37:
      return {
        sqlType: `VARCHAR(${c.FCHARS ?? 1})`,
        builder: (col) => `varchar('${col}', { length: ${c.FCHARS ?? 1} })`,
        imports: ['varchar'],
      };
    case 23:
      return { sqlType: 'BOOLEAN', builder: (col) => `boolean('${col}')`, imports: ['boolean'] };
    case 24:
      return { sqlType: 'DECFLOAT(16)', builder: (col) => `numeric('${col}') /* DECFLOAT(16) */`, imports: ['numeric'] };
    case 25:
      return { sqlType: 'DECFLOAT(34)', builder: (col) => `numeric('${col}') /* DECFLOAT(34) */`, imports: ['numeric'] };
    case 261:
      return sub === 1
        ? { sqlType: 'BLOB SUB_TYPE TEXT', builder: (col) => `blobText('${col}')`, imports: ['blobText'] }
        : { sqlType: 'BLOB SUB_TYPE BINARY', builder: (col) => `blob('${col}')`, imports: ['blob'] };
    default:
      return {
        sqlType: `UNKNOWN(${c.FTYPE})`,
        builder: (col) => `varchar('${col}') /* unmapped RDB$FIELD_TYPE ${c.FTYPE} */`,
        imports: ['varchar'],
      };
  }
}

/** Read all user tables (columns + primary keys) from RDB$ system tables. */
export async function introspectDatabase(att: Attachment): Promise<IntrospectedTable[]> {
  const cols = await att.query<RawColumn>(
    `select trim(rf.rdb$relation_name) as tbl,
            trim(rf.rdb$field_name) as col,
            rf.rdb$null_flag as notnull,
            f.rdb$null_flag as dom_notnull,
            rf.rdb$identity_type as ident,
            cast(rf.rdb$default_source as varchar(512)) as defsrc,
            f.rdb$field_type as ftype,
            f.rdb$field_sub_type as fsub,
            f.rdb$field_scale as fscale,
            f.rdb$field_precision as fprec,
            f.rdb$character_length as fchars
       from rdb$relation_fields rf
       join rdb$fields f on f.rdb$field_name = rf.rdb$field_source
       join rdb$relations r on r.rdb$relation_name = rf.rdb$relation_name
      where coalesce(r.rdb$system_flag, 0) = 0 and r.rdb$view_blr is null
      order by rf.rdb$relation_name, rf.rdb$field_position`,
  );
  const pks = await att.query<{ TBL: string; COL: string }>(
    `select trim(rc.rdb$relation_name) as tbl, trim(isg.rdb$field_name) as col
       from rdb$relation_constraints rc
       join rdb$index_segments isg on isg.rdb$index_name = rc.rdb$index_name
      where rc.rdb$constraint_type = 'PRIMARY KEY'
      order by rc.rdb$relation_name, isg.rdb$field_position`,
  );
  const pkMap = new Map<string, string[]>();
  for (const p of pks) {
    const list = pkMap.get(p.TBL) ?? [];
    list.push(p.COL);
    pkMap.set(p.TBL, list);
  }
  const tables = new Map<string, IntrospectedTable>();
  for (const c of cols) {
    let t = tables.get(c.TBL);
    if (!t) {
      t = { name: c.TBL, columns: [], primaryKey: pkMap.get(c.TBL) ?? [] };
      tables.set(c.TBL, t);
    }
    const m = mapType(c);
    t.columns.push({
      name: c.COL,
      sqlType: m.sqlType,
      builder: m.builder(c.COL),
      nullable: !(c.NOTNULL === 1 || c.DOM_NOTNULL === 1),
      identity: c.IDENT != null,
      defaultSource: c.DEFSRC?.trim() || undefined,
    });
  }
  return [...tables.values()];
}

/** `ORDER_ITEMS` → `orderItems`; falls back to the raw name when unusable. */
function camel(name: string): string {
  const parts = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (parts.length === 0) return name.toLowerCase();
  const out = parts[0] + parts.slice(1).map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
  return /^[a-z_$][\w$]*$/i.test(out) ? out : JSON.stringify(name);
}

/** Emit a TypeScript module of `firebirdTable` definitions. */
export function generateDrizzleSchema(tables: IntrospectedTable[]): string {
  const used = new Set<string>();
  const bodies: string[] = [];
  for (const t of tables) {
    const singlePk = t.primaryKey.length === 1 ? t.primaryKey[0] : null;
    const lines = t.columns.map((c) => {
      // Re-derive the import list from the builder's leading identifier.
      used.add(c.builder.split('(')[0]!.trim());
      let expr = c.builder;
      if (c.name === singlePk) expr += '.primaryKey()';
      if (!c.nullable && c.name !== singlePk) expr += '.notNull()';
      const notes: string[] = [];
      if (c.identity) notes.push('identity');
      if (c.defaultSource) notes.push(c.defaultSource);
      return `  ${camel(c.name)}: ${expr},${notes.length ? ` // ${notes.join('; ')}` : ''}`;
    });
    if (t.primaryKey.length > 1) {
      used.add('primaryKey');
      const cols = t.primaryKey.map((c) => `t.${camel(c)}`).join(', ');
      bodies.push(
        `export const ${camel(t.name)} = firebirdTable('${t.name}', {\n${lines.join('\n')}\n}, (t) => [primaryKey({ columns: [${cols}] })]);`,
      );
    } else {
      bodies.push(`export const ${camel(t.name)} = firebirdTable('${t.name}', {\n${lines.join('\n')}\n});`);
    }
  }
  const imports = ['firebirdTable', ...[...used].sort()].join(', ');
  return `// Generated by @fast-firebird/drizzle introspection — review before use.\nimport { ${imports} } from '@fast-firebird/drizzle';\n\n${bodies.join('\n\n')}\n`;
}
