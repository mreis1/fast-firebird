import { FirebirdError } from './errors.js';
import type { SqlVarDesc } from '../protocol/info.js';

/**
 * `SELECT *` projection rewrite (`expandStar`, plans/projection.md).
 *
 * Replaces top-level `*` / `alias.*` / `table.*` select items with an explicit
 * column list (minus `exclude`, filtered by `only`) BEFORE the statement is
 * (re)prepared — so excluded columns are genuinely never fetched over the
 * wire, scalars included. Plain decode-time `exclude` only saves blob reads.
 *
 * Star→column mapping uses the server's own describe of the original SQL:
 * each output column carries `field` + `relationAlias` (the FROM-clause
 * alias), so `a.*` in a self-join maps exactly to its run of columns — no
 * schema cache, no FROM-clause parsing.
 *
 * Emitted column names are always double-quoted (dialect-3 exact match), so
 * lowercase/special/reserved-word identifiers survive the round trip.
 */

interface Tok {
  text: string;
  lower: string;
  start: number;
  end: number;
  depth: number;
}

/** Lex just enough SQL: skips strings/comments/q-literals, tracks () depth. */
function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  const n = sql.length;
  let i = 0;
  let depth = 0;
  const isIdStart = (c: string) => /[A-Za-z_$\u0080-\uffff]/.test(c);
  const isIdPart = (c: string) => /[A-Za-z0-9_$\u0080-\uffff]/.test(c);
  while (i < n) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === "'") {
      // String literal ('' escapes) — contributes no token.
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      i = Math.min(j + 1, n);
      continue;
    }
    if ((c === 'q' || c === 'Q') && sql[i + 1] === "'" && i + 2 < n) {
      // q-literal q'<d>…<D>' (FB4+): delimiter pairs ()[]{}<> or same char.
      const d = sql[i + 2]!;
      const close = d === '(' ? ')' : d === '[' ? ']' : d === '{' ? '}' : d === '<' ? '>' : d;
      const e = sql.indexOf(close + "'", i + 3);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === '"') {
      // Quoted identifier ("" escapes) — kept verbatim as one token.
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') j += 2;
          else break;
        } else j++;
      }
      const end = Math.min(j + 1, n);
      toks.push({ text: sql.slice(i, end), lower: sql.slice(i, end), start: i, end, depth });
      i = end;
      continue;
    }
    if (c === '(') {
      toks.push({ text: '(', lower: '(', start: i, end: i + 1, depth });
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      toks.push({ text: ')', lower: ')', start: i, end: i + 1, depth });
      i++;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(sql[j]!)) j++;
      const t = sql.slice(i, j);
      toks.push({ text: t, lower: t.toLowerCase(), start: i, end: j, depth });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(sql[j]!)) j++;
      toks.push({ text: sql.slice(i, j), lower: sql.slice(i, j), start: i, end: j, depth });
      i = j;
      continue;
    }
    toks.push({ text: c, lower: c, start: i, end: i + 1, depth });
    i++;
  }
  return toks;
}

interface StarItem {
  /** Qualifier exactly as written (`a`, `"Weird"`) or null for bare `*`. */
  qualifierText: string | null;
  /** Qualifier normalized for matching against describe relationAlias. */
  qualifierKey: string | null;
  /** Char span in the original SQL to replace (qualifier through star). */
  start: number;
  end: number;
  /** Outputs consumed by this star (filled during mapping). */
  outputs: SqlVarDesc[];
}

function unquote(ident: string): string {
  return ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident.toUpperCase();
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

const ERR = (msg: string) => new FirebirdError(`expandStar: ${msg}`);

/**
 * Rewrite top-level stars in `sql` using the original statement's described
 * `outputs`. Returns the rewritten SQL, or null when there is nothing to do
 * (not a select, or no top-level star items).
 */
export function expandStarSql(
  sql: string,
  outputs: SqlVarDesc[],
  query: { only?: string[]; exclude?: string[] },
): string | null {
  const toks = tokenize(sql);
  const topSelects = toks.filter((t) => t.depth === 0 && t.lower === 'select');
  if (topSelects.length === 0) return null;

  const sel = toks.indexOf(topSelects[0]!);
  let fromIdx = -1;
  for (let k = sel + 1; k < toks.length; k++) {
    if (toks[k]!.depth === 0 && toks[k]!.lower === 'from') {
      fromIdx = k;
      break;
    }
  }
  if (fromIdx === -1) return null; // e.g. `select 1, 2` — nothing to expand anyway
  const list = toks.slice(sel + 1, fromIdx);

  // Consume FIRST/SKIP <n|?|(expr)> and DISTINCT/ALL prefixes.
  let p = 0;
  while (p < list.length && (list[p]!.lower === 'first' || list[p]!.lower === 'skip')) {
    p++;
    if (p < list.length && list[p]!.lower === '(') {
      p++;
      while (p < list.length && !(list[p]!.lower === ')' && list[p]!.depth === 0)) p++;
      p++; // past the closing paren
    } else {
      p++; // number or ?
    }
  }
  if (p < list.length && (list[p]!.lower === 'distinct' || list[p]!.lower === 'all')) p++;

  // Split select items on depth-0 commas.
  const items: Tok[][] = [];
  let cur: Tok[] = [];
  for (let k = p; k < list.length; k++) {
    const t = list[k]!;
    if (t.lower === ',' && t.depth === 0) {
      items.push(cur);
      cur = [];
    } else {
      cur.push(t);
    }
  }
  items.push(cur);

  // Classify: `*` | `<ident>.*` | expression.
  const parsed: (StarItem | null)[] = items.map((it) => {
    if (it.length === 1 && it[0]!.text === '*') {
      return { qualifierText: null, qualifierKey: null, start: it[0]!.start, end: it[0]!.end, outputs: [] };
    }
    if (it.length === 3 && it[1]!.text === '.' && it[2]!.text === '*' && it[0]!.text !== ')') {
      return { qualifierText: it[0]!.text, qualifierKey: unquote(it[0]!.text), start: it[0]!.start, end: it[2]!.end, outputs: [] };
    }
    return null; // plain expression — consumes exactly one output
  });

  const stars = parsed.filter((s): s is StarItem => s !== null);
  if (stars.length === 0) return null;
  if (topSelects.length > 1) {
    throw ERR('top-level UNION queries are not supported — list the columns explicitly');
  }
  if (stars.length > 1 && stars.some((s) => s.qualifierKey === null)) {
    // A bare `*` already covers every table; mixing it with `alias.*` makes
    // the output runs ambiguous.
    throw ERR('bare * cannot be combined with qualified star items');
  }

  // Map each select item to its run of described outputs, in order.
  let cursor = 0;
  for (let idx = 0; idx < parsed.length; idx++) {
    const item = parsed[idx]!;
    if (item === null) {
      cursor++; // expression → one output
      continue;
    }
    if (item.qualifierKey === null) {
      // Bare * (the only star): everything the explicit items don't cover.
      const run = outputs.length - (parsed.length - 1);
      if (run < 1) throw ERR('could not map * to the described columns');
      item.outputs = outputs.slice(cursor, cursor + run);
      cursor += run;
      continue;
    }
    // Qualified star: consecutive outputs whose FROM alias matches.
    const matches = (d: SqlVarDesc | undefined) => d !== undefined && (d.relationAlias ?? d.relation ?? '') === item.qualifierKey;
    if (!matches(outputs[cursor])) {
      throw ERR(`'${item.qualifierText}.*' did not match the described columns (alias '${item.qualifierKey}')`);
    }
    const runStart = cursor;
    while (matches(outputs[cursor])) cursor++;
    // Leave enough outputs for the remaining items (adjacent same-alias runs
    // cannot happen: each FROM alias is unique within a query).
    const remaining = parsed.length - idx - 1;
    if (outputs.length - cursor < remaining) cursor = outputs.length - remaining;
    item.outputs = outputs.slice(runStart, cursor);
    if (item.outputs.length === 0) throw ERR(`'${item.qualifierText}.*' matched no columns`);
  }
  if (cursor !== outputs.length) {
    throw ERR(`described ${outputs.length} columns but the select list mapped ${cursor} — leaving the statement untouched would be unsafe`);
  }

  // Column filter: `only` first, then `exclude`; entries may be bare (COL) or
  // qualified (ALIAS.COL), case-insensitive — same contract as decode-time.
  const norm = (s: string) => s.toUpperCase();
  const only = query.only?.map(norm);
  const exclude = new Set((query.exclude ?? []).map(norm));
  const kept = (d: SqlVarDesc, qualKey: string | null): boolean => {
    const field = norm(d.field ?? '');
    const qualified = qualKey ? `${norm(qualKey)}.${field}` : field;
    if (only && !only.includes(field) && !only.includes(qualified)) return false;
    return !exclude.has(field) && !exclude.has(qualified);
  };

  // Build each star's replacement text.
  const replacements = stars.map((star) => {
    const qualKey = star.qualifierKey ?? null;
    const cols = star.outputs.filter((d) => kept(d, qualKey ?? d.relationAlias ?? null));
    if (cols.length === 0) {
      throw ERR(`exclude/only removed every column of '${star.qualifierText ?? '*'}' — nothing left to select`);
    }
    const text = cols
      .map((d) => {
        const field = quoteIdent(d.field!);
        if (star.qualifierText) return `${star.qualifierText}.${field}`;
        // Bare *: qualify with the FROM alias when known (join-safe).
        return d.relationAlias ? `${quoteIdent(d.relationAlias)}.${field}` : field;
      })
      .join(', ');
    return { start: star.start, end: star.end, text };
  });

  // Splice, left to right.
  replacements.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const r of replacements) {
    out += sql.slice(pos, r.start) + r.text;
    pos = r.end;
  }
  out += sql.slice(pos);
  return out;
}
