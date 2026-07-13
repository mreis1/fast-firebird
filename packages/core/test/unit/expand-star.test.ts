import { describe, expect, it } from 'vitest';
import { expandStarSql } from '../../src/api/expand-star.js';
import type { SqlVarDesc } from '../../src/protocol/info.js';

/** Minimal described output column. */
function col(field: string, relationAlias?: string): SqlVarDesc {
  return { type: 496, nullable: true, subType: 0, scale: 0, length: 4, field, relation: relationAlias, relationAlias };
}

const T3 = [col('ID', 'T'), col('NAME', 'T'), col('BIG', 'T')];

describe('expandStarSql', () => {
  it('expands a bare * (qualified by the FROM alias)', () => {
    expect(expandStarSql('select * from t', T3, {})).toBe('select "T"."ID", "T"."NAME", "T"."BIG" from t');
  });

  it('applies exclude at rewrite time', () => {
    expect(expandStarSql('select * from t', T3, { exclude: ['big'] })).toBe('select "T"."ID", "T"."NAME" from t');
  });

  it('applies only at rewrite time', () => {
    expect(expandStarSql('select * from t', T3, { only: ['ID'] })).toBe('select "T"."ID" from t');
  });

  it('expands alias.* preserving the written qualifier', () => {
    const outs = [col('ID', 'A'), col('NAME', 'A'), col('ID', 'B')];
    expect(expandStarSql('select a.*, b.id from t a join u b on 1=1', outs, { exclude: ['a.name'] })).toBe(
      'select a."ID", b.id from t a join u b on 1=1',
    );
  });

  it('handles self-joins via relation aliases', () => {
    const outs = [col('ID', 'T1'), col('BIG', 'T1'), col('ID', 'T2'), col('BIG', 'T2')];
    expect(expandStarSql('select t1.*, t2.* from t t1 join t t2 on t1.id = t2.id', outs, { exclude: ['T2.BIG'] })).toBe(
      'select t1."ID", t1."BIG", t2."ID" from t t1 join t t2 on t1.id = t2.id',
    );
  });

  it('qualified star mixed with expressions maps runs by position', () => {
    // (bare * can't mix with other items — Firebird rejects it at prepare)
    const outs = [col('D'), col('ID', 'T'), col('NAME', 'T'), col('C')];
    expect(expandStarSql('select id * 2 as d, t.*, count(*) over() as c from t', outs, { exclude: ['name'] })).toBe(
      'select id * 2 as d, t."ID", count(*) over() as c from t',
    );
  });

  it('ignores stars inside count(*), strings, comments and subqueries', () => {
    const outs = [col('N')];
    expect(expandStarSql("select count(*) as n from t where x <> '*' /* * */", outs, {})).toBeNull();
    expect(expandStarSql('select (select count(*) from u) as n from t', outs, {})).toBeNull();
  });

  it('leaves multiplication alone', () => {
    expect(expandStarSql('select a*b as p from t', [col('P')], {})).toBeNull();
  });

  it('supports FIRST/SKIP/DISTINCT prefixes', () => {
    expect(expandStarSql('select first 10 skip 5 distinct * from t', T3, { only: ['id'] })).toBe(
      'select first 10 skip 5 distinct "T"."ID" from t',
    );
  });

  it('expands under a WITH clause (CTE stars are untouched)', () => {
    const outs = [col('ID', 'C')];
    expect(expandStarSql('with c as (select id from t) select c.* from c', outs, {})).toBe(
      'with c as (select id from t) select c."ID" from c',
    );
  });

  it('quotes exotic column names', () => {
    const outs = [col('weird "col"', 'T')];
    expect(expandStarSql('select * from t', outs, {})).toBe('select "T"."weird ""col""" from t');
  });

  it('quoted qualifiers match case-sensitively', () => {
    const outs = [col('ID', 'x')];
    expect(expandStarSql('select "x".* from t "x"', outs, {})).toBe('select "x"."ID" from t "x"');
  });

  it('throws on top-level UNION with stars', () => {
    const outs = [col('ID', 'T')];
    expect(() => expandStarSql('select * from t union select id from u', outs, {})).toThrow(/UNION/);
  });

  it('throws when everything is excluded', () => {
    expect(() => expandStarSql('select * from t', T3, { exclude: ['id', 'name', 'big'] })).toThrow(/nothing left/);
  });

  it('throws on unmatched qualifier', () => {
    const outs = [col('ID', 'T')];
    expect(() => expandStarSql('select z.* from t z2', outs, {})).toThrow(/did not match/);
  });

  it('returns null for non-selects and star-free selects', () => {
    expect(expandStarSql('update t set a = 1', [], {})).toBeNull();
    expect(expandStarSql('select id, name from t', T3.slice(0, 2), {})).toBeNull();
  });
});
