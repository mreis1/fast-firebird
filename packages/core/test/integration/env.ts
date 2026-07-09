/** Shared connection settings for the isolated docker test matrix. */
export interface FbServer {
  name: string;
  port: number;
  /** Major server version. */
  version: 3 | 4 | 5;
}

export const FB_SERVERS: FbServer[] = [
  { name: 'fb3', port: 30503, version: 3 },
  { name: 'fb4', port: 30504, version: 4 },
  { name: 'fb5', port: 30505, version: 5 },
];

export const FB_BASE = {
  host: '127.0.0.1',
  database: '/var/lib/firebird/data/test.fdb',
  user: 'SYSDBA',
  password: 'masterkey',
};

/**
 * Explicit hook timeout for setup that connects. Firebird 3's single-threaded
 * async-event-port cleanup can briefly slow new connects right after the event
 * tests, and vitest's global `hookTimeout` config isn't honored for hooks in
 * every runner mode — so setup hooks pass this explicitly.
 */
export const HOOK_TIMEOUT = 60_000;

/**
 * The integration suite runs many files against three SHARED databases.
 * Firebird serializes DDL on its system tables, so concurrent `recreate
 * table` (or DDL racing a DML transaction) can raise a transient
 * "deadlock / object in use" error. Real applications retry these; so does
 * setup here. Only retries genuinely transient conflicts.
 */
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

/**
 * Run DDL in a NOWAIT transaction so a metadata-lock conflict (from another
 * test file touching the shared database) raises immediately and is retried,
 * rather than blocking the default wait-forever transaction and timing out.
 */
export async function ddl(db: import('../../src/index.js').Attachment, sql: string): Promise<void> {
  await withRetry(() => db.transaction((tx) => tx.execute(sql), { wait: false }), 25);
}
