/**
 * Firebird SQL script parser.
 *
 * Splits a script into executable statements the way isql does — by the
 * current terminator, honoring `SET TERM`, string/quoted-identifier/q-literals
 * and comments. It deliberately does NOT track BEGIN…END nesting: like isql,
 * correctness comes from honoring the terminator (which is exactly why
 * `SET TERM ^ ;` exists for PSQL bodies). Rules verified against
 * firebird/src/isql/FrontendLexer.cpp.
 */

export interface ParsedStatement {
  /** Statement text, trimmed, with the trailing terminator removed. */
  sql: string;
  /** 1-based line of the first non-space character of the statement. */
  line: number;
  /** 1-based column of the first non-space character. */
  column: number;
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

const SET_TERM_RE = /^set\s+term\b/i;

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
      const c = script[i]!;
      if (c === '-' && script[i + 1] === '-') {
        skipLineComment();
        continue;
      }
      if (c === '/' && script[i + 1] === '*') {
        skipBlockComment();
        continue;
      }
      if (c === "'" || c === '"') {
        skipQuoted(c);
        sawContent = true;
        continue;
      }
      if ((c === 'q' || c === 'Q') && script[i + 1] === "'") {
        skipQLiteral();
        sawContent = true;
        continue;
      }
      if (matchesTerminator(i)) {
        advance(terminator.length);
        terminated = true;
        break;
      }
      if (!/\s/.test(c)) sawContent = true;
      advance();
    }

    if (sawContent) {
      const rawEnd = terminated ? i - terminator.length : i;
      const sql = script.slice(startIndex, rawEnd).trim();
      if (sql.length > 0) statements.push({ sql, line: startLine, column: startCol });
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
      } else if (c === '-' && script[i + 1] === '-') {
        skipLineComment();
      } else if (c === '/' && script[i + 1] === '*') {
        skipBlockComment();
      } else {
        return;
      }
    }
  }

  function skipLineComment(): void {
    advance(2); // consume --
    while (i < n && script[i] !== '\n' && script[i] !== '\r') advance();
  }

  function skipBlockComment(): void {
    const sl = line;
    const sc = col;
    advance(2); // consume /*
    while (i < n && !(script[i] === '*' && script[i + 1] === '/')) advance();
    if (i >= n) throw new ScriptParseError('Unterminated block comment', sl, sc);
    advance(2); // consume */
  }

  function skipQuoted(quote: string): void {
    const sl = line;
    const sc = col;
    advance(); // opening quote
    while (i < n) {
      if (script[i] === quote) {
        if (script[i + 1] === quote) {
          advance(2); // escaped quote ''
          continue;
        }
        advance(); // closing quote
        return;
      }
      advance();
    }
    throw new ScriptParseError(`Unterminated ${quote === "'" ? 'string' : 'quoted identifier'}`, sl, sc);
  }

  function skipQLiteral(): void {
    const sl = line;
    const sc = col;
    advance(2); // consume q'
    const opener = script[i];
    if (opener === undefined) throw new ScriptParseError('Unterminated q-literal', sl, sc);
    const closer = { '{': '}', '[': ']', '(': ')', '<': '>' }[opener] ?? opener;
    advance(); // consume opener delimiter char
    while (i < n && !(script[i] === closer && script[i + 1] === "'")) advance();
    if (i >= n) throw new ScriptParseError('Unterminated q-literal', sl, sc);
    advance(2); // consume closer + '
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
