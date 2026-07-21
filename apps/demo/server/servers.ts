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
  /**
   * Request zlib wire compression at the handshake. BOTH sides must opt in:
   * the client sets the compression flag in its protocol offer, and the
   * server must have `WireCompression = true` in firebird.conf (the docker
   * matrix does). Applied on (re)connect.
   */
  wireCompression?: boolean;
  /** Connection charset (lc_ctype). Default NONE — the legacy-db demo scenario. */
  charset?: string;
  /**
   * How CHARSET NONE bytes are decoded/encoded (iconv-lite name). Only used
   * when charset is NONE. Default win1252 — the classic legacy-Delphi preset.
   */
  charsetNoneEncoding?: string;
  /** SQL role sent at attach (DPB), e.g. RDB$ADMIN. */
  role?: string;
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
  { id: 'fb6', label: 'Firebird 6', host: '127.0.0.1', port: 30507, database: DEMO_DB, user: 'SYSDBA', password: 'masterkey', version: 6 },
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

/** The one place demo connection options are built — every lane uses this. */
export function connectOptsFor(config: ServerConfig) {
  const charset = (config.charset ?? 'NONE').toUpperCase();
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    role: config.role || undefined,
    encoding: charset,
    // The transcoder only applies to CHARSET NONE columns/connections.
    charsetNoneEncoding: charset === 'NONE' ? (config.charsetNoneEncoding || 'win1252') : undefined,
    wireCompression: config.wireCompression ?? false,
  };
}

/**
 * Patch a server's config (e.g. toggle wire compression) and tear down its
 * live state — handshake-time settings only apply on the next connect.
 */
export async function updateServerConfig(id: string, patch: Partial<Omit<ServerConfig, 'id' | 'version'>>): Promise<ServerConfig> {
  const config = configs.get(id);
  if (!config) throw new Error(`Unknown server '${id}'`);
  Object.assign(config, patch);
  await disconnectServer(id);
  return config;
}

/** True when the server has live pools/attachments right now. */
export function isConnected(id: string): boolean {
  return states.has(id);
}

/**
 * Explicitly tear down a server's pools and attachments but KEEP its config —
 * the next use (or an explicit connect) re-establishes everything.
 */
export async function disconnectServer(id: string): Promise<void> {
  if (!configs.has(id)) throw new Error(`Unknown server '${id}'`);
  const st = states.get(id);
  states.delete(id);
  if (st) {
    await st.ready.catch(() => void 0); // let any in-flight init settle before teardown
    await st.ext?.stopPool?.().catch(() => void 0);
    await st.pool?.close?.().catch(() => void 0);
    await st.drizzleAtt?.disconnect?.().catch(() => void 0);
  }
}

/** Remove a custom server and tear down its pooled connections. Built-ins are protected. */
export async function removeServer(id: string): Promise<void> {
  if (isBuiltinServer(id)) throw new Error('Built-in servers cannot be removed');
  if (!configs.has(id)) throw new Error(`Unknown server '${id}'`);
  await disconnectServer(id);
  configs.delete(id);
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

  const connectOpts = connectOptsFor(config);

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
      driver: { attach: { host: config.host, port: config.port, database: config.database, user: config.user, password: config.password, role: connectOpts.role, encoding: connectOpts.encoding, charsetNoneEncoding: connectOpts.charsetNoneEncoding, wireCompression: config.wireCompression ?? false } },
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
