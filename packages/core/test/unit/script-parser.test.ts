import { describe, expect, it } from 'vitest';
import { parseScript, ScriptParseError } from '../../src/script/parser.js';

const sqls = (script: string) => parseScript(script).map((s) => s.sql);

describe('parseScript', () => {
  it('splits simple semicolon-separated statements', () => {
    expect(sqls('select 1; select 2 ; select 3')).toEqual(['select 1', 'select 2', 'select 3']);
  });

  it('ignores semicolons inside single-quoted strings', () => {
    expect(sqls(`insert into t values ('a;b;c'); select 1`)).toEqual([`insert into t values ('a;b;c')`, 'select 1']);
  });

  it('handles doubled-quote escapes in strings and identifiers', () => {
    expect(sqls(`insert into t values ('d''Água; ok'); select 2`)).toEqual([
      `insert into t values ('d''Água; ok')`,
      'select 2',
    ]);
    expect(sqls('select "co;l" from "ta""ble"; select 1')).toEqual(['select "co;l" from "ta""ble"', 'select 1']);
  });

  it('ignores terminators inside line and block comments', () => {
    const script = `
      -- this ; is a comment
      select 1;
      /* block ; comment
         spanning ; lines */
      select 2;
    `;
    expect(sqls(script)).toEqual(['select 1', 'select 2']);
  });

  it('preserves the € character and unicode in statements', () => {
    expect(sqls("update h set memo = '100€'; select 1")).toEqual([`update h set memo = '100€'`, 'select 1']);
  });

  it('honors SET TERM for PSQL bodies with inner semicolons', () => {
    const script = `
      set term ^ ;
      create or alter procedure test_proc
      as
      begin
        insert into log values (1);
        insert into log values (2);
        suspend;
      end^
      set term ; ^
      execute procedure test_proc;
    `;
    const out = sqls(script);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/create or alter procedure test_proc/);
    expect(out[0]).toContain('insert into log values (1);'); // inner ; preserved
    expect(out[0]).toContain('suspend;');
    expect(out[0]).not.toContain('^');
    expect(out[1]).toBe('execute procedure test_proc');
  });

  it('handles EXECUTE BLOCK with nested begin/end and strings', () => {
    const script = `
      set term !! ;
      execute block as
      begin
        if (1=1) then
          begin
            insert into t values ('x;y');
          end
      end!!
      set term ;!!
      select count(*) from t;
    `;
    const out = sqls(script);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("insert into t values ('x;y')");
    expect(out[1]).toBe('select count(*) from t');
  });

  it('handles q-literals with various delimiters', () => {
    expect(sqls(`select q'{a;b}' from rdb$database; select 2`)).toEqual([`select q'{a;b}' from rdb$database`, 'select 2']);
    expect(sqls(`select q'<x;y>' from d; select 1`)).toEqual([`select q'<x;y>' from d`, 'select 1']);
    expect(sqls(`select q'!z;z!' from d; select 1`)).toEqual([`select q'!z;z!' from d`, 'select 1']);
  });

  it('skips empty statements and trailing whitespace/comments', () => {
    expect(sqls('select 1;;; \n  -- trailing\n ;')).toEqual(['select 1']);
  });

  it('emits a trailing statement with no terminator', () => {
    expect(sqls('select 1; select 2')).toEqual(['select 1', 'select 2']);
  });

  it('reports accurate line/column for each statement', () => {
    const parsed = parseScript('select 1;\n\n  select 2;\nselect 3');
    expect(parsed.map((p) => [p.line, p.column])).toEqual([
      [1, 1],
      [3, 3],
      [4, 1],
    ]);
  });

  it('throws on an unterminated string with position', () => {
    const err = (() => {
      try {
        parseScript("select 'oops");
        return null;
      } catch (e) {
        return e as ScriptParseError;
      }
    })();
    expect(err).toBeInstanceOf(ScriptParseError);
    expect(err!.line).toBe(1);
  });

  it('throws on an unterminated block comment', () => {
    expect(() => parseScript('select 1; /* nope')).toThrow(/Unterminated block comment/);
  });

  it('supports a multi-character terminator', () => {
    expect(sqls('set term GO ;\nselect 1 GO select 2 GO')).toEqual(['select 1', 'select 2']);
  });

  it('does not treat "set terminal" as SET TERM', () => {
    // Word boundary: only "set term" (whole word) switches the terminator.
    const out = sqls("insert into cfg values ('set terminal on'); select 1");
    expect(out).toEqual([`insert into cfg values ('set terminal on')`, 'select 1']);
  });
});
