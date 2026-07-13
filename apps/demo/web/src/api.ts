import { useEffect, useRef, useState } from 'react';

export interface ServerCfg {
  id: string;
  label: string;
  host: string;
  port: number;
  database: string;
  user: string;
  version?: number;
  /** Built-in FB3/4/5 servers can't be removed. */
  builtin?: boolean;
  /** True when the server currently has live pools/attachments. */
  connected?: boolean;
  /** Client requests zlib wire compression (server needs WireCompression=true). */
  wireCompression?: boolean;
  /** Connection charset (lc_ctype), e.g. NONE, UTF8, WIN1252. */
  charset?: string;
  /** Transcoder for CHARSET NONE bytes (iconv-lite name, e.g. win1252). */
  charsetNoneEncoding?: string;
  /** SQL role sent at attach, e.g. RDB$ADMIN. */
  role?: string;
}

/** Lock-wait mode: undefined = engine default, true = wait, false = nowait, number = wait seconds. */
export type TxWait = boolean | number | undefined;

export interface ServerInfo {
  config: ServerCfg;
  protocolVersion: number;
  wireEncrypted: boolean;
  wireCryptPlugin: string | null;
  wireCompressed: boolean;
  engineVersion: string | null;
  serverVersion: string | null;
  pool: PoolStats;
}

export interface PoolStats {
  total: number;
  idle: number;
  inUse: number;
  pending: number;
}

export type Engine = 'core' | 'drizzle' | 'compat';

export interface QueryResult {
  engine: Engine;
  rows: Record<string, unknown>[];
  rowCount: number;
  ms: number;
  note?: string;
  error?: string;
}

export interface BenchLane {
  engine: Engine;
  insertMs: number | null;
  selectMs: number;
  rows: number;
}

export interface Feature {
  id: string;
  since: 3 | 4 | 5;
  title: string;
  blurb: string;
  setup: string[];
  sql: string;
  available: boolean;
}

export interface TryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  ms: number;
  error?: string;
}

export const BENCH_TYPES = [
  'integer',
  'bigint',
  'varchar(60)',
  'numeric(12,2)',
  'decfloat(34)',
  'timestamp',
  'boolean',
  'blob binary',
  'blob text',
] as const;
export type BenchColumnType = (typeof BENCH_TYPES)[number];

export interface BenchColumnDef {
  name: string;
  type: BenchColumnType;
  dataBase64?: string;
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

async function json<T>(url: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(url, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  servers: () => json<{ servers: ServerCfg[] }>('/api/servers'),
  addServer: (cfg: Partial<ServerCfg> & { password?: string }) => json<{ server: ServerCfg }>('/api/servers', cfg),
  deleteServer: (id: string) => json<{ removed: string }>(`/api/servers/${id}`, undefined, 'DELETE'),
  connectServer: (id: string) => json<{ id: string; connected: boolean }>(`/api/servers/${id}/connect`, {}),
  updateServer: (id: string, patch: { wireCompression?: boolean; charset?: string; charsetNoneEncoding?: string; role?: string }) =>
    json<{ server: ServerCfg }>(`/api/servers/${id}/config`, patch),
  disconnectServer: (id: string) => json<{ id: string; connected: boolean }>(`/api/servers/${id}/disconnect`, {}),
  info: (id: string) => json<ServerInfo>(`/api/servers/${id}/info`),
  query: (id: string, engine: Engine, sql: string, params: unknown[], txWait?: TxWait) =>
    json<QueryResult>(`/api/servers/${id}/query`, { engine, sql, params, txWait }),
  benchmark: (id: string, n: number) => json<{ n: number; lanes: BenchLane[] }>(`/api/servers/${id}/benchmark`, { n }),
  emit: (id: string, name: string) => json<{ emitted: string }>(`/api/servers/${id}/emit`, { name }),
  blob: (id: string) => json<{ note: string; binary: unknown }>(`/api/servers/${id}/blob`, {}),
  features: (id: string) => json<{ version: number; features: Feature[] }>(`/api/servers/${id}/features`),
  tryFeature: (id: string, setup: string[], sql: string) => json<TryResult>(`/api/servers/${id}/try-feature`, { setup, sql }),
  customBench: (id: string, columns: BenchColumnDef[], rows: number, ddlWait?: TxWait, fetchConnections?: number) =>
    json<CustomBenchResult>(`/api/servers/${id}/custom-bench`, { columns, rows, ddlWait, fetchConnections }),
};

/**
 * Subscribe to an SSE endpoint; returns the latest N messages, resets on url
 * change. `closeOn` closes the stream when a message matches (for one-shot
 * streams like row-streaming) so the browser doesn't auto-reconnect.
 */
export function useSse<T = any>(
  url: string | null,
  opts: { keep?: number; closeOn?: (msg: T) => boolean } = {},
): { events: T[]; clear: () => void } {
  const { keep = 50, closeOn } = opts;
  const [events, setEvents] = useState<T[]>([]);
  const esRef = useRef<EventSource | null>(null);
  useEffect(() => {
    setEvents([]);
    if (!url) return;
    const es = new EventSource(url);
    esRef.current = es;
    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as T;
      setEvents((prev) => [...prev.slice(-(keep - 1)), data]);
      if (closeOn?.(data)) es.close();
    };
    // One-shot streams (closeOn set) must not auto-reconnect on the close that
    // ends them; persistent streams (pool/events) should let the browser retry.
    es.onerror = () => { if (closeOn) es.close(); };
    return () => es.close();
  }, [url]);
  return { events, clear: () => setEvents([]) };
}
