import { connect, type Attachment, type ConnectInput } from '../api/attachment.js';
import type { Transaction } from '../api/transaction.js';
import type { TransactionOptions } from '../protocol/transaction.js';
import type { QueryResult, Row } from '../api/session.js';
import type { ParamValue } from '../protocol/msgcodec.js';

export interface PoolOptions extends ConnectInput {
  /** Connections kept warm even when idle. Default 0. */
  min?: number;
  /** Hard ceiling on open connections. Default 10. */
  max?: number;
  /** Max wait for a free connection before rejecting. Default 30000ms. */
  acquireTimeoutMs?: number;
  /** Idle connections above `min` are closed after this long. Default 60000ms. */
  idleTimeoutMs?: number;
  /** op_ping each connection on acquire; discard & replace if it fails. Default true. */
  validateOnAcquire?: boolean;
}

export interface PoolStats {
  total: number;
  idle: number;
  inUse: number;
  pending: number;
}

interface IdleEntry {
  conn: Attachment;
  since: number;
}

interface Waiter {
  resolve: (conn: Attachment) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A pool of Firebird connections. Each pooled connection is a full
 * `Attachment` with its own statement cache, so warm statements survive
 * across `acquire`/`release` cycles for a given physical connection.
 */
export class Pool {
  private readonly idle: IdleEntry[] = [];
  private readonly inUse = new Set<Attachment>();
  private readonly waiters: Waiter[] = [];
  private readonly min: number;
  private readonly max: number;
  private readonly acquireTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly validateOnAcquire: boolean;
  private pendingCreates = 0;
  private closed = false;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: PoolOptions) {
    this.min = Math.max(0, options.min ?? 0);
    this.max = Math.max(1, options.max ?? 10);
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 30_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.validateOnAcquire = options.validateOnAcquire ?? true;
  }

  /** Physical connections that exist or are being created. */
  private get size(): number {
    return this.idle.length + this.inUse.size + this.pendingCreates;
  }

  stats(): PoolStats {
    return { total: this.idle.length + this.inUse.size, idle: this.idle.length, inUse: this.inUse.size, pending: this.waiters.length };
  }

  /** Warm the pool up to `min` connections. Optional — acquire is lazy anyway. */
  async warmup(): Promise<void> {
    const need = Math.max(0, this.min - this.size);
    await Promise.all(Array.from({ length: need }, () => this.createInto()));
    this.ensureSweep();
  }

  private async createInto(): Promise<void> {
    this.pendingCreates++;
    try {
      const conn = await this.newConnection();
      this.idle.push({ conn, since: Date.now() });
    } finally {
      this.pendingCreates--;
    }
  }

  private newConnection(): Promise<Attachment> {
    return connect(this.options);
  }

  private ensureSweep(): void {
    if (this.sweepTimer || this.idleTimeoutMs <= 0) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), Math.max(1000, this.idleTimeoutMs / 2));
    this.sweepTimer.unref?.();
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (let i = this.idle.length - 1; i >= 0; i--) {
      const total = this.idle.length + this.inUse.size;
      if (total <= this.min) break;
      const entry = this.idle[i]!;
      if (now - entry.since >= this.idleTimeoutMs || !entry.conn.isAlive) {
        this.idle.splice(i, 1);
        void entry.conn.disconnect().catch(() => undefined);
      }
    }
    if (this.idle.length === 0 && this.inUse.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Borrow a connection. Remember to `release` it (prefer `use`). */
  async acquire(): Promise<Attachment> {
    if (this.closed) throw new Error('Pool is closed');
    this.ensureSweep();

    for (;;) {
      const entry = this.idle.pop();
      if (!entry) break;
      // Reserve the slot in `inUse` BEFORE the async validation, otherwise
      // concurrent acquires undercount capacity during the ping await and
      // overshoot `max`.
      this.inUse.add(entry.conn);
      if (!entry.conn.isAlive) {
        this.inUse.delete(entry.conn);
        void entry.conn.disconnect().catch(() => undefined);
        continue;
      }
      if (this.validateOnAcquire) {
        try {
          await entry.conn.ping();
        } catch {
          this.inUse.delete(entry.conn);
          void entry.conn.disconnect().catch(() => undefined);
          continue;
        }
      }
      return entry.conn;
    }

    if (this.size < this.max) {
      this.pendingCreates++;
      try {
        const conn = await this.newConnection();
        this.inUse.add(conn);
        return conn;
      } finally {
        this.pendingCreates--;
      }
    }

    // At capacity: wait for a release.
    return new Promise<Attachment>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out acquiring a pooled connection after ${this.acquireTimeoutMs}ms`));
      }, this.acquireTimeoutMs);
      timer.unref?.();
      this.waiters.push({ resolve, reject, timer });
    });
  }

  /** Return a borrowed connection to the pool (or discard if unhealthy). */
  release(conn: Attachment): void {
    if (!this.inUse.delete(conn)) return; // not ours / double release
    if (this.closed || !conn.isAlive) {
      void conn.disconnect().catch(() => undefined);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      this.inUse.add(conn);
      waiter.resolve(conn);
      return;
    }
    this.idle.push({ conn, since: Date.now() });
  }

  /** Acquire → run `fn` → release (even on error). The safe default. */
  async use<T>(fn: (conn: Attachment) => Promise<T>): Promise<T> {
    const conn = await this.acquire();
    try {
      return await fn(conn);
    } finally {
      this.release(conn);
    }
  }

  query(sql: string, params: ParamValue[] = []): Promise<Row[]> {
    return this.use((c) => c.query(sql, params));
  }

  run(sql: string, params: ParamValue[] = []): Promise<QueryResult> {
    return this.use((c) => c.run(sql, params));
  }

  execute(sql: string, params: ParamValue[] = []): Promise<number> {
    return this.use((c) => c.execute(sql, params));
  }

  transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
    return this.use((c) => c.transaction(fn, options));
  }

  /** Close every connection and reject pending waiters. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error('Pool is closing'));
    }
    const all = [...this.idle.map((e) => e.conn), ...this.inUse];
    this.idle.length = 0;
    this.inUse.clear();
    await Promise.all(all.map((c) => c.disconnect().catch(() => undefined)));
  }
}

/** Create (and optionally warm up) a connection pool. */
export async function createPool(options: PoolOptions): Promise<Pool> {
  const pool = new Pool(options);
  if (options.min && options.min > 0) await pool.warmup();
  return pool;
}
