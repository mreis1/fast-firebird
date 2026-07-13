import { useEffect, useMemo, useState } from 'react';
import {
  api,
  useSse,
  BENCH_TYPES,
  type BenchColumnType,
  type BenchLane,
  type CustomBenchResult,
  type Engine,
  type Feature,
  type QueryResult,
  type ServerCfg,
  type ServerInfo,
  type TryResult,
  type TxWait,
} from './api';

const ENGINES: Engine[] = ['core', 'drizzle', 'compat'];

export function App() {
  const [servers, setServers] = useState<ServerCfg[]>([]);
  const [active, setActive] = useState<string>('fb5');
  const [adding, setAdding] = useState(false);
  /** Servers the user explicitly disconnected — panels stay down until reconnect. */
  const [offline, setOffline] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.servers().then((r) => setServers(r.servers));
  }, []);

  const disconnect = async (id: string) => {
    await api.disconnectServer(id).catch(() => void 0);
    setOffline((prev) => new Set(prev).add(id));
  };
  const reconnect = async (id: string) => {
    await api.connectServer(id);
    setOffline((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };
  const isOffline = offline.has(active);
  const activeLabel = servers.find((s) => s.id === active)?.label ?? active;
  /** Bumped when a server's handshake config changes — remounts panels so they reconnect. */
  const [nonce, setNonce] = useState(0);
  const updateConfig = async (patch: { wireCompression?: boolean; charset?: string; charsetNoneEncoding?: string }) => {
    const { server } = await api.updateServer(active, patch);
    setServers((prev) => prev.map((s) => (s.id === server.id ? server : s)));
    setNonce((n) => n + 1); // config applies on reconnect — remount all panels
  };
  const toggleCompression = (want: boolean) => updateConfig({ wireCompression: want });

  return (
    <div className="app">
      <header className="top">
        <img className="mark" src="/mark.svg" alt="" width={40} height={40} />
        <h1>
          <span className="wm-fast">fast-</span><span className="wm-bird">firebird</span>{' '}
          <span style={{ color: 'var(--muted)', fontWeight: 400 }}>· live dashboard</span>
        </h1>
        <span className="sub">core · drizzle · node-firebird2-ext — one stack, three faces</span>
      </header>

      <div className="servers">
        {servers.map((s) => (
          <span
            key={s.id}
            role="button"
            className={`tab ${active === s.id ? 'active' : ''}`}
            onClick={() => setActive(s.id)}
          >
            <span className="dot" /> {s.label}
            {!s.builtin && (
              <span
                className="tab-x"
                title={`Remove ${s.label}`}
                onClick={async (e) => {
                  e.stopPropagation();
                  await api.deleteServer(s.id).catch(() => void 0);
                  setServers((prev) => {
                    const next = prev.filter((x) => x.id !== s.id);
                    setActive((cur) => (cur === s.id ? next[0]?.id ?? 'fb5' : cur));
                    return next;
                  });
                }}
              >
                ✕
              </span>
            )}
          </span>
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

      {isOffline ? (
        <div className="card wide">
          <h2>Connection</h2>
          <div className="note" style={{ marginTop: 0, marginBottom: 12 }}>
            disconnected — pools and attachments for “{activeLabel}” are closed on the server.
          </div>
          <button className="btn" onClick={() => reconnect(active)}>Connect</button>
        </div>
      ) : (
        <div className="grid">
          <InfoPanel key={`info-${active}-${nonce}`} id={active} onDisconnect={() => disconnect(active)} onToggleCompression={toggleCompression} onUpdateConfig={updateConfig} />
          <PoolPanel key={`pool-${active}-${nonce}`} id={active} />
          <QueryPanel key={`q-${active}`} id={active} />
          <FeaturesPanel key={`ft-${active}`} id={active} />
          <EventsPanel key={`ev-${active}-${nonce}`} id={active} />
          <StreamPanel key={`st-${active}`} id={active} />
          <BlobPanel key={`bl-${active}`} id={active} />
          <BenchPanel key={`bn-${active}`} id={active} />
          <CustomBenchPanel key={`cb-${active}`} id={active} />
        </div>
      )}

      <div className="footer">
        Pure-TypeScript Firebird driver · SRP + WireCrypt + WireCompression · CHARSET NONE/win1252 · FB 3/4/5
      </div>
    </div>
  );
}

/** Connection charsets offered by the picker (any lc_ctype works via custom servers). */
const CHARSETS = ['NONE', 'UTF8', 'WIN1252', 'ISO8859_1', 'WIN1250', 'WIN1251'];
/** One-shot transcoder presets for CHARSET NONE bytes (iconv-lite names). */
const NONE_PRESETS = ['win1252', 'latin1', 'cp1250', 'cp1251', 'utf8'];

/**
 * Charset picker: connection charset + (for NONE) how raw bytes are
 * transcoded — preset encodings or a custom iconv-lite name.
 */
function CharsetPicker({ charset, noneEncoding, onChange }: {
  charset: string;
  noneEncoding: string;
  onChange: (charset: string, noneEncoding: string) => void;
}) {
  const [customMode, setCustomMode] = useState(!NONE_PRESETS.includes(noneEncoding));
  return (
    <>
      <select
        style={{ maxWidth: 110 }}
        title="Connection charset (lc_ctype). NONE = raw bytes, decoded client-side by the transcoder."
        value={charset}
        onChange={(e) => onChange(e.target.value, noneEncoding)}
      >
        {CHARSETS.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      {charset === 'NONE' && (
        <span className="unit" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
          ⇢ decode as
          {customMode ? (
            <input
              style={{ maxWidth: 110 }}
              placeholder="iconv name (cp437…)"
              value={noneEncoding}
              onChange={(e) => onChange(charset, e.target.value)}
            />
          ) : (
            <select
              style={{ maxWidth: 110 }}
              title="Transcoder for CHARSET NONE bytes — the legacy-database escape hatch (win1252 covers €, smart quotes, em dashes)."
              value={noneEncoding}
              onChange={(e) => {
                if (e.target.value === '__custom') setCustomMode(true);
                else onChange(charset, e.target.value);
              }}
            >
              {NONE_PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
              <option value="__custom">custom…</option>
            </select>
          )}
        </span>
      )}
    </>
  );
}

function AddServer({ onAdd }: { onAdd: (cfg: any) => void }) {
  const [f, setF] = useState({ label: 'Custom', host: '127.0.0.1', port: 3050, database: '', user: 'SYSDBA', password: 'masterkey' });
  const [zlib, setZlib] = useState(false);
  const [cs, setCs] = useState({ charset: 'NONE', enc: 'win1252' });
  const [role, setRole] = useState('');
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
        <input style={{ maxWidth: 110 }} placeholder="role (optional)" value={role} onChange={(e) => setRole(e.target.value)} title="SQL role sent at attach (DPB), e.g. RDB$ADMIN" />
        <CharsetPicker charset={cs.charset} noneEncoding={cs.enc} onChange={(charset, enc) => setCs({ charset, enc })} />
        <label className="unit" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', whiteSpace: 'nowrap' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={zlib} onChange={(e) => setZlib(e.target.checked)} />
          zlib compression
        </label>
        <button className="btn" onClick={() => onAdd({ ...f, port: Number(f.port), wireCompression: zlib, charset: cs.charset, charsetNoneEncoding: cs.enc, role: role.trim() || undefined })}>Connect</button>
      </div>
      <div className="note">
        Read/write, wide open — points at whatever database you give it. Compression needs the server to allow it
        (<code>WireCompression = true</code> in firebird.conf). CHARSET NONE + a transcoder is the legacy-database
        mode: raw bytes decoded client-side (win1252 covers €, smart quotes, em dashes).
      </div>
    </div>
  );
}

function InfoPanel({ id, onDisconnect, onToggleCompression, onUpdateConfig }: {
  id: string;
  onDisconnect: () => void;
  onToggleCompression: (want: boolean) => void;
  onUpdateConfig: (patch: { charset?: string; charsetNoneEncoding?: string; role?: string }) => void;
}) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Non-null while the connect-settings editor is open (draft values). */
  const [csEdit, setCsEdit] = useState<{ charset: string; enc: string; role: string } | null>(null);
  useEffect(() => {
    setInfo(null);
    setErr(null);
    api.info(id).then(setInfo, (e) => setErr(String(e.message || e)));
  }, [id]);

  return (
    <div className="card">
      <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Connection
        <button className="btn ghost" style={{ padding: '3px 10px', fontSize: 11, textTransform: 'none', letterSpacing: 0 }} onClick={onDisconnect}>
          disconnect
        </button>
      </h2>
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
          <span>
            {info.wireCompressed ? <span className="badge on">zlib</span> : <span className="badge off">off</span>}{' '}
            <a
              style={{ color: 'var(--accent-2)', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}
              title="zlib is negotiated at the handshake: the client must request it AND the server must have WireCompression = true in firebird.conf. Reconnects this server."
              onClick={() => onToggleCompression(!info.config.wireCompression)}
            >
              {info.config.wireCompression ? 'disable' : 'enable'} & reconnect
            </a>
          </span>
          <b>charset</b>
          <span>
            {csEdit ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <CharsetPicker charset={csEdit.charset} noneEncoding={csEdit.enc} onChange={(charset, enc) => setCsEdit({ ...csEdit, charset, enc })} />
                <input
                  style={{ maxWidth: 110 }}
                  placeholder="role (optional)"
                  title="SQL role sent at attach (DPB), e.g. RDB$ADMIN"
                  value={csEdit.role}
                  onChange={(e) => setCsEdit({ ...csEdit, role: e.target.value })}
                />
                <a
                  style={{ color: 'var(--accent-2)', cursor: 'pointer', fontSize: 11 }}
                  onClick={() => onUpdateConfig({ charset: csEdit.charset, charsetNoneEncoding: csEdit.enc, role: csEdit.role.trim() })}
                >
                  apply & reconnect
                </a>
                <a style={{ color: 'var(--muted)', cursor: 'pointer', fontSize: 11 }} onClick={() => setCsEdit(null)}>cancel</a>
              </span>
            ) : (
              <>
                {info.config.charset ?? 'NONE'}
                {(info.config.charset ?? 'NONE') === 'NONE' && (
                  <span className="badge on" style={{ marginLeft: 6 }} title="CHARSET NONE bytes are transcoded client-side with this encoding.">
                    ⇢ {info.config.charsetNoneEncoding ?? 'win1252'}
                  </span>
                )}{' '}
                <a
                  style={{ color: 'var(--accent-2)', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}
                  title="Charset and role are connect-time (DPB) settings — changing them reconnects this server."
                  onClick={() => setCsEdit({ charset: info.config.charset ?? 'NONE', enc: info.config.charsetNoneEncoding ?? 'win1252', role: info.config.role ?? '' })}
                >
                  change
                </a>
              </>
            )}
          </span>
          <b>role</b>
          <span>{info.config.role || '—'}</span>
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

/**
 * Lock-wait picker: default (engine default) | wait | no wait | wait N seconds.
 * Emits undefined / true / false / number — the shape core's TPB builder takes.
 */
function TxWaitPicker({ value, onChange, defaultLabel = 'default' }: { value: TxWait; onChange: (v: TxWait) => void; defaultLabel?: string }) {
  const [secs, setSecs] = useState(typeof value === 'number' ? value : 10);
  const mode = value === undefined ? 'default' : value === true ? 'wait' : value === false ? 'nowait' : 'timeout';
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <span className="unit">lock wait</span>
      <div className="seg">
        {(['default', 'wait', 'nowait', 'timeout'] as const).map((m) => (
          <button
            key={m}
            className={mode === m ? 'active' : ''}
            onClick={() => onChange(m === 'default' ? undefined : m === 'wait' ? true : m === 'nowait' ? false : secs)}
          >
            {m === 'default' ? defaultLabel : m === 'nowait' ? 'no wait' : m === 'timeout' ? 'wait for…' : m}
          </button>
        ))}
      </div>
      {mode === 'timeout' && (
        <>
          <input
            style={{ maxWidth: 64 }}
            type="number"
            min={1}
            value={secs}
            onChange={(e) => {
              const n = Math.max(1, Number(e.target.value) || 1);
              setSecs(n);
              onChange(n);
            }}
          />
          <span className="unit">s</span>
        </>
      )}
    </div>
  );
}

function QueryPanel({ id }: { id: string }) {
  const [sql, setSql] = useState("select rdb$relation_name as name, rdb$relation_id as id\nfrom rdb$relations where rdb$system_flag = 0\norder by 1");
  const [paramsText, setParamsText] = useState('[]');
  const [engine, setEngine] = useState<Engine | 'all'>('all');
  const [txWait, setTxWait] = useState<TxWait>(undefined);
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
      const res = await Promise.all(engines.map((e) => api.query(id, e, sql, params, txWait)));
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
        <TxWaitPicker value={txWait} onChange={setTxWait} />
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
  const { events } = useSse<any>(url, { closeOn: (m) => !!(m.done || m.error) });
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
      {last?.error && <div className="err-text" style={{ marginTop: 10 }}>{last.error}</div>}
      {last && !last.error && (
        <>
          <div className="row mt" style={{ justifyContent: 'space-between' }}>
            <span style={{ fontFamily: 'var(--mono)' }}>{last.seen ?? 0} / {last.total ?? count} rows</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
              {last.ms} ms{last.done ? ` ✓ · ${Math.round((last.seen / Math.max(1, last.ms)) * 1000).toLocaleString()} rows/s` : ''}
            </span>
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
      <div className="note">
        All lanes bind parameters: core/compat run <code>insert … values (?, ?)</code>; the drizzle lane goes through the
        query builder (<code>db.insert().values()</code>), which binds via core underneath.
      </div>
    </div>
  );
}

function FeaturesPanel({ id }: { id: string }) {
  const [version, setVersion] = useState<number | null>(null);
  const [features, setFeatures] = useState<Feature[]>([]);
  useEffect(() => {
    setFeatures([]);
    setVersion(null);
    api.features(id).then((r) => {
      setVersion(r.version);
      setFeatures(r.features);
    });
  }, [id]);

  return (
    <div className="card wide">
      <h2>Feature explorer{version ? ` — what Firebird ${version} unlocks` : ''}</h2>
      <div className="feat-grid">
        {features.map((f) => (
          <FeatureCard key={f.id} id={id} f={f} />
        ))}
      </div>
    </div>
  );
}

function FeatureCard({ id, f }: { id: string; f: Feature }) {
  const [res, setRes] = useState<TryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const cols = res && res.rows.length ? Object.keys(res.rows[0]) : [];
  return (
    <div className={`feat ${f.available ? '' : 'locked'}`}>
      <div className="feat-head">
        <span className="feat-title">{f.title}</span>
        <span className={`badge since${f.since}`}>FB {f.since}+</span>
      </div>
      <div className="feat-blurb">{f.blurb}</div>
      <details>
        <summary>SQL</summary>
        <pre className="feat-sql">{[...f.setup, f.sql].join(';\n')}</pre>
      </details>
      <div className="row mt">
        <button
          className="btn ghost"
          disabled={!f.available || busy}
          onClick={async () => {
            setBusy(true);
            setRes(await api.tryFeature(id, f.setup, f.sql));
            setBusy(false);
          }}
        >
          {busy ? '…' : f.available ? 'Try it' : `needs FB ${f.since}`}
        </button>
        {res && !res.error && <span className="unit">{res.rowCount} row{res.rowCount === 1 ? '' : 's'} · {res.ms} ms</span>}
      </div>
      {res?.error && <div className="err-text" style={{ marginTop: 8 }}>{res.error}</div>}
      {res && !res.error && res.rows.length > 0 && (
        <div className="scroll" style={{ marginTop: 8, maxHeight: 160 }}>
          <table className="res">
            <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {res.rows.slice(0, 50).map((row, i) => (
                <tr key={i}>{cols.map((c) => <td key={c}>{fmt(row[c])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface BenchCol {
  name: string;
  type: BenchColumnType;
  file: File | null;
}

const fileToBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(',')[1]!);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

function CustomBenchPanel({ id }: { id: string }) {
  const [cols, setCols] = useState<BenchCol[]>([
    { name: 'NAME', type: 'varchar(60)', file: null },
    { name: 'PRICE', type: 'numeric(12,2)', file: null },
    { name: 'DOC', type: 'blob binary', file: null },
  ]);
  const [rows, setRows] = useState(500);
  const [ddlWait, setDdlWait] = useState<TxWait>(undefined); // server default: wait 10 s
  const [fetchConns, setFetchConns] = useState(1);
  const [res, setRes] = useState<CustomBenchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const update = (i: number, patch: Partial<BenchCol>) =>
    setCols((prev) => prev.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const run = async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const payload = await Promise.all(
        cols.map(async (c) => ({
          name: c.name,
          type: c.type,
          dataBase64: c.type.startsWith('blob') && c.file ? await fileToBase64(c.file) : undefined,
        })),
      );
      const r = await api.customBench(id, payload, rows, ddlWait, fetchConns);
      if (r.error) setErr(r.error);
      else setRes(r);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card wide">
      <h2>Custom benchmark — your table structure, timed</h2>
      {cols.map((c, i) => (
        <div className="row" style={{ marginBottom: 6 }} key={i}>
          <input
            style={{ maxWidth: 160 }}
            value={c.name}
            placeholder={`COL_${i}`}
            onChange={(e) => update(i, { name: e.target.value.toUpperCase() })}
          />
          <select
            style={{ maxWidth: 170 }}
            value={c.type}
            onChange={(e) => update(i, { type: e.target.value as BenchColumnType, file: null })}
          >
            {BENCH_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          {c.type.startsWith('blob') && (
            <label className="file-pick">
              <input type="file" onChange={(e) => update(i, { file: e.target.files?.[0] ?? null })} />
              {c.file ? `${c.file.name} (${(c.file.size / 1024).toFixed(0)} KiB)` : 'pick a file… (default: 64 KiB)'}
            </label>
          )}
          <button className="btn ghost" style={{ padding: '7px 11px' }} onClick={() => setCols((p) => p.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="row mt">
        <button
          className="btn ghost"
          onClick={() => setCols((p) => [...p, { name: `COL_${p.length}`, type: 'integer', file: null }])}
          disabled={cols.length >= 12}
        >
          + column
        </button>
        <span style={{ marginLeft: 'auto' }} />
        <TxWaitPicker value={ddlWait} onChange={setDdlWait} defaultLabel="wait 10 s" />
        <span className="unit">fetch conns</span>
        <div className="seg">
          {[1, 2, 4, 8].map((n) => (
            <button key={n} className={fetchConns === n ? 'active' : ''} onClick={() => setFetchConns(n)}>
              {n}
            </button>
          ))}
        </div>
        <span className="unit">rows</span>
        <input style={{ maxWidth: 110 }} type="number" value={rows} onChange={(e) => setRows(Number(e.target.value))} />
        <button className="btn" onClick={run} disabled={busy || cols.length === 0}>
          {busy ? 'benchmarking…' : 'Test'}
        </button>
      </div>
      {err && <div className="err-text" style={{ marginTop: 10 }}>{err}</div>}
      {res && (
        <>
          <div className="lanes" style={{ marginTop: 14, gridTemplateColumns: '1fr 1fr' }}>
            <div className="lane">
              <div className="name core">insert · {res.rows} rows</div>
              <div className="metric">{res.insertMs}<span className="unit"> ms</span></div>
              <div className="unit">{res.insertRowsPerSec.toLocaleString()} rows/s{res.blobBytesPerRow > 0 ? ` · ${(res.blobBytesPerRow / 1024).toFixed(0)} KiB blob/row` : ''}</div>
            </div>
            <div className="lane">
              <div className="name drizzle">
                fetch · {res.fetchedRows} rows{res.blobBytesPerRow > 0 ? ' + blobs' : ''}
                {res.fetchConnections > 1 ? ` · ${res.fetchConnections} conns` : ''}
              </div>
              <div className="metric">{res.fetchMs}<span className="unit"> ms</span></div>
              <div className="unit">
                {res.fetchRowsPerSec.toLocaleString()} rows/s
                {res.blobThroughputMBps != null ? ` · ${res.blobThroughputMBps} MB/s blob · ${(res.totalBlobBytes / 1024 / 1024).toFixed(1)} MiB total` : ''}
              </div>
            </div>
          </div>
          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--accent-2)', fontSize: 12 }}>DDL used</summary>
            <pre className="feat-sql">{res.ddl}</pre>
          </details>
        </>
      )}
      <div className="note">
        Inserts run parameterized in one transaction (statement-cache reuse); the fetch is a full scan with eager blob
        materialization. Blob columns use your picked file per row.
      </div>
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
