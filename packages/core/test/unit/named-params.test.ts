import { describe, expect, it } from 'vitest';
import {
  bindNamedParams,
  isNamedParams,
  normalizeParams,
  rewriteNamedParams,
  FirebirdParamError,
} from '../../src/api/named-params.js';

describe('rewriteNamedParams', () => {
  it('rewrites a single @name to ?', () => {
    const r = rewriteNamedParams('select * from t where id = @id');
    expect(r.sql).toBe('select * from t where id = ?');
    expect(r.names).toEqual(['id']);
    expect(r.hasNamed).toBe(true);
  });

  it('rewrites multiple names in positional order', () => {
    const r = rewriteNamedParams('select * from emp where dept = @dept and sal > @min');
    expect(r.sql).toBe('select * from emp where dept = ? and sal > ?');
    expect(r.names).toEqual(['dept', 'min']);
  });

  it('emits one ? per occurrence of a repeated name', () => {
    const r = rewriteNamedParams('select * from t where a = @x or b = @x');
    expect(r.sql).toBe('select * from t where a = ? or b = ?');
    expect(r.names).toEqual(['x', 'x']);
  });

  it('reports no named params for a positional statement', () => {
    const r = rewriteNamedParams('select * from t where id = ?');
    expect(r.hasNamed).toBe(false);
    expect(r.names).toEqual([]);
    expect(r.sql).toBe('select * from t where id = ?');
  });

  it('accepts $ and digits inside a name but not as the first char', () => {
    const r = rewriteNamedParams('select @a_1, @b$c from t');
    expect(r.names).toEqual(['a_1', 'b$c']);
    expect(r.sql).toBe('select ?, ? from t');
  });

  it('leaves a bare @ (not followed by an identifier) untouched', () => {
    const r = rewriteNamedParams("select '@' , @1 from t");
    // '@' is inside a string; @1 starts with a digit, so neither is a param.
    expect(r.hasNamed).toBe(false);
    expect(r.sql).toBe("select '@' , @1 from t");
  });

  describe('skips markers inside quoted / commented regions', () => {
    it('single-quoted string literal', () => {
      const r = rewriteNamedParams("select '@notparam' from t where id = @id");
      expect(r.names).toEqual(['id']);
      expect(r.sql).toBe("select '@notparam' from t where id = ?");
    });

    it('doubled-quote escape inside a string', () => {
      const r = rewriteNamedParams("select 'it''s @here' , @real from t");
      expect(r.names).toEqual(['real']);
      expect(r.sql).toBe("select 'it''s @here' , ? from t");
    });

    it('double-quoted identifier', () => {
      const r = rewriteNamedParams('select "@col" from t where x = @x');
      expect(r.names).toEqual(['x']);
      expect(r.sql).toBe('select "@col" from t where x = ?');
    });

    it('line comment', () => {
      const r = rewriteNamedParams('select 1 -- @nope\nfrom t where id = @id');
      expect(r.names).toEqual(['id']);
    });

    it('block comment', () => {
      const r = rewriteNamedParams('select /* @nope */ 1 from t where id = @id');
      expect(r.names).toEqual(['id']);
    });

    it("q'{…}' alternative literal", () => {
      const r = rewriteNamedParams("select q'{@nope}' from t where id = @id");
      expect(r.names).toEqual(['id']);
      expect(r.sql).toBe("select q'{@nope}' from t where id = ?");
    });
  });

  it('does not touch a PSQL :variable, only the @param next to it', () => {
    const sql = 'execute block as declare v int; begin select sal into :v from emp where id = @id; end';
    const r = rewriteNamedParams(sql);
    expect(r.names).toEqual(['id']);
    expect(r.sql).toContain(':v'); // PSQL local var preserved verbatim
    expect(r.sql).toContain('= ?');
  });
});

describe('bindNamedParams', () => {
  it('reorders values to match the ? order', () => {
    expect(bindNamedParams(['dept', 'min'], { min: 5000, dept: 10 })).toEqual([10, 5000]);
  });

  it('repeats a value for a repeated name', () => {
    expect(bindNamedParams(['x', 'x'], { x: 7 })).toEqual([7, 7]);
  });

  it('honors an explicit null / undefined value', () => {
    expect(bindNamedParams(['a', 'b'], { a: null, b: undefined })).toEqual([null, undefined]);
  });

  it('ignores extra keys', () => {
    expect(bindNamedParams(['a'], { a: 1, b: 2, c: 3 })).toEqual([1]);
  });

  it('throws listing every missing name (deduped, @-prefixed)', () => {
    expect(() => bindNamedParams(['a', 'b', 'b'], { a: 1 })).toThrow(FirebirdParamError);
    expect(() => bindNamedParams(['a', 'b', 'b'], { a: 1 })).toThrow('@b');
  });
});

describe('isNamedParams', () => {
  it('treats a plain object as named', () => {
    expect(isNamedParams({ id: 1 })).toBe(true);
  });
  it('treats an array as positional', () => {
    expect(isNamedParams([1, 2])).toBe(false);
    expect(isNamedParams([])).toBe(false);
  });
  it('treats undefined as not-named', () => {
    expect(isNamedParams(undefined)).toBe(false);
  });
});

describe('normalizeParams', () => {
  it('passes a positional array straight through', () => {
    const r = normalizeParams('select * from t where id = ?', [42]);
    expect(r).toEqual({ sql: 'select * from t where id = ?', params: [42] });
  });

  it('defaults a missing params argument to an empty array', () => {
    expect(normalizeParams('select 1 from rdb$database', undefined)).toEqual({
      sql: 'select 1 from rdb$database',
      params: [],
    });
  });

  it('rewrites and binds a named object', () => {
    const r = normalizeParams('select * from t where a = @a and b = @b', { a: 1, b: 2 });
    expect(r.sql).toBe('select * from t where a = ? and b = ?');
    expect(r.params).toEqual([1, 2]);
  });

  it('throws when a named object is given but the SQL has no @markers', () => {
    expect(() => normalizeParams('select * from t where id = ?', { id: 1 })).toThrow(FirebirdParamError);
  });
});
