import { useEffect, useRef, useState } from 'react';

export interface ServerCfg {
  id: string;
  label: string;
  host: string;
  port: number;
  database: string;
  user: string;
  version?: number;
}

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

async function json<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  servers: () => json<{ servers: ServerCfg[] }>('/api/servers'),
  addServer: (cfg: Partial<ServerCfg> & { password?: string }) => json<{ server: ServerCfg }>('/api/servers', cfg),
  info: (id: string) => json<ServerInfo>(`/api/servers/${id}/info`),
  query: (id: string, engine: Engine, sql: string, params: unknown[]) =>
    json<QueryResult>(`/api/servers/${id}/query`, { engine, sql, params }),
  benchmark: (id: string, n: number) => json<{ n: number; lanes: BenchLane[] }>(`/api/servers/${id}/benchmark`, { n }),
  emit: (id: string, name: string) => json<{ emitted: string }>(`/api/servers/${id}/emit`, { name }),
  blob: (id: string) => json<{ note: string; binary: unknown }>(`/api/servers/${id}/blob`, {}),
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
    es.onerror = () => es.close();
    return () => es.close();
  }, [url]);
  return { events, clear: () => setEvents([]) };
}
