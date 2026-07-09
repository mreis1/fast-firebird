import type {
  ColumnBaseConfig,
  ColumnBuilderBaseConfig,
  ColumnBuilderRuntimeConfig,
  MakeColumnConfig,
} from 'drizzle-orm';
import { PgColumn, PgColumnBuilder, type AnyPgTable } from 'drizzle-orm/pg-core';

/**
 * Firebird-specific column types. Unlike the reused pg columns, these avoid
 * pg's string-based value mapping: `@fast-firebird/core` round-trips Date and
 * Buffer natively, so these columns use IDENTITY mapping (no mapTo/From
 * overrides) and just declare the Firebird SQL type. `build` is `@internal` in
 * drizzle (stripped from its d.ts) so it carries no `override` modifier.
 */

// ── timestamp / date / time (JS Date both ways) ─────────────────────────────

type TemporalCfg<TName extends string> = {
  name: TName;
  dataType: 'date';
  columnType: 'FbTemporal';
  data: Date;
  driverParam: Date;
  enumValues: undefined;
};

// Named module-scope classes (an anonymous exported class with inherited
// private members can't be emitted to .d.ts — TS4094). The Firebird SQL type
// is a runtime field; timestamp/date/time differ only by it.
class FbTemporalColumn<T extends ColumnBaseConfig<'date', 'FbTemporal'>> extends PgColumn<T> {
  private readonly fbSqlType: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(table: AnyPgTable, config: any, sqlType: string) {
    super(table, config);
    this.fbSqlType = sqlType;
  }
  getSQLType(): string {
    return this.fbSqlType;
  }
}
class FbTemporalBuilder<T extends ColumnBuilderBaseConfig<'date', 'FbTemporal'>> extends PgColumnBuilder<T> {
  private readonly fbSqlType: string;
  constructor(name: T['name'], sqlType: string) {
    super(name, 'date', 'FbTemporal');
    this.fbSqlType = sqlType;
  }
  build<TTableName extends string>(table: AnyPgTable<{ name: TTableName }>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new FbTemporalColumn<MakeColumnConfig<T, TTableName>>(table, this.config as any, this.fbSqlType);
  }
}

export function timestamp<TName extends string>(name: TName = '' as TName) {
  return new FbTemporalBuilder<TemporalCfg<TName>>(name, 'timestamp');
}
export function date<TName extends string>(name: TName = '' as TName) {
  return new FbTemporalBuilder<TemporalCfg<TName>>(name, 'date');
}
export function time<TName extends string>(name: TName = '' as TName) {
  return new FbTemporalBuilder<TemporalCfg<TName>>(name, 'time');
}

// ── binary blob (Buffer both ways) ──────────────────────────────────────────

type BlobCfg<TName extends string> = {
  name: TName;
  dataType: 'buffer';
  columnType: 'FbBlob';
  data: Buffer;
  driverParam: Buffer;
  enumValues: undefined;
};

class FbBlob<T extends ColumnBaseConfig<'buffer', 'FbBlob'>> extends PgColumn<T> {
  getSQLType(): string {
    return 'blob sub_type binary';
  }
}
class FbBlobBuilder<T extends ColumnBuilderBaseConfig<'buffer', 'FbBlob'>> extends PgColumnBuilder<T> {
  constructor(name: T['name']) {
    super(name, 'buffer', 'FbBlob');
  }
  build<TTableName extends string>(table: AnyPgTable<{ name: TTableName }>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new FbBlob<MakeColumnConfig<T, TTableName>>(table, this.config as ColumnBuilderRuntimeConfig<any, any>);
  }
}
export function blob<TName extends string>(name: TName = '' as TName) {
  return new FbBlobBuilder<BlobCfg<TName>>(name);
}

// ── text blob (string both ways; subtype 1) ─────────────────────────────────

type BlobTextCfg<TName extends string> = {
  name: TName;
  dataType: 'string';
  columnType: 'FbBlobText';
  data: string;
  driverParam: string;
  enumValues: undefined;
};

class FbBlobText<T extends ColumnBaseConfig<'string', 'FbBlobText'>> extends PgColumn<T> {
  getSQLType(): string {
    return 'blob sub_type text';
  }
}
class FbBlobTextBuilder<T extends ColumnBuilderBaseConfig<'string', 'FbBlobText'>> extends PgColumnBuilder<T> {
  constructor(name: T['name']) {
    super(name, 'string', 'FbBlobText');
  }
  build<TTableName extends string>(table: AnyPgTable<{ name: TTableName }>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new FbBlobText<MakeColumnConfig<T, TTableName>>(table, this.config as ColumnBuilderRuntimeConfig<any, any>);
  }
}
export function blobText<TName extends string>(name: TName = '' as TName) {
  return new FbBlobTextBuilder<BlobTextCfg<TName>>(name);
}
