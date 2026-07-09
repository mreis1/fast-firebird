import { useEffect, useMemo, useState } from 'react';
import { api, useSse, type BenchLane, type Engine, type QueryResult, type ServerCfg, type ServerInfo } from './api';

const ENGINES: Engine[] = ['core', 'drizzle', 'compat'];

export function App() {
  const [servers, setServers] = useState<ServerCfg[]>([]);
  const [active, setActive] = useState<string>('fb5');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    api.servers().then((r) => setServers(r.servers));
  }, []);

  return (
    <div className="app">
      <header className="top">
        <h1>
          <span className="fire">🔥</span> fast-firebird <span style={{ color: 'var(--muted)' }}>· live dashboard</span>
        </h1>
        <span className="sub">core · drizzle · node-firebird2-ext — one stack, three faces</span>
      </header>

      <div className="servers">
        {servers.map((s) => (
          <button key={s.id} className={`tab ${active === s.id ? 'active' : ''}`} onClick={() => setActive(s.id)}>
            <span className="dot" /> {s.label}
          </button>
        ))}
        <button className="tab add" onClick={() => setAdding((v) => !v)}>+ add server</button>
      </div>

      {adding && (
        <AddServer
          onAdd={async (cfg) => {
            const { server } = await api.addServer(cfg);
            setServers((prev) => [...prev, server]);
            setActive(server.id);
            setAdding(false);
          }}
        />
      )}

      <div className="grid">
        <InfoPanel key={`info-${active}`} id={active} />
        <PoolPanel key={`pool-${active}`} id={active} />
        <QueryPanel key={`q-${active}`} id={active} />
        <EventsPanel key={`ev-${active}`} id={active} />
        <StreamPanel key={`st-${active}`} id={active} />
        <BlobPanel key={`bl-${active}`} id={active} />
        <BenchPanel key={`bn-${active}`} id={active} />
      </div>

      <div className="footer">
        Pure-TypeScript Firebird driver · SRP + WireCrypt + WireCompression · CHARSET NONE/win1252 · FB 3/4/5
      </div>
    </div>
  );
}

function AddServer({ onAdd }: { onAdd: (cfg: any) => void }) {
  const [f, setF] = useState({ label: 'Custom', host: '127.0.0.1', port: 3050, database: '', user: 'SYSDBA', password: 'masterkey' });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="card wide" style={{ marginBottom: 16 }}>
      <h2>Add a server</h2>
      <div className="row">
        <input style={{ maxWidth: 130 }} placeholder="label" value={f.label} onChange={set('label')} />
        <input style={{ maxWidth: 150 }} placeholder="host" value={f.host} onChange={set('host')} />
        <input style={{ maxWidth: 90 }} placeholder="port" value={f.port} onChange={set('port')} />
        <input style={{ flex: 1, minWidth: 200 }} placeholder="/path/to/db.fdb" value={f.database} onChange={set('database')} />
        <input style={{ maxWidth: 110 }} placeholder="user" value={f.user} onChange={set('user')} />
        <input style={{ maxWidth: 130 }} placeholder="password" type="password" value={f.password} onChange={set('password')} />
        <button className="btn" onClick={() => onAdd({ ...f, port: Number(f.port) })}>Connect</button>
      </div>
      <div className="note">Read/write, wide open — points at whatever database you give it.</div>
    </div>
  );
}

function InfoPanel({ id }: { id: string }) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setInfo(null);
    setErr(null);
    api.info(id).then(setInfo, (e) => setErr(String(e.message || e)));
  }, [id]);

  return (
    <div className="card">
      <h2>Connection</h2>
      {err && <div className="err-text">{err}</div>}
      {!info && !err && <div className="note">connecting…</div>}
      {info && (
        <div className="kv">
          <b>server</b>
          <span>{info.serverVersion || info.engineVersion || '—'}</span>
          <b>engine</b>
          <span>{info.engineVersion || '—'}</span>
          <b>wire protocol</b>
          <span>v{info.protocolVersion}</span>
          <b>encryption</b>
          <span>
            {info.wireEncrypted ? <span className="badge on">{info.wireCryptPlugin}</span> : <span className="badge off">off</span>}
          </span>
          <b>compression</b>
          <span>{info.wireCompressed ? <span className="badge on">zlib</span> : <span className="badge off">off</span>}</span>
          <b>database</b>
          <span style={{ fontSize: 11 }}>{info.config.database}</span>
        </div>
      )}
    </div>
  );
}

function PoolPanel({ id }: { id: string }) {
  const { events } = useSse<{ total: number; idle: number; inUse: number; pending: number }>(`/api/servers/${id}/pool`);
  const last = events[events.length - 1];
  const spark = events.slice(-40);
  const max = Math.max(1, ...spark.map((e) => e.total));
  return (
    <div className="card">
      <h2>Connection pool (live)</h2>
      {!last && <div className="note">waiting for stats…</div>}
      {last && (
        <>
          <div className="kv">
            <b>total</b>
            <span>{last.total}</span>
            <b>in use</b>
            <span>{last.inUse}</span>
            <b>idle</b>
            <span>{last.idle}</span>
            <b>waiting</b>
            <span>{last.pending}</span>
          </div>
          <div className="spark" style={{ marginTop: 12 }}>
            {spark.map((e, i) => (
              <i key={i} style={{ height: `${(e.total / max) * 100}%`, background: e.inUse > 0 ? 'var(--accent)' : 'var(--accent-2)' }} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function QueryPanel({ id }: { id: string }) {
  const [sql, setSql] = useState("select rdb$relation_name as name, rdb$relation_id as id\nfrom rdb$relations where rdb$system_flag = 0\norder by 1");
  const [paramsText, setParamsText] = useState('[]');
  const [engine, setEngine] = useState<Engine | 'all'>('all');
  const [results, setResults] = useState<QueryResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    let params: unknown[] = [];
    try {
      params = JSON.parse(paramsText || '[]');
      if (!Array.isArray(params)) throw new Error('params must be a JSON array');
    } catch (e) {
      setErr(`params: ${(e as Error).message}`);
      setBusy(false);
      return;
    }
    try {
      const engines = engine === 'all' ? ENGINES : [engine];
      const res = await Promise.all(engines.map((e) => api.query(id, e, sql, params)));
      setResults(res);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const grid = results.find((r) => !r.error && r.rows.length > 0) ?? results.find((r) => !r.error);
  const cols = grid && grid.rows.length ? Object.keys(grid.rows[0]) : [];

  return (
    <div className="card wide">
      <h2>SQL runner — same query, three stacks</h2>
      <textarea rows={3} value={sql} onChange={(e) => setSql(e.target.value)} />
      <div className="row mt">
        <input style={{ maxWidth: 220 }} value={paramsText} onChange={(e) => setParamsText(e.target.value)} placeholder="params (JSON array)" />
        <div className="seg">
          {(['all', ...ENGINES] as const).map((e) => (
            <button key={e} className={engine === e ? 'active' : ''} onClick={() => setEngine(e)}>
              {e}
            </button>
          ))}
        </div>
        <button className="btn" onClick={run} disabled={busy}>
          {busy ? 'running…' : 'Run'}
        </button>
      </div>
      {err && <div className="err-text" style={{ marginTop: 10 }}>{err}</div>}

      {results.length > 0 && (
        <div className="lanes" style={{ marginTop: 12, gridTemplateColumns: `repeat(${results.length}, 1fr)` }}>
          {results.map((r) => (
            <div className="lane" key={r.engine}>
              <div className={`name ${r.engine}`}>{r.engine}</div>
              {r.error ? (
                <div className="err">{r.error}</div>
              ) : (
                <>
                  <div className="metric">{r.ms}<span className="unit"> ms</span></div>
                  <div className="unit">{r.rowCount} row{r.rowCount === 1 ? '' : 's'}</div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {grid && grid.rows.length > 0 && (
        <div className="scroll" style={{ marginTop: 12 }}>
          <table className="res">
            <thead>
              <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {grid.rows.slice(0, 200).map((row, i) => (
                <tr key={i}>{cols.map((c) => <td key={c}>{fmt(row[c])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {results.some((r) => r.note) && <div className="note">{results.find((r) => r.note)?.note}</div>}
    </div>
  );
}

function EventsPanel({ id }: { id: string }) {
  const [names, setNames] = useState('demo_event');
  const [url, setUrl] = useState<string | null>(null);
  const { events } = useSse<any>(url);
  const armed = events.find((e) => e.armed)?.armed as string[] | undefined;
  const fired = events.filter((e) => e.name);

  return (
    <div className="card">
      <h2>Events (POST_EVENT, live)</h2>
      <div className="row">
        <input value={names} onChange={(e) => setNames(e.target.value)} placeholder="comma,separated,names" />
        <button className="btn ghost" onClick={() => setUrl(`/api/servers/${id}/events?names=${encodeURIComponent(names)}`)}>
          Arm
        </button>
        <button className="btn" disabled={!armed} onClick={() => api.emit(id, names.split(',')[0].trim())}>
          Fire
        </button>
      </div>
      {armed && <div className="note">listening on: {armed.join(', ')}</div>}
      <div className="feed" style={{ marginTop: 10 }}>
        {fired.length === 0 && <div className="note">no events yet — Arm, then Fire</div>}
        {fired.slice().reverse().map((e, i) => (
          <div className="line" key={i}>
            <span className="name">{e.name}</span> → count {e.count}
          </div>
        ))}
      </div>
    </div>
  );
}

function StreamPanel({ id }: { id: string }) {
  const [count, setCount] = useState(5000);
  const [url, setUrl] = useState<string | null>(null);
  const { events } = useSse<any>(url);
  const last = events[events.length - 1];
  const pct = last ? Math.round((last.seen / (last.total || count)) * 100) : 0;
  return (
    <div className="card">
      <h2>Row streaming (lazy, backpressured)</h2>
      <div className="row">
        <input style={{ maxWidth: 130 }} type="number" value={count} onChange={(e) => setCount(Number(e.target.value))} />
        <button className="btn" onClick={() => setUrl(`/api/servers/${id}/stream?count=${count}&_=${Date.now()}`)}>
          Stream
        </button>
      </div>
      {last && (
        <>
          <div className="row mt" style={{ justifyContent: 'space-between' }}>
            <span className="kv"><span style={{ fontFamily: 'var(--mono)' }}>{last.seen ?? 0} / {last.total ?? count} rows</span></span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{last.ms} ms{last.done ? ' ✓' : ''}</span>
          </div>
          <div className="bar" style={{ marginTop: 6 }}><i style={{ width: `${pct}%` }} /></div>
        </>
      )}
    </div>
  );
}

function BlobPanel({ id }: { id: string }) {
  const [data, setData] = useState<{ note: string; binary: any } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="card">
      <h2>Blobs (write + read back)</h2>
      <button className="btn" disabled={busy} onClick={async () => { setBusy(true); setData(await api.blob(id)); setBusy(false); }}>
        {busy ? '…' : 'Round-trip a blob'}
      </button>
      {data && (
        <div className="kv" style={{ marginTop: 12 }}>
          <b>text blob</b>
          <span style={{ whiteSpace: 'normal' }}>{data.note}</span>
          <b>binary blob</b>
          <span>{data.binary?.bytes} bytes · {data.binary?.preview}</span>
        </div>
      )}
    </div>
  );
}

function BenchPanel({ id }: { id: string }) {
  const [n, setN] = useState(200);
  const [lanes, setLanes] = useState<BenchLane[]>([]);
  const [busy, setBusy] = useState(false);
  const maxInsert = Math.max(1, ...lanes.map((l) => l.insertMs ?? 0));
  return (
    <div className="card wide">
      <h2>Micro-benchmark — {n} inserts + select, per stack</h2>
      <div className="row">
        <input style={{ maxWidth: 130 }} type="number" value={n} onChange={(e) => setN(Number(e.target.value))} />
        <button className="btn" disabled={busy} onClick={async () => { setBusy(true); const r = await api.benchmark(id, n); setLanes(r.lanes); setBusy(false); }}>
          {busy ? 'benchmarking…' : 'Run benchmark'}
        </button>
      </div>
      {lanes.length > 0 && (
        <div className="lanes" style={{ marginTop: 14 }}>
          {lanes.map((l) => (
            <div className="lane" key={l.engine}>
              <div className={`name ${l.engine}`}>{l.engine}</div>
              <div className="unit">insert ({n}×)</div>
              <div className="metric">{l.insertMs == null ? '—' : l.insertMs}<span className="unit"> ms</span></div>
              {l.insertMs != null && <div className="bar" style={{ marginTop: 4 }}><i style={{ width: `${(l.insertMs / maxInsert) * 100}%`, background: 'var(--accent)' }} /></div>}
              <div className="unit" style={{ marginTop: 8 }}>select</div>
              <div className="metric" style={{ fontSize: 16 }}>{l.selectMs}<span className="unit"> ms</span></div>
            </div>
          ))}
        </div>
      )}
      <div className="note">Inserts are parameterized; the Drizzle lane wraps core, so only its select is timed here.</div>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v == null) return '∅';
  if (typeof v === 'object') {
    if ((v as any).__blob) return `«blob ${(v as any).bytes}b»`;
    return JSON.stringify(v);
  }
  return String(v);
}
