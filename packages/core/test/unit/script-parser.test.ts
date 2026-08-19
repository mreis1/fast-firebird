import { describe, expect, it } from 'vitest';
import { classifyStatement, parseScript, ScriptParseError, type StatementKind } from '../../src/script/parser.js';

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

describe('classifyStatement / ParsedStatement.kind', () => {
  const cases: Array<[string, StatementKind]> = [
    ['create table t (id int)', 'ddl'],
    ['CREATE OR ALTER PROCEDURE p AS BEGIN END', 'ddl'],
    ['alter table t add x int', 'ddl'],
    ['drop trigger trg', 'ddl'],
    ['recreate table t (id int)', 'ddl'],
    ["comment on table t is 'x'", 'ddl'],
    ['grant select on t to u', 'ddl'],
    ['revoke all on t from u', 'ddl'],
    ['declare external function f int returns int', 'ddl'],
    ['set generator g to 100', 'ddl'],
    ['insert into t values (1)', 'dml'],
    ['UPDATE OR INSERT INTO t (id) VALUES (1)', 'dml'],
    ['update t set x = 1', 'dml'],
    ['delete from t', 'dml'],
    ['merge into t using s on 1=1 when matched then delete', 'dml'],
    ["execute procedure p('a')", 'dml'],
    ['select * from t', 'other'],
    ['execute block as begin end', 'other'],
    ['set transaction read committed', 'other'],
    ['set statistics index idx', 'other'],
    ['commit work', 'other'],
    ['rollback', 'other'],
  ];

  it.each(cases)('%s → %s', (sql, kind) => {
    expect(classifyStatement(sql)).toBe(kind);
  });

  it('sees through comments between the keywords', () => {
    expect(classifyStatement('set /* seq */ generator g to 1')).toBe('ddl');
    expect(classifyStatement('execute -- call it\n procedure p')).toBe('dml');
    expect(classifyStatement('/* header */ create table t (id int)')).toBe('ddl');
  });

  it('parseScript stamps kind on every statement', () => {
    const kinds = parseScript('create table t (id int); insert into t values (1); select * from t').map(
      (s) => s.kind,
    );
    expect(kinds).toEqual(['ddl', 'dml', 'other']);
  });
});
