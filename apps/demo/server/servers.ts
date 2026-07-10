import { connect, createDatabase, createPool, type Attachment, type Pool } from '@fast-firebird/core';
import { drizzle, type FirebirdDatabase } from '@fast-firebird/drizzle';
import nfb2 from 'node-firebird-2-ext';

const { createFirebirdManager } = nfb2 as unknown as {
  createFirebirdManager: (config: any) => any;
};

export interface ServerConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** Firebird major version, if known (for display). */
  version?: number;
}

export interface ServerState {
  config: ServerConfig;
  pool: Pool;
  drizzleAtt: Attachment;
  drizzle: FirebirdDatabase;
  ext: any;
  ready: Promise<void>;
}

const DEMO_DB = '/var/lib/firebird/data/ff_demo.fdb';

/** The pre-wired disposable test matrix. Custom servers can be added at runtime. */
const DEFAULT_SERVERS: ServerConfig[] = [
  { id: 'fb3', label: 'Firebird 3', host: '127.0.0.1', port: 30503, database: DEMO_DB, user: 'SYSDBA', password: 'masterkey', version: 3 },
  { id: 'fb4', label: 'Firebird 4', host: '127.0.0.1', port: 30504, database: DEMO_DB, user: 'SYSDBA', password: 'masterkey', version: 4 },
  { id: 'fb5', label: 'Firebird 5', host: '127.0.0.1', port: 30505, database: DEMO_DB, user: 'SYSDBA', password: 'masterkey', version: 5 },
];

const configs = new Map<string, ServerConfig>();
const states = new Map<string, ServerState>();
const BUILTIN_IDS = new Set(DEFAULT_SERVERS.map((s) => s.id));
for (const s of DEFAULT_SERVERS) configs.set(s.id, s);

export function isBuiltinServer(id: string): boolean {
  return BUILTIN_IDS.has(id);
}

export function listServerConfigs(): ServerConfig[] {
  return [...configs.values()];
}

export function addServer(cfg: Omit<ServerConfig, 'id'> & { id?: string }): ServerConfig {
  const id = cfg.id || `custom-${Date.now()}`;
  const full: ServerConfig = { ...cfg, id };
  configs.set(id, full);
  return full;
}

/** Remove a custom server and tear down its pooled connections. Built-ins are protected. */
export async function removeServer(id: string): Promise<void> {
  if (isBuiltinServer(id)) throw new Error('Built-in servers cannot be removed');
  if (!configs.has(id)) throw new Error(`Unknown server '${id}'`);
  configs.delete(id);
  const st = states.get(id);
  states.delete(id);
  if (st) {
    await st.ready.catch(() => void 0); // let any in-flight init settle before teardown
    await st.ext?.stopPool?.().catch(() => void 0);
    await st.pool?.close?.().catch(() => void 0);
    await st.drizzleAtt?.disconnect?.().catch(() => void 0);
  }
}

/** Ensure the demo database exists (create once, ignore "already exists"). */
async function ensureDatabase(cfg: ServerConfig): Promise<void> {
  try {
    const db = await createDatabase({ host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password, encoding: 'NONE' });
    await db.disconnect();
  } catch {
    // Already exists (or cannot create) — connect path will surface real errors.
  }
}

export async function getServer(id: string): Promise<ServerState> {
  const existing = states.get(id);
  if (existing) {
    await existing.ready;
    return existing;
  }
  const config = configs.get(id);
  if (!config) throw new Error(`Unknown server '${id}'`);

  const connectOpts = { host: config.host, port: config.port, database: config.database, user: config.user, password: config.password, encoding: 'NONE', charsetNoneEncoding: 'win1252' };

  let resolveReady!: () => void;
  let rejectReady!: (e: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  // `ready` MUST live on the state so the fast-path (`await existing.ready`)
  // waits for init; otherwise a concurrent request during init gets a
  // half-built state (pool undefined) and throws.
  const state = { config, ready } as ServerState;
  states.set(id, state);

  (async () => {
    await ensureDatabase(config);
    state.pool = await createPool({ ...connectOpts, min: 1, max: 8 });
    state.drizzleAtt = await connect(connectOpts);
    state.drizzle = drizzle(state.drizzleAtt);
    state.ext = createFirebirdManager({
      name: `demo-${id}`,
      driver: { attach: { host: config.host, port: config.port, database: config.database, user: config.user, password: config.password, encoding: 'NONE' } },
      pool: { min: 1, max: 4, sanitizeOnRelease: false },
    });
  })().then(resolveReady, rejectReady);

  await ready;
  return state;
}

export async function closeAll(): Promise<void> {
  for (const s of states.values()) {
    try {
      await s.ext?.stopPool?.();
    } catch { /* ignore */ }
    try {
      await s.pool?.close?.();
    } catch { /* ignore */ }
    try {
      await s.drizzleAtt?.disconnect?.();
    } catch { /* ignore */ }
  }
  states.clear();
}
