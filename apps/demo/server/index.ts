import Fastify from 'fastify';
import { connect, connectService } from '@fast-firebird/core';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { addServer, closeAll, connectOptsFor, disconnectServer, getServer, isBuiltinServer, isConnected, listServerConfigs, removeServer, updateServerConfig, type ServerConfig } from './servers.ts';
import { benchmark, runQuery, serializeCell, type Engine } from './engines.ts';
import { featuresFor, tryFeature } from './features.ts';
import { runCustomBench, type CustomBenchRequest } from './custom-bench.ts';

const PORT = Number(process.env.DEMO_API_PORT || 5178);
// bodyLimit: custom-bench uploads blob files as base64 JSON (cap ~24 MB → ~18 MB file).
const app = Fastify({ logger: false, bodyLimit: 24 * 1024 * 1024 });

/** Strip secrets before sending a server config to the browser. */
function publicConfig(c: ServerConfig) {
  return { id: c.id, label: c.label, host: c.host, port: c.port, database: c.database, user: c.user, version: c.version, builtin: isBuiltinServer(c.id), connected: isConnected(c.id), wireCompression: c.wireCompression ?? false };
}

/** Minimal SSE helper over the raw Node response. Returns send/close. */
function sse(reply: any) {
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('\n');
  return {
    send: (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`),
    close: () => res.end(),
  };
}

app.get('/api/servers', async () => ({ servers: listServerConfigs().map(publicConfig) }));

app.post('/api/servers', async (req) => {
  const cfg = addServer(req.body as any);
  return { server: publicConfig(cfg) };
});

app.delete('/api/servers/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    await removeServer(id);
    return { removed: id };
  } catch (err) {
    reply.code(400);
    return { error: (err as Error).message };
  }
});

// Patch handshake-time settings (wire compression); applies on next connect.
app.post('/api/servers/:id/config', async (req, reply) => {
  const { id } = req.params as { id: string };
  const { wireCompression } = req.body as { wireCompression?: boolean };
  try {
    const cfg = await updateServerConfig(id, { wireCompression: !!wireCompression });
    return { server: publicConfig(cfg) };
  } catch (err) {
    reply.code(400);
    return { error: (err as Error).message };
  }
});

// Explicit connection lifecycle: tear down / re-establish pools + attachments.
app.post('/api/servers/:id/disconnect', async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    await disconnectServer(id);
    return { id, connected: false };
  } catch (err) {
    reply.code(400);
    return { error: (err as Error).message };
  }
});

app.post('/api/servers/:id/connect', async (req, reply) => {
  const { id } = req.params as { id: string };
  try {
    await getServer(id); // establishes pool + drizzle + compat lanes
    return { id, connected: true };
  } catch (err) {
    reply.code(400);
    return { error: (err as Error).message };
  }
});

app.get('/api/servers/:id/info', async (req) => {
  const { id } = req.params as { id: string };
  const state = await getServer(id);
  const wire = await state.pool.use(async (att) => {
    const [engine] = await att.query(`select rdb$get_context('SYSTEM','ENGINE_VERSION') as V from rdb$database`);
    return {
      protocolVersion: att.protocolVersion,
      wireEncrypted: att.wireEncrypted,
      wireCryptPlugin: att.wireCryptPlugin,
      wireCompressed: att.wireCompressed,
      engineVersion: (engine as any)?.V ?? null,
    };
  });
  let serverVersion: string | null = null;
  try {
    const svc = await connectService({ host: state.config.host, port: state.config.port, user: state.config.user, password: state.config.password });
    serverVersion = (await svc.getServerInfo()).serverVersion;
    await svc.disconnect();
  } catch {
    /* services optional */
  }
  return { config: publicConfig(state.config), ...wire, serverVersion, pool: state.pool.stats() };
});

app.post('/api/servers/:id/query', async (req) => {
  const { id } = req.params as { id: string };
  const { sql, params, engine, txWait } = req.body as { sql: string; params?: unknown[]; engine: Engine; txWait?: boolean | number };
  const state = await getServer(id);
  return runQuery(state, engine, sql, params ?? [], txWait);
});

app.post('/api/servers/:id/benchmark', async (req) => {
  const { id } = req.params as { id: string };
  const { n } = req.body as { n?: number };
  const state = await getServer(id);
  return { n: n ?? 200, lanes: await benchmark(state, Math.min(2000, Math.max(1, n ?? 200))) };
});

app.get('/api/servers/:id/features', async (req) => {
  const { id } = req.params as { id: string };
  const state = await getServer(id);
  let version = state.config.version;
  if (version == null) {
    const [row] = await state.pool.use((att) => att.query(`select rdb$get_context('SYSTEM','ENGINE_VERSION') as V from rdb$database`));
    version = Number(String((row as any)?.V ?? '').split('.')[0]) || undefined;
  }
  return { version, features: featuresFor(version) };
});

app.post('/api/servers/:id/try-feature', async (req) => {
  const { id } = req.params as { id: string };
  const { setup, sql } = req.body as { setup?: string[]; sql: string };
  const state = await getServer(id);
  return tryFeature(state, setup ?? [], sql);
});

app.post('/api/servers/:id/custom-bench', async (req, reply) => {
  const { id } = req.params as { id: string };
  const state = await getServer(id);
  try {
    return await runCustomBench(state, req.body as CustomBenchRequest);
  } catch (err) {
    reply.code(400);
    return { error: (err as Error).message.split('\n').slice(0, 3).join(' ') };
  }
});

app.post('/api/servers/:id/emit', async (req) => {
  const { id } = req.params as { id: string };
  const { name } = req.body as { name: string };
  const state = await getServer(id);
  await state.pool.use((att) => att.execute(`execute block as begin post_event '${name.replace(/'/g, "''")}'; end`));
  return { emitted: name };
});

app.post('/api/servers/:id/blob', async (req) => {
  const { id } = req.params as { id: string };
  const state = await getServer(id);
  const text = 'Blob text with unicode: café € — persisted and read back.';
  const binary = Buffer.from([0x00, 0x01, 0x02, 0xfa, 0xfb, 0xfc, 0xff]);
  const row = await state.pool.use(async (att) => {
    await att.transaction((tx) => tx.execute('recreate table FF_DEMO_BLOB (ID integer not null primary key, NOTE blob sub_type text, BIN blob sub_type binary)'), { wait: false });
    await att.execute('insert into FF_DEMO_BLOB (ID, NOTE, BIN) values (?, ?, ?)', [1, text, binary]);
    const [r] = await att.query('select NOTE, BIN from FF_DEMO_BLOB where ID = 1');
    return r as any;
  });
  return { note: row.NOTE, binary: serializeCell(row.BIN) };
});

// ── SSE: pool stats ────────────────────────────────────────────────────────
app.get('/api/servers/:id/pool', async (req, reply) => {
  const { id } = req.params as { id: string };
  const state = await getServer(id);
  reply.hijack();
  const ch = sse(reply);
  let timer: ReturnType<typeof setInterval>;
  const stop = () => {
    clearInterval(timer);
    ch.close();
  };
  const tick = () => {
    try {
      ch.send({ t: Date.now(), ...state.pool.stats() });
    } catch {
      stop(); // socket gone mid-write — don't leak the interval
    }
  };
  tick();
  timer = setInterval(tick, 1000);
  req.raw.on('close', stop);
});

// ── SSE: live POST_EVENT feed ────────────────────────────────────────────────
app.get('/api/servers/:id/events', async (req, reply) => {
  const { id } = req.params as { id: string };
  const names = String((req.query as any).names || '').split(',').map((s) => s.trim()).filter(Boolean);
  const state = await getServer(id);
  reply.hijack();
  const ch = sse(reply);
  const att = await connect(connectOptsFor(state.config));
  const listener = await att.events(names.length ? names : ['demo_event']);
  ch.send({ armed: names.length ? names : ['demo_event'] });
  listener.on('post', (name: string, count: number) => ch.send({ name, count, t: Date.now() }));
  listener.on('error', (e: Error) => ch.send({ error: e.message }));
  req.raw.on('close', async () => {
    try {
      await listener.close();
      await att.disconnect();
    } catch { /* ignore */ }
    ch.close();
  });
});

// ── SSE: streamed rows (lazy, backpressured) ─────────────────────────────────
app.get('/api/servers/:id/stream', async (req, reply) => {
  const { id } = req.params as { id: string };
  const count = Math.min(100_000, Math.max(1, Number((req.query as any).count) || 1000));
  const state = await getServer(id);
  reply.hijack();
  const ch = sse(reply);
  const att = await connect(connectOptsFor(state.config));
  let closed = false;
  req.raw.on('close', () => { closed = true; });
  try {
    const t0 = performance.now();
    let seen = 0;
    // Non-recursive row generator: a 3-way cross-join of rdb$types (hundreds of
    // rows) yields millions of combinations, and ROWS short-circuits after N
    // (no window function, or Firebird would materialize the whole product
    // first). Recursive CTEs can't do this — they hit the ~1024 depth limit.
    const gen = att.queryStream(`select 1 as n from rdb$types a, rdb$types b, rdb$types c rows ${count}`);
    for await (const _row of gen) {
      if (closed) break;
      seen++;
      if (seen % 250 === 0 || seen === count) ch.send({ seen, total: count, ms: +(performance.now() - t0).toFixed(0), sample: seen });
    }
    if (!closed) ch.send({ done: true, seen, ms: +(performance.now() - t0).toFixed(0) });
  } catch (e) {
    if (!closed) ch.send({ error: (e as Error).message });
  } finally {
    await att.disconnect().catch(() => void 0);
    ch.close();
  }
});

// Serve the built React app in production (pnpm start).
if (process.env.DEMO_SERVE_WEB) {
  const here = dirname(fileURLToPath(import.meta.url));
  const webRoot = join(here, '..', 'dist-web');
  if (existsSync(webRoot)) {
    const staticPlugin = (await import('@fastify/static')).default;
    await app.register(staticPlugin, { root: webRoot });
    app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));
  }
}

const shutdown = async () => {
  await closeAll();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen({ port: PORT, host: '0.0.0.0' }).then(() => {
  console.log(`[demo] API on http://localhost:${PORT}  (web dev: http://localhost:5177)`);
});
