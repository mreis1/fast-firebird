import { sql } from 'drizzle-orm';
import { firebirdTable, integer, varchar } from '@fast-firebird/drizzle';
import type { ServerState } from './servers.ts';

/** Drizzle schema for the micro-benchmark table (created by raw DDL below). */
const BENCH_TABLE = firebirdTable('FF_DEMO_BENCH', {
  ID: integer('ID').primaryKey(),
  V: varchar('V', { length: 40 }),
});

export type Engine = 'core' | 'drizzle' | 'compat';

export interface QueryResult {
  engine: Engine;
  rows: Record<string, unknown>[];
  rowCount: number;
  ms: number;
  note?: string;
  error?: string;
}

/** Make a Firebird row JSON-safe: bigint→string, Buffer→preview, Date→ISO. */
export function serializeCell(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) {
    const head = v.subarray(0, 16).toString('hex');
    return { __blob: true, bytes: v.length, preview: head + (v.length > 16 ? '…' : '') };
  }
  if (v instanceof Date) return v.toISOString();
  return v;
}

function serializeRows(rows: unknown[]): Record<string, unknown>[] {
  return (rows ?? []).map((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(row)) out[k] = serializeCell(val);
      return out;
    }
    // array-mode row
    return { row: (row as unknown[]).map(serializeCell) };
  });
}

/** Run the same SQL through one of the three stacks and time it. */
export async function runQuery(
  state: ServerState,
  engine: Engine,
  sqlText: string,
  params: unknown[] = [],
  /** Lock-wait mode: true = wait, false = nowait, number = wait seconds. Core lane only. */
  txWait?: boolean | number,
): Promise<QueryResult> {
  const t0 = performance.now();
  try {
    let rows: unknown[] = [];
    let note: string | undefined;

    if (engine === 'core') {
      rows =
        txWait === undefined
          ? await state.pool.use((att) => att.query(sqlText, params as never[]))
          : await state.pool.use((att) => att.transaction((tx) => tx.query(sqlText, params as never[]), { wait: txWait }));
    } else if (engine === 'drizzle') {
      const res: any = await state.drizzle.execute(sql.raw(sqlText));
      rows = Array.isArray(res) ? res : (res?.rows ?? []);
      if (params.length) note = 'Drizzle lane runs raw SQL via db.execute(sql.raw(...)); params bind on the core/compat lanes.';
      else if (txWait !== undefined) note = 'Lock-wait options apply on the core lane; drizzle/compat run their own transaction defaults.';
    } else {
      const con = await state.ext.poolGet();
      try {
        const q = await con.queryP(sqlText, { params });
        rows = (await q.fetchAll()).results;
        await con.commitP();
      } finally {
        await state.ext.release(con);
      }
    }

    const serialized = serializeRows(rows);
    return { engine, rows: serialized, rowCount: serialized.length, ms: +(performance.now() - t0).toFixed(2), note };
  } catch (err) {
    return { engine, rows: [], rowCount: 0, ms: +(performance.now() - t0).toFixed(2), error: (err as Error).message.split('\n').slice(0, 3).join(' ') };
  }
}

export interface BenchLane {
  engine: Engine;
  /** N single-row parameterized inserts (ms). */
  insertMs: number | null;
  /** One aggregate select (ms). */
  selectMs: number;
  rows: number;
}

/**
 * Timed micro-benchmark. All three lanes bind parameters: core and compat run
 * `insert ... values (?, ?)`; the drizzle lane goes through the query builder
 * (`db.insert(...).values(...)`), which binds params via core underneath.
 */
export async function benchmark(state: ServerState, n: number): Promise<BenchLane[]> {
  const table = 'FF_DEMO_BENCH';
  // Release every metadata pin before the recreate: the pool's statement
  // caches, the drizzle attachment's cache, and the compat pool — its
  // connections cached bench statements from previous runs, so cycle it.
  await state.pool.clearStatementCaches();
  await state.drizzleAtt.clearStatementCache();
  await state.ext.stopPool().catch(() => void 0);
  await state.pool.use((att) => att.transaction((tx) => tx.execute(`recreate table ${table} (ID integer not null primary key, V varchar(40))`), { wait: 10 }));
  // Warm the compat pool back up so its first timed insert isn't a connect.
  await state.ext.release(await state.ext.poolGet());

  const lanes: BenchLane[] = [];
  let base = 0;
  for (const engine of ['core', 'compat', 'drizzle'] as Engine[]) {
    const t0 = performance.now();
    if (engine === 'drizzle') {
      for (let i = 0; i < n; i++) {
        await state.drizzle.insert(BENCH_TABLE).values({ ID: base + i + 1, V: `${engine}-${i}` });
      }
    } else {
      for (let i = 0; i < n; i++) {
        await runQuery(state, engine, `insert into ${table} (ID, V) values (?, ?)`, [base + i + 1, `${engine}-${i}`]);
      }
    }
    const insertMs = +(performance.now() - t0).toFixed(1);
    base += n;
    const t1 = performance.now();
    const res = await runQuery(state, engine, `select count(*) as C from ${table}`, []);
    lanes.push({ engine, insertMs, selectMs: +(performance.now() - t1).toFixed(1), rows: Number((res.rows[0] as any)?.C ?? 0) });
  }
  return lanes;
}
