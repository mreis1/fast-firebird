import { parseScript, type ParsedStatement, type ParseScriptOptions } from './parser.js';
import type { Attachment } from '../api/attachment.js';
import type { Transaction } from '../api/transaction.js';
import type { TransactionOptions } from '../protocol/transaction.js';
import { FirebirdError } from '../api/errors.js';

export interface StatementResult {
  statement: ParsedStatement;
  index: number;
  rowsAffected: number;
  rowCount: number;
  error?: Error | FirebirdError;
  /**
   * Firebird gds code when `error` is a `FirebirdError` — the classification
   * key for retry-vs-stop policies (e.g. 335544345 "lock conflict on no wait
   * transaction" → retry; a constraint violation → stop).
   */
  gdsCode?: number;
  /** SQLSTATE when `error` is a `FirebirdError`. */
  sqlState?: string;
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
   *                   short transaction via `attachment.run` semantics;
   *  - a `Transaction` instance: every statement runs on the CALLER's
   *    transaction — the script never commits or rolls it back (compose the
   *    script atomically with your own work; on a failing statement without
   *    `continueOnError` the error propagates and the transaction stays
   *    alive for you to roll back).
   */
  transaction?: 'perScript' | 'perStatement' | 'none' | Transaction;
  /**
   * `TransactionOptions` for the transaction(s) the script opens — applies to
   * 'perScript' and 'perStatement' (on top of the connection's
   * `defaultTransaction`). Invalid with 'none' (nothing to configure — the
   * implicit per-statement transactions already follow `defaultTransaction`)
   * or with a caller-supplied `Transaction` (its options are fixed): throws.
   */
  transactionOptions?: TransactionOptions;
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
  if (options.transactionOptions && (mode === 'none' || typeof mode !== 'string')) {
    throw new Error(
      mode === 'none'
        ? "executeScript: transactionOptions is invalid with transaction: 'none' — the implicit per-statement transactions follow the connection's defaultTransaction"
        : 'executeScript: transactionOptions is invalid with a caller-supplied Transaction — its options are already fixed',
    );
  }
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
      if (err instanceof FirebirdError) {
        result.gdsCode = err.gdsCode;
        result.sqlState = err.sqlState;
      }
      failed++;
    }
    results.push(result);
    options.onProgress?.(result, parsed.length);
    if (result.error && !options.continueOnError) throw result.error;
  };

  if (typeof mode !== 'string') {
    // Caller-owned transaction: run everything on it, commit/rollback is the
    // caller's decision — including after a propagated statement error.
    for (let idx = 0; idx < parsed.length; idx++) {
      await runOne(parsed[idx]!, idx, mode);
    }
  } else if (mode === 'perScript') {
    const tx = await attachment.startTransaction(options.transactionOptions);
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
      const tx = await attachment.startTransaction(options.transactionOptions);
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
