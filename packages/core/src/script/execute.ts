import { parseScript, type ParsedStatement, type ParseScriptOptions } from './parser.js';
import type { Attachment } from '../api/attachment.js';
import type { Transaction } from '../api/transaction.js';

export interface StatementResult {
  statement: ParsedStatement;
  index: number;
  rowsAffected: number;
  rowCount: number;
  error?: Error;
}

export interface ScriptExecutionResult {
  statements: StatementResult[];
  /** Statements that executed without error. */
  succeeded: number;
  /** Statements that raised (only >0 with continueOnError). */
  failed: number;
}

export interface ExecuteScriptOptions extends ParseScriptOptions {
  /**
   * Transaction scope:
   *  - 'perScript'    (default) one transaction wraps the whole script;
   *  - 'perStatement' a fresh transaction per statement (autocommit-like);
   *  - 'none'         caller has no transaction; each statement uses its own
   *                   short transaction via `attachment.run` semantics.
   */
  transaction?: 'perScript' | 'perStatement' | 'none';
  /** Keep going after a statement fails (collects errors). Default false. */
  continueOnError?: boolean;
  /** Called after each statement (success or, with continueOnError, failure). */
  onProgress?: (result: StatementResult, total: number) => void;
}

/**
 * Parse and execute a multi-statement Firebird script. DDL and DML are run in
 * order; `SET TERM` and PSQL bodies are handled by the parser.
 */
export async function executeScript(
  attachment: Attachment,
  script: string,
  options: ExecuteScriptOptions = {},
): Promise<ScriptExecutionResult> {
  const mode = options.transaction ?? 'perScript';
  const parsed = parseScript(script, options);
  const results: StatementResult[] = [];
  let succeeded = 0;
  let failed = 0;

  const runOne = async (stmt: ParsedStatement, index: number, tx: Transaction | null): Promise<void> => {
    let result: StatementResult;
    try {
      const qr = tx ? await tx.run(stmt.sql) : await attachment.run(stmt.sql);
      result = { statement: stmt, index, rowsAffected: qr.rowsAffected, rowCount: qr.rows.length };
      succeeded++;
    } catch (err) {
      result = { statement: stmt, index, rowsAffected: 0, rowCount: 0, error: err as Error };
      failed++;
    }
    results.push(result);
    options.onProgress?.(result, parsed.length);
    if (result.error && !options.continueOnError) throw result.error;
  };

  if (mode === 'perScript') {
    const tx = await attachment.startTransaction();
    try {
      for (let idx = 0; idx < parsed.length; idx++) {
        await runOne(parsed[idx]!, idx, tx);
      }
      await tx.commit();
    } catch (err) {
      if (!tx.isFinished) await tx.rollback().catch(() => undefined);
      throw err;
    }
  } else if (mode === 'perStatement') {
    for (let idx = 0; idx < parsed.length; idx++) {
      const stmt = parsed[idx]!;
      const tx = await attachment.startTransaction();
      let ok = false;
      try {
        await runOne(stmt, idx, tx);
        ok = true;
      } finally {
        if (!tx.isFinished) {
          if (ok) await tx.commit();
          else await tx.rollback().catch(() => undefined);
        }
      }
    }
  } else {
    for (let idx = 0; idx < parsed.length; idx++) {
      await runOne(parsed[idx]!, idx, null);
    }
  }

  return { statements: results, succeeded, failed };
}
