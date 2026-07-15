import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attachment } from '@fast-firebird/core';
import type { FirebirdDatabase } from './driver.js';

/**
 * Plain-SQL migrations for Firebird. drizzle-kit cannot generate for a
 * Firebird dialect, so migrations are hand-written `.sql` files applied in
 * lexicographic order (`0001_init.sql`, `0002_add_index.sql`, …). Each file
 * may contain multiple statements (full isql syntax incl. `SET TERM` / PSQL —
 * parsed by @fast-firebird/core's script engine); applied names are recorded
 * in a tracking table.
 *
 * Statements commit INDIVIDUALLY (isql AUTODDL-style): Firebird DML cannot
 * see a table created in the same uncommitted transaction, so a
 * whole-file transaction would break the common `create table` + seed-data
 * migration. The consequence: a failing file may be PARTIALLY applied and is
 * not recorded — fix the file (idempotently: the already-committed leading
 * statements re-run on retry) or repair by hand. Keep migrations small and
 * single-purpose.
 */
export interface MigrateConfig {
  migrationsFolder: string;
  /** Tracking table name. Default FF_MIGRATIONS. */
  migrationsTable?: string;
}

export interface MigrateResult {
  /** File names applied by this run, in order. */
  applied: string[];
  /** File names already recorded and skipped. */
  skipped: string[];
}

/** Accepts the ORM handle or a bare core Attachment. */
function toAttachment(db: FirebirdDatabase<Record<string, unknown>> | Attachment): Attachment {
  return '$client' in db ? (db.$client as Attachment) : (db as Attachment);
}

export async function migrate(
  db: FirebirdDatabase<Record<string, unknown>> | Attachment,
  config: MigrateConfig,
): Promise<MigrateResult> {
  const att = toAttachment(db);
  const table = (config.migrationsTable ?? 'FF_MIGRATIONS').toUpperCase();
  if (!/^[A-Z][A-Z0-9_$]*$/.test(table)) throw new Error(`Invalid migrations table name: ${table}`);

  try {
    await att.execute(
      `create table ${table} (name varchar(255) character set utf8 not null primary key, applied_at timestamp default current_timestamp not null)`,
    );
  } catch (err) {
    // Already present (possibly created by a concurrent migrator run).
    if (!/already exists|equal to existing/i.test(String((err as Error).message))) throw err;
  }

  const files = (await readdir(config.migrationsFolder)).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
  const done = new Set((await att.query<{ NAME: string }>(`select name from ${table}`)).map((r) => r.NAME));

  const result: MigrateResult = { applied: [], skipped: [] };
  for (const file of files) {
    if (done.has(file)) {
      result.skipped.push(file);
      continue;
    }
    const sql = await readFile(join(config.migrationsFolder, file), 'utf8');
    // AUTODDL-style: each statement commits on its own (see module docs); a
    // failure aborts the run and the file stays unrecorded.
    await att.executeScript(sql, { transaction: 'perStatement' });
    await att.execute(`insert into ${table} (name) values (?)`, [file]);
    result.applied.push(file);
  }
  return result;
}
