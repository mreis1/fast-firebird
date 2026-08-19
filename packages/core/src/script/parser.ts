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

/**
 * Statement classification from the leading keyword(s). A HEURISTIC: it
 * cannot see through `EXECUTE BLOCK` bodies (which can hide DDL via
 * `EXECUTE STATEMENT`) — those classify as 'other'. Intended for
 * commit-after-DDL policies (Delphi `AutoDDL` style), not as a security
 * boundary.
 */
export type StatementKind = 'ddl' | 'dml' | 'other';

export interface ParsedStatement {
  /** Statement text, trimmed, with the trailing terminator removed. */
  sql: string;
  /** 1-based line of the first non-space character of the statement. */
  line: number;
  /** 1-based column of the first non-space character. */
  column: number;
  /** Leading-keyword classification (see StatementKind — a heuristic). */
  kind: StatementKind;
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

/** Classify a statement by its leading keyword(s). Exported for reuse. */
export function classifyStatement(sql: string): StatementKind {
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
      return w2 === 'generator' ? 'ddl' : 'other'; // SET TRANSACTION/STATISTICS… = other
    case 'insert':
    case 'update': // incl. UPDATE OR INSERT
    case 'delete':
    case 'merge':
      return 'dml';
    case 'execute':
      return w2 === 'procedure' ? 'dml' : 'other'; // EXECUTE BLOCK = other
    default:
      return 'other'; // SELECT, COMMIT, ROLLBACK, CONNECT, …
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
      if (sql.length > 0) statements.push({ sql, line: startLine, column: startCol, kind: classifyStatement(sql) });
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
