import type { ServerState } from './servers.ts';

/** Whitelisted column types — the UI picks from these; never raw SQL from the client. */
const TYPES = {
  integer: { sql: 'integer', gen: (i: number) => i },
  bigint: { sql: 'bigint', gen: (i: number) => BigInt(i) * 1000003n },
  'varchar(60)': { sql: 'varchar(60)', gen: (i: number) => `row-${i}-${'x'.repeat(20)}` },
  'numeric(12,2)': { sql: 'numeric(12,2)', gen: (i: number) => (((i * 137) % 1000000) / 100).toFixed(2) },
  'decfloat(34)': { sql: 'decfloat(34)', gen: (i: number) => `${i}.${(i % 997).toString().padStart(3, '0')}` },
  timestamp: { sql: 'timestamp', gen: (i: number) => new Date(Date.UTC(2024, 0, 1) + i * 1000) },
  boolean: { sql: 'boolean', gen: (i: number) => i % 2 === 0 },
  'blob binary': { sql: 'blob sub_type binary', gen: null },
  'blob text': { sql: 'blob sub_type text', gen: null },
} as const;

export type BenchColumnType = keyof typeof TYPES;

export interface BenchColumn {
  name: string;
  type: BenchColumnType;
  /** For blob columns: the picked file's content (base64). */
  dataBase64?: string;
}

export interface CustomBenchRequest {
  columns: BenchColumn[];
  rows: number;
  /** Lock-wait mode for the DDL transaction: true = wait, false = nowait, number = wait seconds. */
  ddlWait?: boolean | number;
  /**
   * Fetch across N pooled connections (ID-range partitions via pool.map).
   * 1 = single connection (default). On links where a single TCP stream is
   * window- or path-limited, parallel connections multiply throughput —
   * if they don't, the bottleneck is raw bandwidth.
   */
  fetchConnections?: number;
}

export interface CustomBenchResult {
  table: string;
  ddl: string;
  rows: number;
  fetchConnections: number;
  insertMs: number;
  insertRowsPerSec: number;
  fetchMs: number;
  fetchRowsPerSec: number;
  fetchedRows: number;
  blobBytesPerRow: number;
  totalBlobBytes: number;
  blobThroughputMBps: number | null;
  error?: string;
}

const DEFAULT_BLOB = Buffer.alloc(64 * 1024, 0xa7); // 64 KiB when no file picked

function sanitizeName(name: string, idx: number): string {
  const clean = name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 28);
  return clean || `COL_${idx}`;
}

/**
 * Structure-driven benchmark: recreate a table from the user's column layout,
 * insert N generated rows (one transaction, statement-cache reuse — the
 * realistic bulk-load shape), then fetch them all back with eager blob
 * materialization. DECFLOAT/text/binary values ride the native write paths.
 */
export async function runCustomBench(state: ServerState, req: CustomBenchRequest): Promise<CustomBenchResult> {
  const rows = Math.min(50_000, Math.max(1, Math.floor(req.rows) || 1));
  const cols = (req.columns ?? []).slice(0, 12).map((c, i) => {
    const spec = TYPES[c.type];
    if (!spec) throw new Error(`Unknown column type: ${c.type}`);
    const blob = spec.gen === null ? (c.dataBase64 ? Buffer.from(c.dataBase64, 'base64') : DEFAULT_BLOB) : null;
    return { name: sanitizeName(c.name, i), sql: spec.sql, gen: spec.gen, blob, isText: c.type === 'blob text' };
  });
  if (cols.length === 0) throw new Error('At least one column is required');

  const table = 'FF_CUSTOM_BENCH';
  const ddl = `recreate table ${table} (\n  ID integer not null primary key,\n${cols.map((c) => `  ${c.name} ${c.sql}`).join(',\n')}\n)`;
  const insertSql = `insert into ${table} (ID, ${cols.map((c) => c.name).join(', ')}) values (?${', ?'.repeat(cols.length)})`;

  const blobBytesPerRow = cols.reduce((n, c) => n + (c.blob ? c.blob.length : 0), 0);

  const fetchConnections = Math.min(8, Math.max(1, Math.floor(req.fetchConnections ?? 1)));

  // Cached prepared statements (previous runs, SQL-runner queries) pin the
  // table's metadata — release them pool-wide or the recreate fails with
  // "object FF_CUSTOM_BENCH is in use".
  await state.pool.clearStatementCaches();

  // ── DDL + insert benchmark: one connection, one transaction ──────────────
  const insertMs = await state.pool.use(async (att) => {
    // Default: wait up to 10s for stragglers (e.g. another tool holding a
    // prepared statement) instead of failing instantly on nowait.
    await att.transaction((tx) => tx.execute(ddl), { wait: req.ddlWait ?? 10 });

    const t0 = performance.now();
    await att.transaction(async (tx) => {
      for (let i = 0; i < rows; i++) {
        const params = [i, ...cols.map((c) => (c.blob ? (c.isText ? c.blob.toString('utf8') : c.blob) : c.gen!(i)))];
        await tx.execute(insertSql, params as never[]);
      }
    });
    return +(performance.now() - t0).toFixed(1);
  });

  // ── fetch benchmark: full scan incl. eager blob materialization ──────────
  // Optionally partitioned by ID stripes across N pooled connections — a
  // per-connection TCP window multiplies out; a bandwidth ceiling doesn't.
  const t1 = performance.now();
  let fetchedRows: number;
  if (fetchConnections <= 1) {
    fetchedRows = (await state.pool.use((att) => att.query(`select * from ${table}`))).length;
  } else {
    const per = Math.ceil(rows / fetchConnections);
    const parts = Array.from({ length: fetchConnections }, (_, i) => [i * per, Math.min(rows, (i + 1) * per) - 1] as const).filter(
      ([lo, hi]) => lo <= hi,
    );
    const chunks = await state.pool.map(parts, (att, [lo, hi]) =>
      att.query(`select * from ${table} where ID between ? and ?`, [lo, hi]),
    );
    fetchedRows = chunks.reduce((n, c) => n + c.length, 0);
  }
  const fetchMs = +(performance.now() - t1).toFixed(1);

  const totalBlobBytes = blobBytesPerRow * rows;
  return {
    table,
    ddl,
    rows,
    fetchConnections,
    insertMs,
    insertRowsPerSec: Math.round((rows / Math.max(1, insertMs)) * 1000),
    fetchMs,
    fetchRowsPerSec: Math.round((fetchedRows / Math.max(1, fetchMs)) * 1000),
    fetchedRows,
    blobBytesPerRow,
    totalBlobBytes,
    blobThroughputMBps: blobBytesPerRow > 0 ? +(totalBlobBytes / 1024 / 1024 / (fetchMs / 1000)).toFixed(1) : null,
  };
}
