/**
 * Named parameters (`@name`) → positional (`?`) rewrite.
 *
 * Firebird's wire protocol only knows positional `?` parameters. We let
 * callers pass an object of values keyed by name and use `@name` markers in
 * the SQL; this module rewrites the SQL to `?` markers and reorders the values
 * to match.
 *
 * Why `@` and not `:`? In Firebird PSQL a leading colon (`:var`) is a
 * local-variable reference (`SELECT … INTO :v`, `WHERE x = :v` inside an
 * EXECUTE BLOCK / stored-procedure body). `@` has NO meaning anywhere in
 * Firebird's SQL or PSQL grammar, so `@name` is unambiguous even inside an
 * EXECUTE BLOCK sitting next to real `:vars`.
 *
 * The scan skips string literals, quoted identifiers, `q'{…}'` literals and
 * comments — a `@name` inside any of those is left verbatim (same lexing
 * discipline as the script parser).
 */

import { FirebirdError } from './errors.js';
import type { ParamValue } from '../protocol/msgcodec.js';

/** Values supplied by name for a `@name`-parameterized statement. */
export type NamedParams = Record<string, ParamValue>;

/** Either positional (array) or named (object) parameter values. */
export type QueryParams = ParamValue[] | NamedParams;

export interface RewrittenSql {
  /** SQL with every `@name` replaced by a positional `?`. */
  sql: string;
  /** Parameter names in `?` order (repeats preserved — one entry per `?`). */
  names: string[];
  /** True when at least one `@name` marker was found. */
  hasNamed: boolean;
}

/** Bad use of named parameters (unknown syntax mix, missing value). */
export class FirebirdParamError extends FirebirdError {
  override name = 'FirebirdParamError';
}

/** A params argument is "named" when it's a plain object, not an array. */
export function isNamedParams(params: QueryParams | undefined): params is NamedParams {
  return params !== undefined && !Array.isArray(params);
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Rewrite `@name` markers to `?`, collecting the names in positional order.
 * A repeated name yields one `?` (and one entry in `names`) per occurrence —
 * Firebird has no parameter reuse, so the value is bound once per slot.
 */
export function rewriteNamedParams(sql: string): RewrittenSql {
  const names: string[] = [];
  const n = sql.length;
  let out = '';
  let last = 0; // start of the not-yet-emitted verbatim run
  let i = 0;

  while (i < n) {
    const c = sql[i]!;

    // -- line comment
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }
    // /* block comment */
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2; // past the closing */ (or past EOF — the loop guard stops us)
      continue;
    }
    // 'string' or "quoted identifier" (doubled quote escapes)
    if (c === "'" || c === '"') {
      i = skipQuoted(sql, i, c);
      continue;
    }
    // q'{…}' alternative string literal
    if ((c === 'q' || c === 'Q') && sql[i + 1] === "'") {
      i = skipQLiteral(sql, i);
      continue;
    }
    // @name — a named parameter marker
    if (c === '@') {
      const nameStart = i + 1;
      if (nameStart < n && IDENT_START.test(sql[nameStart]!)) {
        let j = nameStart + 1;
        while (j < n && IDENT_PART.test(sql[j]!)) j++;
        out += sql.slice(last, i) + '?';
        names.push(sql.slice(nameStart, j));
        i = j;
        last = j;
        continue;
      }
    }
    i++;
  }

  out += sql.slice(last);
  return { sql: out, names, hasNamed: names.length > 0 };
}

/**
 * Reorder a named-params object into the positional array matching `names`.
 * Throws if any referenced name is absent; extra keys are ignored. A key
 * present with an `undefined`/`null` value is honored (bound as NULL).
 */
export function bindNamedParams(names: string[], params: NamedParams): ParamValue[] {
  const missing: string[] = [];
  const out: ParamValue[] = names.map((name) => {
    if (!(name in params)) {
      if (!missing.includes(name)) missing.push(name);
      return undefined;
    }
    return params[name];
  });
  if (missing.length > 0) {
    throw new FirebirdParamError(
      `named parameter${missing.length > 1 ? 's' : ''} missing from params object: ${missing
        .map((m) => '@' + m)
        .join(', ')}`,
    );
  }
  return out;
}

/**
 * Normalize a (sql, params) pair for execution: when `params` is a named
 * object, rewrite `@name` → `?` and reorder the values; when it's a
 * positional array, pass both through untouched. Called at the single
 * internal execution funnel so every public entry point inherits it.
 */
export function normalizeParams(sql: string, params: QueryParams | undefined): { sql: string; params: ParamValue[] } {
  if (!isNamedParams(params)) return { sql, params: params ?? [] };
  const { sql: rewritten, names, hasNamed } = rewriteNamedParams(sql);
  if (!hasNamed) {
    throw new FirebirdParamError(
      'a named-parameter object was passed but the SQL has no @name markers — use a positional array for `?` parameters, or add @name markers',
    );
  }
  return { sql: rewritten, params: bindNamedParams(names, params) };
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2; // '' escape
        continue;
      }
      return i + 1; // past the closing quote
    }
    i++;
  }
  return i; // unterminated — treat the rest as quoted (server will reject)
}

function skipQLiteral(sql: string, start: number): number {
  const n = sql.length;
  let i = start + 2; // past q'
  if (i >= n) return i;
  const opener = sql[i]!;
  const closer = ({ '{': '}', '[': ']', '(': ')', '<': '>' } as Record<string, string>)[opener] ?? opener;
  i++; // past the opener delimiter
  while (i < n && !(sql[i] === closer && sql[i + 1] === "'")) i++;
  return i + 2; // past closer + '
}
