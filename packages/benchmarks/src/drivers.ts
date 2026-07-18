import { connect as ffConnect, type Attachment } from '@fast-firebird/core';
import Firebird from 'node-firebird';

export interface BenchConn {
  query(sql: string, params?: unknown[]): Promise<unknown[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  /** Run the same query for each param set inside ONE explicit transaction. */
  queryLoopInTx(sql: string, paramSets: unknown[][]): Promise<void>;
  /** All rows inserted within a single transaction. */
  insertMany(sql: string, rows: unknown[][]): Promise<void>;
  /** Write then read back one blob value; returns byte length read. */
  blobRoundTrip(table: string, id: number, data: Buffer): Promise<number>;
  /** Select every row of `table` and fully read each blob; returns total bytes. */
  blobScan(table: string): Promise<number>;
  close(): Promise<void>;
  /** Round trips consumed so far, when the driver can report it. */
  roundTrips?(): number;
}

export interface BenchDriver {
  name: string;
  connect(host: string, port: number, database: string): Promise<BenchConn>;
}

const CREDS = { user: 'SYSDBA', password: 'masterkey' };

// ── fast-firebird ────────────────────────────────────────────────────────────

class FastConn implements BenchConn {
  constructor(private readonly db: Attachment) {}

  async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    return this.db.query(sql, params as never);
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.db.execute(sql, params as never);
  }

  async queryLoopInTx(sql: string, paramSets: unknown[][]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const p of paramSets) await tx.query(sql, p as never);
    });
  }

  async insertMany(sql: string, rows: unknown[][]): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const row of rows) await tx.execute(sql, row as never);
    });
  }

  async blobRoundTrip(table: string, id: number, data: Buffer): Promise<number> {
    await this.db.execute(`update or insert into ${table} (id, data) values (?, ?) matching (id)`, [id, data]);
    const [row] = await this.db.query(`select data from ${table} where id = ?`, [id]);
    return (row!.DATA as Buffer).length;
  }

  async blobScan(table: string): Promise<number> {
    // Eager mode (the default): blobs are materialized during the fetch —
    // inline on FB5 protocol 19, pipelined open/get/close otherwise.
    const rows = await this.db.query(`select id, data from ${table} order by id`);
    let total = 0;
    for (const row of rows) total += (row.DATA as Buffer).length;
    return total;
  }

  async close(): Promise<void> {
    await this.db.disconnect();
  }

  roundTrips(): number {
    return this.db.roundTrips;
  }
}

export const fastFirebird: BenchDriver = {
  name: 'fast-firebird',
  async connect(host, port, database) {
    return new FastConn(await ffConnect({ host, port, database, ...CREDS }));
  },
};

// ── node-firebird ────────────────────────────────────────────────────────────

interface NfDb {
  query(sql: string, params: unknown[], cb: (err: Error | null, rows?: unknown[]) => void): void;
  transaction(iso: unknown, cb: (err: Error | null, tx?: NfTx) => void): void;
  detach(cb: (err: Error | null) => void): void;
}
interface NfTx {
  query(sql: string, params: unknown[], cb: (err: Error | null, rows?: unknown[]) => void): void;
  commit(cb: (err: Error | null) => void): void;
}

type NfBlobCb = (cb: (err: Error | null, name: string, e: NodeJS.EventEmitter) => void) => void;

function readNfBlob(blob: NfBlobCb): Promise<number> {
  return new Promise((resolve, reject) => {
    blob((err, _name, emitter) => {
      if (err) return reject(err);
      let total = 0;
      emitter.on('data', (chunk: Buffer) => (total += chunk.length));
      emitter.on('end', () => resolve(total));
      emitter.on('error', reject);
    });
  });
}

class NodeFirebirdConn implements BenchConn {
  constructor(private readonly db: NfDb) {}

  query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    return new Promise((res, rej) => this.db.query(sql, params, (e, rows) => (e ? rej(e) : res(rows ?? []))));
  }

  async execute(sql: string, params: unknown[] = []): Promise<void> {
    await this.query(sql, params);
  }

  private txLoop(sql: string, paramSets: unknown[][]): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.transaction(Firebird.ISOLATION_READ_COMMITTED, (err, tx) => {
        if (err || !tx) return reject(err);
        const next = (i: number): void => {
          if (i >= paramSets.length) {
            tx.commit((e) => (e ? reject(e) : resolve()));
            return;
          }
          tx.query(sql, paramSets[i]!, (e) => (e ? reject(e) : next(i + 1)));
        };
        next(0);
      });
    });
  }

  queryLoopInTx(sql: string, paramSets: unknown[][]): Promise<void> {
    return this.txLoop(sql, paramSets);
  }

  insertMany(sql: string, rows: unknown[][]): Promise<void> {
    return this.txLoop(sql, rows);
  }

  async blobRoundTrip(table: string, id: number, data: Buffer): Promise<number> {
    await this.query(`update or insert into ${table} (id, data) values (?, ?) matching (id)`, [id, data]);
    const rows = (await this.query(`select data from ${table} where id = ?`, [id])) as Array<{ DATA: NfBlobCb }>;
    return readNfBlob(rows[0]!.DATA);
  }

  async blobScan(table: string): Promise<number> {
    // node-firebird returns blob columns as callbacks; each read opens the
    // blob, pulls segments and closes it — sequential round trips per row.
    const rows = (await this.query(`select id, data from ${table} order by id`)) as Array<{ DATA: NfBlobCb }>;
    let total = 0;
    for (const row of rows) total += await readNfBlob(row.DATA);
    return total;
  }

  close(): Promise<void> {
    return new Promise((res) => this.db.detach(() => res()));
  }
}

export const nodeFirebird: BenchDriver = {
  name: 'node-firebird',
  connect(host, port, database) {
    return new Promise((resolve, reject) => {
      // node-firebird 2.x negotiates Srp256 and inline blobs by default —
      // both drivers run at their out-of-the-box settings.
      const opts = { host, port, database, ...CREDS, lowercase_keys: false };
      Firebird.attach(opts as never, (err: Error | null, db: NfDb) => {
        if (err) return reject(err);
        resolve(new NodeFirebirdConn(db));
      });
    });
  },
};
