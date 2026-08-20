/**
 * Firebird SQL script parser.
 *
 * Splits a script into executable statements the way isql does — by the
 * current terminator, honoring `SET TERM`, string/quoted-identifier/q-literals
 * and comments. It deliberately does NOT track BEGIN…END nesting: like isql,
 * correctness comes from honoring the terminator (which is exactly why
 * `SET TERM ^ ;` exists for PSQL bodies). Rules verified against
 * firebird/src/isql/FrontendLexer.cpp.
 *
 * All delimiter recognition lives in `scanner.ts` (`regionAt`), shared with
 * the public `commentRanges`/`stripComments` helpers.
 */
import { regionAt, UNTERMINATED_MESSAGE } from './scanner.js';
import type { TransactionOptions } from '../protocol/transaction.js';

/**
 * Statement classification from the leading keyword(s). A HEURISTIC for
 * 'ddl'/'dml'/'other': it cannot see through `EXECUTE BLOCK` bodies (which
 * can hide DDL via `EXECUTE STATEMENT`) — those classify as 'other'.
 * Intended for commit-after-DDL policies (Delphi `AutoDDL` style), not as a
 * security boundary. 'client' is EXACT, not heuristic: the statement is a
 * client-side command (see `ClientCommand`) that `executeScript` processes
 * driver-side and never sends to the server.
 */
export type StatementKind = 'ddl' | 'dml' | 'other' | 'client';

/**
 * A script statement that is a client-side command — executed by the driver
 * (isql-style), never sent to the server as DSQL. `op: 'unsupported'` marks a
 * statement whose HEAD is transaction control (so it must not reach the
 * server) but whose details the driver cannot process — `executeScript`
 * rejects it with `reason`.
 */
export type ClientCommand =
  | { op: 'reconnect' }
  | { op: 'commit'; retain: boolean }
  | { op: 'rollback'; retain: boolean }
  | { op: 'setTransaction'; options: TransactionOptions; raw: string }
  | { op: 'setAutoDdl'; on: boolean }
  | { op: 'unsupported'; reason: string };

export interface ParsedStatement {
  /** Statement text, trimmed, with the trailing terminator removed. */
  sql: string;
  /** 1-based line of the first non-space character of the statement. */
  line: number;
  /** 1-based column of the first non-space character. */
  column: number;
  /** Leading-keyword classification (see StatementKind — a heuristic). */
  kind: StatementKind;
  /** The recognized client command — set iff `kind === 'client'`. */
  client?: ClientCommand;
}

export interface ParseScriptOptions {
  /** Initial statement terminator. Default ';'. */
  terminator?: string;
}

export class ScriptParseError extends Error {
  override name = 'ScriptParseError';
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

function lineColAt(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let k = 0; k < index; k++) {
    if (text[k] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/**
 * All comment ranges (line and block) in `sql` as `[start, end)` index
 * pairs — computed by the SAME scanner `parseScript` uses, so a
 * preprocessor's "is index N inside a comment?" verdict cannot diverge from
 * the statement splitter on q-literals, `--` inside quoted identifiers, or a
 * block-comment opener inside a string. Throws `ScriptParseError` on the
 * same malformed input `parseScript` rejects (unterminated block comment /
 * string / q-literal).
 */
export function commentRanges(sql: string): Array<[start: number, end: number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  while (i < sql.length) {
    const r = regionAt(sql, i);
    if (!r) {
      i++;
      continue;
    }
    if (!r.terminated) {
      const { line, column } = lineColAt(sql, r.start);
      throw new ScriptParseError(UNTERMINATED_MESSAGE[r.type as keyof typeof UNTERMINATED_MESSAGE], line, column);
    }
    if (r.type === 'line-comment' || r.type === 'block-comment') out.push([r.start, r.end]);
    i = r.end;
  }
  return out;
}

/**
 * Blank out every comment, LENGTH-PRESERVING: comment characters become
 * spaces but newlines survive, so indexes, line and column positions in the
 * result match the input exactly. Same scanner (and same errors) as
 * `parseScript`/`commentRanges`.
 */
export function stripComments(sql: string): string {
  const ranges = commentRanges(sql);
  if (ranges.length === 0) return sql;
  let out = '';
  let prev = 0;
  for (const [s, e] of ranges) {
    out += sql.slice(prev, s) + sql.slice(s, e).replace(/[^\n\r]/g, ' ');
    prev = e;
  }
  return out + sql.slice(prev);
}

const SET_TERM_RE = /^set\s+term\b/i;

/**
 * Recognize a client-side script command (isql-style). Returns `null` for
 * anything that should go to the server as DSQL — including `SAVEPOINT x`,
 * `RELEASE SAVEPOINT x` and `ROLLBACK [WORK] TO [SAVEPOINT] x`, which operate
 * safely INSIDE the current transaction. Comment-tolerant, case-insensitive.
 * Recognition keys on the statement head: once the head is transaction
 * control (`COMMIT`/`ROLLBACK`/`SET TRANSACTION`), the statement is claimed
 * as a client command even when its details cannot be processed — it comes
 * back as `op: 'unsupported'` instead of `null`, so `executeScript` rejects
 * it by name rather than letting it slip to the server.
 */
export function classifyClientCommand(sql: string): ClientCommand | null {
  let stripped: string;
  try {
    stripped = stripComments(sql);
  } catch {
    return null; // malformed input cannot be a valid client command
  }
  // Keywords, integers, or any other non-space char (which then fails the
  // keyword matches below — quotes/punctuation make a statement non-client).
  const tokens = stripped.replace(/;+\s*$/, '').toLowerCase().match(/[a-z$_][\w$]*|\d+|\S/g) ?? [];
  const [w1, w2] = tokens;
  switch (w1) {
    case 'reconnect':
      return tokens.length === 1 ? { op: 'reconnect' } : null;
    case 'commit':
    case 'rollback': {
      // Grammar (parse.y): COMMIT|ROLLBACK [WORK] [RETAIN [SNAPSHOT]];
      // ROLLBACK [WORK] TO [SAVEPOINT] name is server-side DSQL.
      let i = 1;
      if (tokens[i] === 'work') i++;
      if (w1 === 'rollback' && tokens[i] === 'to') return null;
      let retain = false;
      if (tokens[i] === 'retain') {
        retain = true;
        i++;
        if (tokens[i] === 'snapshot') i++;
      }
      if (i < tokens.length) {
        return {
          op: 'unsupported',
          reason: `${w1.toUpperCase()}: unexpected "${tokens[i]!.toUpperCase()}" — expected [WORK] [RETAIN [SNAPSHOT]]`,
        };
      }
      return { op: w1, retain };
    }
    case 'set':
      if (w2 === 'transaction') return parseSetTransaction(tokens.slice(2), sql);
      if (w2 === 'autoddl' || w2 === 'auto') {
        const arg = tokens[2];
        if (tokens.length === 3 && (arg === 'on' || arg === 'off')) return { op: 'setAutoDdl', on: arg === 'on' };
        return {
          op: 'unsupported',
          reason: 'SET AUTODDL requires an explicit ON or OFF (the bare isql toggle depends on invisible state)',
        };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Map `SET TRANSACTION` clauses (already tokenized, head consumed) onto
 * `TransactionOptions`. Clause set verified against parse.y `tran_option` /
 * `iso_mode` / `version_mode`. Anything the driver cannot express —
 * RESERVING, NO AUTO UNDO, IGNORE LIMBO, READ CONSISTENCY, SNAPSHOT AT
 * NUMBER, … — yields `op: 'unsupported'` (named), never a silent drop.
 */
function parseSetTransaction(tokens: string[], raw: string): ClientCommand {
  const unsupported = (clause: string): ClientCommand => ({
    op: 'unsupported',
    reason: `SET TRANSACTION: unsupported clause ${clause} — the driver cannot map it to TransactionOptions`,
  });
  const options: TransactionOptions = {};
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i++]!;
    switch (t) {
      case 'read': {
        const t2 = tokens[i++];
        if (t2 === 'write') options.readOnly = false;
        else if (t2 === 'only') options.readOnly = true;
        else if (t2 === 'committed' || t2 === 'uncommitted') {
          // Bare READ COMMITTED = NO record version (parse.y version_mode
          // default); VERSION / NO VERSION / READ CONSISTENCY may follow and
          // are handled by later loop iterations.
          options.isolation = 'readCommittedNoRecVersion';
        } else if (t2 === 'consistency') return unsupported('READ CONSISTENCY');
        else return unsupported(`READ ${(t2 ?? '<end>').toUpperCase()}`);
        break;
      }
      case 'wait':
        options.wait = true;
        break;
      case 'no': {
        const t2 = tokens[i++];
        if (t2 === 'wait') options.wait = false;
        else if (t2 === 'version' || t2 === 'record_version') options.isolation = 'readCommittedNoRecVersion';
        else if (t2 === 'auto') return unsupported('NO AUTO UNDO');
        else return unsupported(`NO ${(t2 ?? '<end>').toUpperCase()}`);
        break;
      }
      case 'version': // FB4+ spelling
      case 'record_version': // classic spelling
        options.isolation = 'readCommitted';
        break;
      case 'isolation':
        if (tokens[i] === 'level') i++;
        break;
      case 'snapshot':
        if (tokens[i] === 'table') {
          i++;
          if (tokens[i] === 'stability') i++;
          options.isolation = 'serializable';
        } else if (tokens[i] === 'at') {
          return unsupported('SNAPSHOT AT NUMBER (shared snapshots)');
        } else {
          options.isolation = 'snapshot';
        }
        break;
      case 'lock':
        if (tokens[i] === 'timeout' && /^\d+$/.test(tokens[i + 1] ?? '')) {
          options.wait = Number(tokens[i + 1]);
          i += 2;
        } else {
          return unsupported('LOCK (expected LOCK TIMEOUT <seconds>)');
        }
        break;
      case 'auto':
        if (tokens[i] === 'commit') {
          options.autoCommit = true;
          i++;
        } else {
          return unsupported('AUTO RELEASE TEMP BLOBID');
        }
        break;
      case 'reserving':
        return unsupported('RESERVING (table reservation)');
      case 'ignore':
        return unsupported('IGNORE LIMBO');
      case 'restart':
        return unsupported('RESTART REQUESTS');
      default:
        return unsupported(`starting at "${t.toUpperCase()}"`);
    }
  }
  return { op: 'setTransaction', options, raw };
}

/** Classify a statement by its leading keyword(s). Exported for reuse. */
export function classifyStatement(sql: string): StatementKind {
  if (classifyClientCommand(sql) !== null) return 'client';
  return classifyServerStatement(sql);
}

/** The ddl/dml/other heuristic for statements that go to the server. */
function classifyServerStatement(sql: string): StatementKind {
  // Comments may sit between the keywords; strip them from the head before
  // tokenizing (also handles a block comment cut off by the slice).
  const head = sql.slice(0, 400).replace(/--[^\n]*|\/\*[\s\S]*?(\*\/|$)/g, ' ');
  const words = head.toLowerCase().match(/[a-z$_][\w$]*/g) ?? [];
  const [w1, w2] = words;
  switch (w1) {
    case 'create': // incl. CREATE OR ALTER
    case 'alter':
    case 'drop':
    case 'recreate':
    case 'comment': // COMMENT ON
    case 'grant':
    case 'revoke':
    case 'declare': // DECLARE FILTER / DECLARE EXTERNAL FUNCTION
      return 'ddl';
    case 'set':
      return w2 === 'generator' ? 'ddl' : 'other'; // SET STATISTICS/BIND… = other
    case 'insert':
    case 'update': // incl. UPDATE OR INSERT
    case 'delete':
    case 'merge':
      return 'dml';
    case 'execute':
      return w2 === 'procedure' ? 'dml' : 'other'; // EXECUTE BLOCK = other
    default:
      return 'other'; // SELECT, SAVEPOINT, CONNECT, ROLLBACK TO SAVEPOINT, …
  }
}

/** Parse a Firebird script into individual statements. */
export function parseScript(script: string, options: ParseScriptOptions = {}): ParsedStatement[] {
  let terminator = options.terminator ?? ';';
  const statements: ParsedStatement[] = [];
  const n = script.length;

  let i = 0;
  let line = 1;
  let col = 1;

  // Position bookkeeping that advances line/col as we consume characters.
  const advance = (count = 1): void => {
    for (let k = 0; k < count; k++) {
      if (script[i] === '\n') {
        line++;
        col = 1;
      } else {
        col++;
      }
      i++;
    }
  };

  const matchesTerminator = (at: number): boolean => {
    if (terminator.length === 0) return false;
    return script.startsWith(terminator, at);
  };

  while (i < n) {
    // Skip leading whitespace and comments to find the statement start.
    skipTrivia();
    if (i >= n) break;

    const startLine = line;
    const startCol = col;
    const startIndex = i;

    // SET TERM handling — consumes the command, switches terminator, no emit.
    if (SET_TERM_RE.test(script.slice(i, i + 12))) {
      const consumed = tryConsumeSetTerm(startLine, startCol);
      if (consumed) continue;
    }

    // Scan the statement body until an unquoted terminator or EOF.
    let sawContent = false;
    let terminated = false;
    while (i < n) {
      const r = regionAt(script, i);
      if (r) {
        if (!r.terminated) {
          throw new ScriptParseError(UNTERMINATED_MESSAGE[r.type as keyof typeof UNTERMINATED_MESSAGE], line, col);
        }
        if (r.type !== 'line-comment' && r.type !== 'block-comment') sawContent = true;
        advance(r.end - i);
        continue;
      }
      if (matchesTerminator(i)) {
        advance(terminator.length);
        terminated = true;
        break;
      }
      if (!/\s/.test(script[i]!)) sawContent = true;
      advance();
    }

    if (sawContent) {
      const rawEnd = terminated ? i - terminator.length : i;
      const sql = script.slice(startIndex, rawEnd).trim();
      if (sql.length > 0) {
        const client = classifyClientCommand(sql);
        statements.push(
          client
            ? { sql, line: startLine, column: startCol, kind: 'client', client }
            : { sql, line: startLine, column: startCol, kind: classifyServerStatement(sql) },
        );
      }
    }
  }

  return statements;

  // ── helpers (close over i/line/col via advance) ──────────────────────────

  function skipTrivia(): void {
    for (;;) {
      const c = script[i];
      if (c === undefined) return;
      if (/\s/.test(c)) {
        advance();
        continue;
      }
      const r = regionAt(script, i);
      if (r && (r.type === 'line-comment' || r.type === 'block-comment')) {
        if (!r.terminated) throw new ScriptParseError('Unterminated block comment', line, col);
        advance(r.end - i);
        continue;
      }
      return;
    }
  }

  function tryConsumeSetTerm(sl: number, sc: number): boolean {
    // Find the current terminator that ends this SET TERM command.
    let j = i;
    while (j < n && !script.startsWith(terminator, j)) {
      // SET TERM args never contain strings/comments in practice; a bare scan
      // to the current terminator matches isql.
      j++;
    }
    if (j >= n) throw new ScriptParseError('SET TERM without a terminator', sl, sc);
    const command = script.slice(i, j); // "set term <newterm> "
    const rest = command.replace(SET_TERM_RE, '').trim();
    if (rest.length === 0) throw new ScriptParseError('SET TERM requires a new terminator', sl, sc);
    // Advance over the command + the closing (old) terminator.
    advance(j - i + terminator.length);
    terminator = rest;
    return true;
  }
}
