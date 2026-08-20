import { parseScript, type ClientCommand, type ParsedStatement, type ParseScriptOptions } from './parser.js';
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
  /**
   * Client-side script commands (`kind: 'client'` — `COMMIT`/`ROLLBACK`
   * [`RETAIN`], `SET TRANSACTION`, `SET AUTODDL`, `RECONNECT`):
   *  - `'process'` (default): execute them driver-side, isql-style — COMMIT/
   *    ROLLBACK checkpoint the perScript transaction (no-ops in
   *    'perStatement'/'none', which already autocommit), SET TRANSACTION
   *    replaces the options for subsequent transactions, SET AUTODDL ON
   *    commits after each DDL statement, RECONNECT re-attaches;
   *  - `'error'`: reject each one as a statement error (strict-DSQL scripts;
   *    `continueOnError` applies).
   * Either way, transaction-control statements are NEVER sent to the server —
   * a server-executed COMMIT would silently desync the transaction the
   * executor manages. With a caller-supplied `Transaction`, every client
   * command is an error: the caller owns the transaction and the connection.
   */
  clientCommands?: 'process' | 'error';
}

/** Short display name for error messages. */
function describeCommand(c: ClientCommand): string {
  switch (c.op) {
    case 'reconnect':
      return 'RECONNECT';
    case 'commit':
      return c.retain ? 'COMMIT RETAIN' : 'COMMIT';
    case 'rollback':
      return c.retain ? 'ROLLBACK RETAIN' : 'ROLLBACK';
    case 'setTransaction':
      return 'SET TRANSACTION';
    case 'setAutoDdl':
      return `SET AUTODDL ${c.on ? 'ON' : 'OFF'}`;
    case 'unsupported':
      return 'client command';
  }
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
  const clientCommands = options.clientCommands ?? 'process';
  const parsed = parseScript(script, options);
  const results: StatementResult[] = [];
  let succeeded = 0;
  let failed = 0;

  const emitOk = (stmt: ParsedStatement, index: number, rowsAffected = 0, rowCount = 0): void => {
    const result: StatementResult = { statement: stmt, index, rowsAffected, rowCount };
    succeeded++;
    results.push(result);
    options.onProgress?.(result, parsed.length);
  };

  /** Records a failure; rethrows it unless continueOnError. */
  const emitError = (stmt: ParsedStatement, index: number, err: Error): void => {
    const result: StatementResult = { statement: stmt, index, rowsAffected: 0, rowCount: 0, error: err };
    if (err instanceof FirebirdError) {
      result.gdsCode = err.gdsCode;
      result.sqlState = err.sqlState;
    }
    failed++;
    results.push(result);
    options.onProgress?.(result, parsed.length);
    if (!options.continueOnError) throw err;
  };

  /** Send one server statement; true on success. Throws per emitError rules. */
  const runOne = async (stmt: ParsedStatement, index: number, tx: Transaction | null): Promise<boolean> => {
    try {
      const qr = tx ? await tx.run(stmt.sql) : await attachment.run(stmt.sql);
      emitOk(stmt, index, qr.rowsAffected, qr.rows.length);
      return true;
    } catch (err) {
      emitError(stmt, index, err as Error);
      return false;
    }
  };

  // WIRE GUARD: a statement recognized as a client command (kind 'client')
  // is NEVER transmitted to the server — every branch below either processes
  // it driver-side or records an error. This is unconditional: a script
  // COMMIT executed server-side would finish the executor's transaction
  // underneath it, and an unmappable SET TRANSACTION variant must be rejected
  // by name, not slip through because the recognizer gave up on its details.
  const rejectClient = (stmt: ParsedStatement, index: number, why: string): void =>
    emitError(stmt, index, new Error(`executeScript: ${why}`));

  /** Handles the branches common to every mode; true when the command was consumed. */
  const rejectCommon = (stmt: ParsedStatement, index: number, c: ClientCommand): boolean => {
    if (c.op === 'unsupported') {
      rejectClient(stmt, index, c.reason);
      return true;
    }
    if (clientCommands === 'error') {
      rejectClient(stmt, index, `client command ${describeCommand(c)} encountered with clientCommands: 'error'`);
      return true;
    }
    return false;
  };

  if (typeof mode !== 'string') {
    // Caller-owned transaction: run everything on it, commit/rollback is the
    // caller's decision — so every client command is an error (the executor
    // promised never to finish, replace, or reconnect what the caller owns).
    for (let idx = 0; idx < parsed.length; idx++) {
      const stmt = parsed[idx]!;
      const c = stmt.client;
      if (c) {
        if (rejectCommon(stmt, idx, c)) continue;
        rejectClient(
          stmt,
          idx,
          c.op === 'reconnect'
            ? 'RECONNECT is not allowed with a caller-supplied Transaction — the caller owns the connection'
            : `${describeCommand(c)} is not allowed with a caller-supplied Transaction — the executor never finishes or replaces the caller's transaction`,
        );
        continue;
      }
      await runOne(stmt, idx, mode);
    }
  } else if (mode === 'perScript') {
    let txOptions = options.transactionOptions;
    let tx = await attachment.startTransaction(txOptions);
    /** Server statements executed on the current tx since it (re)opened. */
    let dirty = false;
    let autoDdl = false;
    const reopen = async (): Promise<void> => {
      tx = await attachment.startTransaction(txOptions);
      dirty = false;
    };
    try {
      for (let idx = 0; idx < parsed.length; idx++) {
        const stmt = parsed[idx]!;
        const c = stmt.client;
        if (c) {
          if (rejectCommon(stmt, idx, c)) continue;
          try {
            switch (c.op) {
              case 'commit': // script-controlled checkpoint
                if (c.retain) await tx.commitRetaining();
                else {
                  await tx.commit();
                  await reopen();
                }
                dirty = false;
                break;
              case 'rollback':
                if (c.retain) await tx.rollbackRetaining();
                else {
                  await tx.rollback();
                  await reopen();
                }
                dirty = false;
                break;
              case 'setTransaction':
                // isql's rule: the running transaction must be finished
                // explicitly first — restarting a dirty one would silently
                // commit (or discard) work the script didn't ask to.
                if (dirty) {
                  throw new Error(
                    'executeScript: SET TRANSACTION while the current transaction has executed statements — COMMIT or ROLLBACK first',
                  );
                }
                txOptions = c.options; // template for this and later reopens
                await tx.commit(); // clean: nothing to lose
                await reopen();
                break;
              case 'reconnect':
                // Keep completed work — the choice isql makes for EXIT, and
                // what installer scripts placing RECONNECT after DDL expect.
                if (!tx.isFinished) await tx.commit();
                await attachment.reconnect();
                await reopen();
                break;
              case 'setAutoDdl':
                autoDdl = c.on;
                break;
            }
            emitOk(stmt, idx);
          } catch (err) {
            emitError(stmt, idx, err as Error);
          }
          continue;
        }
        const ok = await runOne(stmt, idx, tx);
        dirty = true;
        if (ok && autoDdl && stmt.kind === 'ddl') {
          // AutoDDL checkpoint. A refused commit (e.g. "object in use" — DDL
          // locks surface at commit) propagates: it is a script-level failure.
          await tx.commit();
          await reopen();
        }
      }
      if (!tx.isFinished) await tx.commit();
    } catch (err) {
      if (!tx.isFinished) await tx.rollback().catch(() => undefined);
      throw err;
    }
  } else if (mode === 'perStatement') {
    let txOptions = options.transactionOptions;
    for (let idx = 0; idx < parsed.length; idx++) {
      const stmt = parsed[idx]!;
      const c = stmt.client;
      if (c) {
        if (rejectCommon(stmt, idx, c)) continue;
        try {
          if (c.op === 'reconnect') await attachment.reconnect();
          else if (c.op === 'setTransaction') txOptions = c.options; // for subsequent statements
          // commit/rollback[/retain], SET AUTODDL: no-op success — every
          // statement already autocommits (isql-targeted scripts sprinkle
          // COMMIT; failing them here would be hostile).
          emitOk(stmt, idx);
        } catch (err) {
          emitError(stmt, idx, err as Error);
        }
        continue;
      }
      const tx = await attachment.startTransaction(txOptions);
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
      const stmt = parsed[idx]!;
      const c = stmt.client;
      if (c) {
        if (rejectCommon(stmt, idx, c)) continue;
        if (c.op === 'setTransaction') {
          rejectClient(
            stmt,
            idx,
            "SET TRANSACTION is not configurable with transaction: 'none' — set the connection's defaultTransaction instead",
          );
          continue;
        }
        try {
          if (c.op === 'reconnect') await attachment.reconnect();
          // commit/rollback[/retain], SET AUTODDL: no-op success (autocommit).
          emitOk(stmt, idx);
        } catch (err) {
          emitError(stmt, idx, err as Error);
        }
        continue;
      }
      await runOne(stmt, idx, null);
    }
  }

  return { statements: results, succeeded, failed };
}
