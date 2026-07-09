import { describe, expect, it } from 'vitest';
import { estimateRowWidth, nextFetchCount } from '../../src/protocol/fetch-plan.js';
import { SqlType } from '../../src/protocol/constants.js';
import type { SqlVarDesc } from '../../src/protocol/info.js';

const col = (type: number, length = 0): SqlVarDesc => ({ type, nullable: false, subType: 0, scale: 0, length });

describe('estimateRowWidth', () => {
  it('sums column wire widths plus bitmap overhead', () => {
    const narrow = estimateRowWidth([col(SqlType.LONG)]);
    const wide = estimateRowWidth([col(SqlType.VARYING, 8000), col(SqlType.INT128)]);
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThanOrEqual(16);
  });
});

describe('nextFetchCount', () => {
  it('narrow rows ramp up to the fetchSize ceiling', () => {
    const w = estimateRowWidth([col(SqlType.LONG)]); // tiny row
    const c0 = nextFetchCount(w, 400, 0);
    const c1 = nextFetchCount(w, 400, c0);
    const c2 = nextFetchCount(w, 400, c1);
    expect(c0).toBe(40); // ramp start
    expect(c1).toBe(80);
    expect(c2).toBe(160);
    // eventually reaches the cap and stays there
    let c = c2;
    for (let i = 0; i < 6; i++) c = nextFetchCount(w, 400, c);
    expect(c).toBe(400);
  });

  it('wide rows are capped by the byte budget, well under fetchSize', () => {
    const w = estimateRowWidth([col(SqlType.VARYING, 32000)]); // ~32KB rows
    const c = nextFetchCount(w, 400, 0);
    // 256KB budget / 32KB ≈ 8 rows — never the full 400.
    expect(c).toBeLessThan(40);
    expect(c).toBeGreaterThanOrEqual(1);
    // ramp cannot exceed the budget ceiling
    const grown = nextFetchCount(w, 400, c);
    expect(grown).toBeLessThanOrEqual(nextFetchCount(w, 400, 999));
  });

  it('respects a small user fetchSize', () => {
    const w = estimateRowWidth([col(SqlType.LONG)]);
    expect(nextFetchCount(w, 5, 0)).toBe(5);
    expect(nextFetchCount(w, 5, 5)).toBe(5);
  });
});
