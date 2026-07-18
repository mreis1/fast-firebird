/** Shared connection settings for the isolated docker test matrix (mirrors core). */
import { connect, createDatabase, type Attachment } from '@fast-firebird/core';

export interface FbServer {
  name: string;
  port: number;
  version: 3 | 4 | 5 | 6;
}

export const FB_SERVERS: FbServer[] = [
  { name: 'fb3', port: 30503, version: 3 },
  { name: 'fb4', port: 30504, version: 4 },
  { name: 'fb5', port: 30505, version: 5 },
  // FB6 snapshot (protocol 20). Set FB_SKIP_FB6=1 to run the stable trio only.
  ...(process.env.FB_SKIP_FB6 ? [] : [{ name: 'fb6', port: 30507, version: 6 as const }]),
];

export const FB_BASE = {
  host: '127.0.0.1',
  database: '/var/lib/firebird/data/test.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
};

export const HOOK_TIMEOUT = 60_000;

/** Retry transient DDL/metadata conflicts on the shared servers. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message ?? '');
      const transient = /deadlock|conflicts with concurrent|object .*in use|lock conflict|update conflict/i.test(msg);
      if (!transient) throw err;
      await new Promise((r) => setTimeout(r, 50 + i * 100));
    }
  }
  throw lastErr;
}

/** Run DDL in a NOWAIT transaction so lock conflicts raise (and retry) fast. */
export async function ddl(db: Attachment, sql: string): Promise<void> {
  await withRetry(() => db.transaction((tx) => tx.execute(sql), { wait: false }), 25);
}

let dbSeq = 0;
export function nextDatabasePath(port: number): string {
  return `/var/lib/firebird/data/dz_${port}_${process.pid}_${dbSeq++}.fdb`;
}

/** Each DDL-heavy suite gets its OWN database — zero cross-file contention. */
export async function freshDb(port: number): Promise<Attachment> {
  return createDatabase({ ...FB_BASE, port, database: nextDatabasePath(port) });
}

export async function dropDatabaseAt(port: number, database: string): Promise<void> {
  const db = await connect({ ...FB_BASE, port, database });
  await db.dropDatabase();
}
