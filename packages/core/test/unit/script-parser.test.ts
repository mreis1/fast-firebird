import { describe, expect, it } from 'vitest';
import {
  classifyClientCommand,
  classifyStatement,
  commentRanges,
  parseScript,
  ScriptParseError,
  stripComments,
  type ClientCommand,
  type StatementKind,
} from '../../src/script/parser.js';

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
    ['set statistics index idx', 'other'],
    // Client commands (processed driver-side by executeScript, never sent):
    ['set transaction read committed', 'client'],
    ['commit work', 'client'],
    ['rollback', 'client'],
    ['RECONNECT', 'client'],
    ['set autoddl on', 'client'],
    // …but transaction-RELATED statements inside the current tx stay server-side:
    ['savepoint sp1', 'other'],
    ['release savepoint sp1', 'other'],
    ['rollback to savepoint sp1', 'other'],
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

describe('classifyClientCommand', () => {
  const cc = classifyClientCommand;

  it('recognizes COMMIT/ROLLBACK with WORK/RETAIN[/SNAPSHOT] in grammar order', () => {
    expect(cc('commit')).toEqual({ op: 'commit', retain: false });
    expect(cc('COMMIT WORK')).toEqual({ op: 'commit', retain: false });
    expect(cc('commit retain')).toEqual({ op: 'commit', retain: true });
    expect(cc('commit work retain')).toEqual({ op: 'commit', retain: true });
    expect(cc('commit work retain snapshot')).toEqual({ op: 'commit', retain: true });
    expect(cc('rollback')).toEqual({ op: 'rollback', retain: false });
    expect(cc('ROLLBACK WORK RETAIN')).toEqual({ op: 'rollback', retain: true });
  });

  it('is comment-tolerant and ignores a trailing semicolon', () => {
    expect(cc('/* checkpoint */ commit -- keep it\n work')).toEqual({ op: 'commit', retain: false });
    expect(cc('commit;')).toEqual({ op: 'commit', retain: false });
    expect(cc('reconnect ;')).toEqual({ op: 'reconnect' });
  });

  it('leaves savepoint statements to the server (real in-transaction DSQL)', () => {
    expect(cc('rollback to savepoint sp1')).toBeNull();
    expect(cc('rollback work to sp1')).toBeNull();
    expect(cc('savepoint sp1')).toBeNull();
    expect(cc('release savepoint sp1')).toBeNull();
  });

  it('claims a garbled COMMIT/ROLLBACK head as unsupported instead of letting it slip to the wire', () => {
    const r = cc('commit everything') as ClientCommand & { op: 'unsupported' };
    expect(r.op).toBe('unsupported');
    expect(r.reason).toMatch(/COMMIT.*EVERYTHING/);
  });

  it('recognizes RECONNECT only as the whole statement', () => {
    expect(cc('reconnect')).toEqual({ op: 'reconnect' });
    expect(cc('RECONNECT')).toEqual({ op: 'reconnect' });
    expect(cc('reconnect now')).toBeNull(); // not the command → server (which rejects it)
  });

  it('recognizes SET AUTODDL / SET AUTO and demands an explicit ON|OFF', () => {
    expect(cc('set autoddl on')).toEqual({ op: 'setAutoDdl', on: true });
    expect(cc('SET AUTO OFF')).toEqual({ op: 'setAutoDdl', on: false });
    const bare = cc('set autoddl') as ClientCommand & { op: 'unsupported' };
    expect(bare.op).toBe('unsupported');
    expect(bare.reason).toMatch(/ON or OFF/);
  });

  it('maps SET TRANSACTION clauses onto TransactionOptions', () => {
    expect(cc('set transaction')).toMatchObject({ op: 'setTransaction', options: {} });
    expect(cc('set transaction read write wait')).toMatchObject({
      op: 'setTransaction',
      options: { readOnly: false, wait: true },
    });
    expect(cc('set transaction read only no wait')).toMatchObject({
      op: 'setTransaction',
      options: { readOnly: true, wait: false },
    });
    expect(cc('set transaction isolation level snapshot')).toMatchObject({
      op: 'setTransaction',
      options: { isolation: 'snapshot' },
    });
    expect(cc('set transaction snapshot table stability')).toMatchObject({
      op: 'setTransaction',
      options: { isolation: 'serializable' },
    });
    // Bare READ COMMITTED = NO record version (parse.y version_mode default).
    expect(cc('set transaction read committed')).toMatchObject({
      op: 'setTransaction',
      options: { isolation: 'readCommittedNoRecVersion' },
    });
    expect(cc('set transaction read committed record_version')).toMatchObject({
      op: 'setTransaction',
      options: { isolation: 'readCommitted' },
    });
    expect(cc('set transaction read committed version')).toMatchObject({
      op: 'setTransaction',
      options: { isolation: 'readCommitted' },
    });
    expect(cc('set transaction read committed no record_version')).toMatchObject({
      op: 'setTransaction',
      options: { isolation: 'readCommittedNoRecVersion' },
    });
    expect(cc('set transaction read committed record_version lock timeout 5')).toMatchObject({
      op: 'setTransaction',
      options: { isolation: 'readCommitted', wait: 5 },
    });
    expect(cc('set transaction auto commit')).toMatchObject({
      op: 'setTransaction',
      options: { autoCommit: true },
    });
  });

  it('rejects unmappable SET TRANSACTION clauses BY NAME (wire-guard contract)', () => {
    const cases: Array<[string, RegExp]> = [
      ['set transaction reserving t1 for protected write', /RESERVING/],
      ['set transaction no auto undo', /NO AUTO UNDO/],
      ['set transaction ignore limbo', /IGNORE LIMBO/],
      ['set transaction read committed read consistency', /READ CONSISTENCY/],
      ['set transaction snapshot at number 123', /SNAPSHOT AT NUMBER/],
      ['set transaction lock wait 5', /LOCK/],
      ['set transaction bogus', /BOGUS/],
    ];
    for (const [sql, re] of cases) {
      const r = cc(sql) as ClientCommand & { op: 'unsupported' };
      expect(r.op, sql).toBe('unsupported');
      expect(r.reason, sql).toMatch(re);
    }
  });

  it('returns null for ordinary DSQL — including strings that contain command words', () => {
    expect(cc('select 1 from rdb$database')).toBeNull();
    expect(cc("insert into log values ('commit')")).toBeNull();
    expect(cc('set generator g to 1')).toBeNull();
    expect(cc('set statistics index idx')).toBeNull();
  });

  it('parseScript attaches the client field iff kind === client', () => {
    const [a, b, c] = parseScript("commit; insert into t values (1); set transaction read only");
    expect(a!.kind).toBe('client');
    expect(a!.client).toEqual({ op: 'commit', retain: false });
    expect(b!.kind).toBe('dml');
    expect(b!.client).toBeUndefined();
    expect(c!.kind).toBe('client');
    expect(c!.client).toMatchObject({ op: 'setTransaction', options: { readOnly: true } });
  });
});

describe('commentRanges / stripComments (scanner shared with parseScript)', () => {
  const rangesText = (sql: string) => commentRanges(sql).map(([s, e]) => sql.slice(s, e));

  it('reports line and block comments with exact [start, end) offsets', () => {
    const sql = 'select 1 -- tail\n/* head */ select 2';
    expect(rangesText(sql)).toEqual(['-- tail', '/* head */']);
    const [s1, e1] = commentRanges(sql)[0]!;
    expect(sql.slice(s1, e1)).toBe('-- tail');
  });

  it('a block-comment opener inside a string is NOT a comment', () => {
    expect(commentRanges(`select '/* not a comment */' from t`)).toEqual([]);
    expect(commentRanges(`select 'a -- b' from t`)).toEqual([]);
  });

  it('a -- inside a quoted identifier is NOT a comment', () => {
    expect(commentRanges(`select "WEIRD--NAME" from t`)).toEqual([]);
  });

  it('comment markers inside q-literals are NOT comments', () => {
    expect(commentRanges(`select q'{ /* nope */ -- nope }' from t`)).toEqual([]);
  });

  it('doubled-quote escapes do not end the string early', () => {
    expect(commentRanges(`select 'it''s -- fine' from t -- real`).length).toBe(1);
  });

  it('throws the same ScriptParseError parseScript throws on malformed input', () => {
    expect(() => commentRanges('select 1 /* nope')).toThrow(/Unterminated block comment/);
    expect(() => commentRanges("select 'open")).toThrow(/Unterminated string/);
    expect(() => commentRanges("select q'{open")).toThrow(/Unterminated q-literal/);
    let err: ScriptParseError | undefined;
    try {
      commentRanges('select 1;\n  /* nope');
    } catch (e) {
      err = e as ScriptParseError;
    }
    expect(err).toBeInstanceOf(ScriptParseError);
    expect(err!.line).toBe(2);
    expect(err!.column).toBe(3);
  });

  it('stripComments is length-preserving and keeps newlines', () => {
    const sql = 'select 1 /* a\nb */ -- tail\n, 2';
    const out = stripComments(sql);
    expect(out.length).toBe(sql.length);
    expect(out.split('\n').length).toBe(sql.split('\n').length);
    expect(out).toBe('select 1     \n            \n, 2');
    expect(out.indexOf(', 2')).toBe(sql.indexOf(', 2')); // indexes stable
  });

  it('stripComments leaves strings and q-literals intact', () => {
    const sql = `select '/* keep */' || q'{ -- keep }' from t /* drop */`;
    const out = stripComments(sql);
    expect(out).toContain(`'/* keep */'`);
    expect(out).toContain(`q'{ -- keep }'`);
    expect(out).not.toContain('drop');
  });

  it('agrees with parseScript by construction: directive-in-comment scenario', () => {
    // A preprocessor looking for a [NOWAIT]-style marker must not trust one
    // that is commented out. commentRanges answers with the parser's lexing.
    const sql = `-- [DIRECTIVE]\nselect q'{ [DIRECTIVE] }' from t; /* [DIRECTIVE] */ select 2;`;
    const inComment = (idx: number) => commentRanges(sql).some(([s, e]) => idx >= s && idx < e);
    const positions = [...sql.matchAll(/\[DIRECTIVE\]/g)].map((m) => m.index!);
    expect(positions.map(inComment)).toEqual([true, false, true]);
    expect(parseScript(sql).map((s) => s.sql)).toEqual([`select q'{ [DIRECTIVE] }' from t`, 'select 2']);
  });
});
