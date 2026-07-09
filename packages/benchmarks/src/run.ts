import { connect as ffConnect } from '@fast-firebird/core';
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

  const results: Result[] = [];
  for (const delay of DELAYS_MS) {
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

  // Summary table (markdown).
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
  if (connectRetries > 0) {
    console.log(`\n(connect retries needed during the run: ${connectRetries} — see SRP errata in plans/research)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
