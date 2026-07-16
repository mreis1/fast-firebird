import { connect as ffConnect, type Attachment, type ConnectInput } from '@fast-firebird/core';
import { LatencyProxy } from './latency-proxy.js';
import { fastFirebird, nodeFirebird, type BenchConn, type BenchDriver } from './drivers.js';

/**
 * fast-firebird vs node-firebird under simulated network latency.
 * Target: the isolated fast-firebird-test-fb5 container. Latency is injected
 * by an in-process TCP proxy (one-way delay; RTT ≈ 2×delay).
 *
 * Run: pnpm --filter @fast-firebird/benchmarks bench
 */

const FB_HOST = '127.0.0.1';
const FB_PORT = 30505;
const DATABASE = '/var/lib/firebird/data/test.fdb';
const DELAYS_MS = [0, 2, 10];

interface Scenario {
  name: string;
  ops: number;
  run(conn: BenchConn): Promise<void>;
  /** Scenarios that manage their own connections (connect storm). */
  standalone?: (driver: BenchDriver, host: string, port: number) => Promise<void>;
}

const BLOB_1MB = Buffer.alloc(1_048_576);
for (let i = 0; i < BLOB_1MB.length; i++) BLOB_1MB[i] = (i * 31) & 0xff;

// Many-small-blobs workload: 300 rows × 8 KB — the "table of memos/documents"
// shape where per-blob round trips dominate. 8 KB fits FB5's inline-blob
// limit (≤ 64 KB), so fast-firebird's default config fetches these with ZERO
// blob round trips on protocol 19.
const MEMO_COUNT = 300;
const MEMO_SIZE = 8_000;
const MEMO_BYTES = MEMO_COUNT * MEMO_SIZE;

function scenarios(version: number): Scenario[] {
  return [
    {
      name: 'connect+detach ×10',
      ops: 10,
      run: async () => {},
      standalone: async (driver, host, port) => {
        for (let i = 0; i < 10; i++) {
          const c = await connectWithRetry(driver, host, port);
          await c.close();
        }
      },
    },
    {
      name: 'warm 1-row select ×200',
      ops: 200,
      run: async (conn) => {
        for (let i = 0; i < 200; i++) {
          await conn.query('select name from bench_rows where id = ?', [(i % 1000) + 1]);
        }
      },
    },
    {
      name: 'warm select ×200 (open tx)',
      ops: 200,
      run: async (conn) => {
        const paramSets = Array.from({ length: 200 }, (_, i) => [(i % 1000) + 1]);
        await conn.queryLoopInTx('select name from bench_rows where id = ?', paramSets);
      },
    },
    {
      name: 'scan 10k rows ×3',
      ops: 3,
      run: async (conn) => {
        for (let i = 0; i < 3; i++) {
          await conn.query('select id, name, val from bench_rows');
        }
      },
    },
    {
      name: 'insert 300 rows (1 tx)',
      ops: 300,
      run: async (conn) => {
        await conn.execute(`delete from bench_ins_${version}`);
        const rows = Array.from({ length: 300 }, (_, i) => [i + 1, `name-${i}`, i / 7]);
        await conn.insertMany(`insert into bench_ins_${version} (id, name, val) values (?,?,?)`, rows);
      },
    },
    {
      name: 'blob 1MB write+read ×3',
      ops: 3,
      run: async (conn) => {
        for (let i = 0; i < 3; i++) {
          const n = await conn.blobRoundTrip(`bench_blob_${version}`, 1, BLOB_1MB);
          if (n !== BLOB_1MB.length) throw new Error(`blob size mismatch: ${n}`);
        }
      },
    },
    {
      name: `scan ${MEMO_COUNT}×8KB blobs`,
      ops: MEMO_COUNT,
      run: async (conn) => {
        const n = await conn.blobScan(`bench_memos_${version}`);
        if (n !== MEMO_BYTES) throw new Error(`blob scan bytes mismatch: ${n}`);
      },
    },
  ];
}

async function setup(): Promise<void> {
  const db = await ffConnect({ host: FB_HOST, port: FB_PORT, database: DATABASE, user: 'SYSDBA', password: 'masterkey' });
  await db.execute(`recreate table bench_rows (id integer not null primary key, name varchar(50), val double precision)`);
  await db.execute(
    `insert into bench_rows (id, name, val)
     select first 10000 cast(row_number() over() as integer),
            'row name with some padding text ' || cast(row_number() over() as varchar(10)),
            cast(row_number() over() as double precision) / 3
     from rdb$types a, rdb$types b`,
  );
  await db.execute(`recreate table bench_ins_5 (id integer, name varchar(50), val double precision)`);
  await db.execute(`recreate table bench_blob_5 (id integer not null primary key, data blob)`);
  await db.execute(`recreate table bench_memos_5 (id integer not null primary key, data blob)`);
  await db.transaction(async (tx) => {
    for (let i = 1; i <= MEMO_COUNT; i++) {
      await tx.execute(`insert into bench_memos_5 (id, data) values (?, ?)`, [i, Buffer.alloc(MEMO_SIZE, i & 0xff)]);
    }
  });
  await db.disconnect();
}

interface Result {
  driver: string;
  delay: number;
  scenario: string;
  ms: number;
  opsPerSec: number;
  roundTrips: number | null;
}

// ── fast-firebird blob strategies (same workload, four fetch plans) ─────────
// Isolates WHERE the blob speedup comes from: FB5 inline blobs (zero blob RTs),
// pipelined eager materialization, and queryStream read-ahead vs on-demand.

interface BlobStrategy {
  name: string;
  /** Extra connect options (inline blobs are ON by default on FB5). */
  connectOpts: Partial<ConnectInput>;
  run(db: Attachment): Promise<number>;
}

async function memoScanEager(db: Attachment): Promise<number> {
  const rows = await db.query('select id, data from bench_memos_5 order by id');
  let total = 0;
  for (const row of rows) total += (row.DATA as Buffer).length;
  return total;
}

async function memoScanStream(db: Attachment, readAhead: boolean, workMsPerRow = 0): Promise<number> {
  let total = 0;
  for await (const row of db.queryStream('select id, data from bench_memos_5 order by id', [], {
    blobs: 'lazy',
    ...(readAhead ? { blobReadAhead: true } : {}),
  })) {
    total += (await (row.DATA as { buffer(): Promise<Buffer> }).buffer()).length;
    // Simulated per-row consumer work (disk write, image resize, HTTP call) —
    // the window blobReadAhead is designed to hide blob round trips behind.
    if (workMsPerRow > 0) await new Promise((r) => setTimeout(r, workMsPerRow));
  }
  return total;
}

const WORK_MS = 10;

function blobStrategies(): BlobStrategy[] {
  return [
    { name: 'eager + FB5 inline (default)', connectOpts: {}, run: memoScanEager },
    { name: 'eager, inline off (pipelined)', connectOpts: { maxInlineBlobSize: 0 }, run: memoScanEager },
    { name: 'stream lazy, on-demand', connectOpts: { maxInlineBlobSize: 0 }, run: (db) => memoScanStream(db, false) },
    { name: 'stream lazy + blobReadAhead', connectOpts: { maxInlineBlobSize: 0 }, run: (db) => memoScanStream(db, true) },
    // Read-ahead does NOT cut round trips — it overlaps them with consumer
    // work. With zero work per row the two stream rows above tie; the pair
    // below shows the effect with a realistic consumer.
    {
      name: `stream on-demand + ${WORK_MS}ms/row work`,
      connectOpts: { maxInlineBlobSize: 0 },
      run: (db) => memoScanStream(db, false, WORK_MS),
    },
    {
      name: `stream readAhead + ${WORK_MS}ms/row work`,
      connectOpts: { maxInlineBlobSize: 0 },
      run: (db) => memoScanStream(db, true, WORK_MS),
    },
  ];
}

interface BlobResult {
  strategy: string;
  delay: number;
  ms: number;
  roundTrips: number;
}

async function runBlobMatrix(): Promise<BlobResult[]> {
  const results: BlobResult[] = [];
  for (const delay of DELAYS_MS) {
    const proxy = new LatencyProxy(FB_HOST, FB_PORT, delay);
    const port = await proxy.listen();
    try {
      for (const st of blobStrategies()) {
        const db = await ffConnect({
          host: FB_HOST,
          port,
          database: DATABASE,
          user: 'SYSDBA',
          password: 'masterkey',
          ...st.connectOpts,
        });
        try {
          await db.query('select 1 as one from rdb$database'); // settle the connection
          const rt0 = db.roundTrips;
          const t0 = process.hrtime.bigint();
          const n = await st.run(db);
          const ms = Number(process.hrtime.bigint() - t0) / 1e6;
          if (n !== MEMO_BYTES) throw new Error(`${st.name}: byte mismatch ${n}`);
          const roundTrips = db.roundTrips - rt0;
          results.push({ strategy: st.name, delay, ms, roundTrips });
          console.log(`  [${delay}ms] ${st.name.padEnd(30)} ${ms.toFixed(0).padStart(7)} ms  (${roundTrips} RTs)`);
        } finally {
          await db.disconnect();
        }
      }
    } finally {
      await proxy.close();
    }
  }
  return results;
}

/**
 * node-firebird's SRP intermittently fails (~1/128 handshakes — the padded
 * scramble bug documented in plans/research errata); retry so the benchmark
 * survives it. Retries are counted and reported.
 */
let connectRetries = 0;
async function connectWithRetry(driver: BenchDriver, host: string, port: number): Promise<BenchConn> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await driver.connect(host, port, DATABASE);
    } catch (err) {
      if (attempt >= 5) throw err;
      connectRetries++;
    }
  }
}

async function main(): Promise<void> {
  console.log('Setting up benchmark tables on fast-firebird-test-fb5...');
  await setup();

  // BENCH_BLOB=1 skips the driver-vs-driver suite (blob-matrix iteration).
  const blobOnly = process.env.BENCH_BLOB === '1';

  const results: Result[] = [];
  for (const delay of blobOnly ? [] : DELAYS_MS) {
    for (const driver of [fastFirebird, nodeFirebird]) {
      const proxy = new LatencyProxy(FB_HOST, FB_PORT, delay);
      const port = await proxy.listen();
      try {
        for (const sc of scenarios(5)) {
          let ms: number;
          let rts: number | null = null;
          if (sc.standalone) {
            const t0 = process.hrtime.bigint();
            await sc.standalone(driver, FB_HOST, port);
            ms = Number(process.hrtime.bigint() - t0) / 1e6;
          } else {
            const conn = await connectWithRetry(driver, FB_HOST, port);
            try {
              // Warmup pass primes statement caches fairly for both drivers.
              await conn.query('select name from bench_rows where id = ?', [1]);
              const rt0 = conn.roundTrips?.() ?? null;
              const t0 = process.hrtime.bigint();
              await sc.run(conn);
              ms = Number(process.hrtime.bigint() - t0) / 1e6;
              if (rt0 !== null) rts = (conn.roundTrips?.() ?? 0) - rt0;
            } finally {
              await conn.close();
            }
          }
          results.push({
            driver: driver.name,
            delay,
            scenario: sc.name,
            ms,
            opsPerSec: (sc.ops / ms) * 1000,
            roundTrips: rts,
          });
          console.log(
            `  [${delay}ms] ${driver.name.padEnd(14)} ${sc.name.padEnd(26)} ${ms.toFixed(0).padStart(7)} ms` +
              (rts !== null ? `  (${rts} RTs)` : ''),
          );
        }
      } finally {
        await proxy.close();
      }
    }
  }

  console.log(`\nBlob strategy matrix (fast-firebird only, ${MEMO_COUNT}×${MEMO_SIZE / 1000}KB memos)...`);
  const blobResults = await runBlobMatrix();

  // Summary table (markdown).
  if (!blobOnly) {
  console.log('\n## Results (fast-firebird vs node-firebird, FB5, one-way delay per link)\n');
  console.log('| Scenario | Delay | fast-firebird | node-firebird | Speedup |');
  console.log('|---|---|---|---|---|');
  for (const delay of DELAYS_MS) {
    for (const sc of scenarios(5)) {
      const ff = results.find((r) => r.driver === 'fast-firebird' && r.delay === delay && r.scenario === sc.name)!;
      const nf = results.find((r) => r.driver === 'node-firebird' && r.delay === delay && r.scenario === sc.name)!;
      const speedup = nf.ms / ff.ms;
      console.log(
        `| ${sc.name} | ${delay}ms | ${ff.ms.toFixed(0)} ms${ff.roundTrips !== null ? ` (${ff.roundTrips} RT)` : ''} | ${nf.ms.toFixed(0)} ms | **${speedup.toFixed(1)}×** |`,
      );
    }
  }
  }
  console.log(`\n## Blob strategies (fast-firebird, ${MEMO_COUNT} rows × ${MEMO_SIZE / 1000} KB, FB5)\n`);
  console.log('| Strategy | ' + DELAYS_MS.map((d) => `${d}ms delay`).join(' | ') + ' |');
  console.log('|---|' + DELAYS_MS.map(() => '---').join('|') + '|');
  for (const st of blobStrategies()) {
    const cells = DELAYS_MS.map((delay) => {
      const r = blobResults.find((b) => b.strategy === st.name && b.delay === delay)!;
      return `${r.ms.toFixed(0)} ms (${r.roundTrips} RT)`;
    });
    console.log(`| ${st.name} | ${cells.join(' | ')} |`);
  }

  if (connectRetries > 0) {
    console.log(`\n(connect retries needed during the run: ${connectRetries} — see SRP errata in plans/research)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
