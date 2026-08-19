/**
 * Low-level SQL region scanner shared by `parseScript` and the public
 * `commentRanges`/`stripComments` helpers. Keeping the delimiter rules in ONE
 * place is the point: a preprocessor that asks "is index N inside a comment?"
 * is consistent with the statement splitter by construction — q-literals,
 * `--` inside quoted identifiers, `/*` inside strings and all.
 *
 * Pure detection only — no error throwing, no position bookkeeping; callers
 * decide what an unterminated region means for them.
 */

export type RegionType = 'line-comment' | 'block-comment' | 'string' | 'quoted-identifier' | 'q-literal';

export interface Region {
  type: RegionType;
  /** Inclusive start index (the first delimiter character). */
  start: number;
  /** Exclusive end index (past the closing delimiter; text end if unterminated). */
  end: number;
  /** False when the text ended before the closing delimiter. */
  terminated: boolean;
}

const Q_CLOSERS: Record<string, string> = { '{': '}', '[': ']', '(': ')', '<': '>' };

/**
 * If a comment/string/quoted-identifier/q-literal region starts at `i`,
 * return it; otherwise null. Matches isql's lexing rules (doubled-quote
 * escapes, `q'<delim>…<delim>'` literals, `--` to end of line, non-nesting
 * block comments).
 */
export function regionAt(text: string, i: number): Region | null {
  const n = text.length;
  const c = text[i];
  if (c === '-' && text[i + 1] === '-') {
    let j = i + 2;
    while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
    return { type: 'line-comment', start: i, end: j, terminated: true }; // EOL/EOF both fine
  }
  if (c === '/' && text[i + 1] === '*') {
    let j = i + 2;
    while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
    if (j < n) return { type: 'block-comment', start: i, end: j + 2, terminated: true };
    return { type: 'block-comment', start: i, end: n, terminated: false };
  }
  if ((c === 'q' || c === 'Q') && text[i + 1] === "'") {
    const opener = text[i + 2];
    if (opener === undefined) return { type: 'q-literal', start: i, end: n, terminated: false };
    const closer = Q_CLOSERS[opener] ?? opener;
    let j = i + 3;
    while (j < n && !(text[j] === closer && text[j + 1] === "'")) j++;
    if (j < n) return { type: 'q-literal', start: i, end: j + 2, terminated: true };
    return { type: 'q-literal', start: i, end: n, terminated: false };
  }
  if (c === "'" || c === '"') {
    const type: RegionType = c === "'" ? 'string' : 'quoted-identifier';
    let j = i + 1;
    while (j < n) {
      if (text[j] === c) {
        if (text[j + 1] === c) {
          j += 2; // doubled-quote escape
          continue;
        }
        return { type, start: i, end: j + 1, terminated: true };
      }
      j++;
    }
    return { type, start: i, end: n, terminated: false };
  }
  return null;
}

/** Human message for an unterminated region (line comments never are). */
export const UNTERMINATED_MESSAGE: Record<Exclude<RegionType, 'line-comment'>, string> = {
  'block-comment': 'Unterminated block comment',
  string: 'Unterminated string',
  'quoted-identifier': 'Unterminated quoted identifier',
  'q-literal': 'Unterminated q-literal',
};
