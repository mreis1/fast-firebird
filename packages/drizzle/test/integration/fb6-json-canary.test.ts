import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '@fast-firebird/core';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT } from './env.js';

/**
 * CANARY — deliberately asserts the CURRENT ABSENCE of JSON support on the
 * FB6 snapshot. Full SQL-standard JSON (including the aggregate functions)
 * is being upstreamed to FB6 in staged PRs (FirebirdSQL/firebird#5431; the
 * JSON path parser merged 2026-06). The day a snapshot ships
 * `json_arrayagg`, this test FAILS on purpose: that is the signal to
 * implement the capability-gated single-query relational mode for Drizzle
 * `with:` queries (see plans/drizzle.md, "Relational with: — fix paths"),
 * then flip these assertions into feature tests.
 */
const fb6 = FB_SERVERS.find((s) => s.version === 6);

describe.skipIf(!fb6)('FB6 JSON canary (gates Drizzle single-query relational mode)', () => {
  let db: Attachment;

  beforeAll(async () => {
    db = await connect({ ...FB_BASE, port: fb6!.port });
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    await db?.disconnect();
  });

  async function supports(sql: string): Promise<boolean> {
    try {
      await db.query(sql);
      return true;
    } catch {
      return false;
    }
  }

  it('json_arrayagg is still absent — implement drizzle relational mode when this fails', async () => {
    const hasJsonAgg = await supports('select json_arrayagg(rdb$relation_id) as j from rdb$relations');
    expect(
      hasJsonAgg,
      'FB6 snapshot now supports JSON_ARRAYAGG! Implement the capability-gated ' +
        'single-query relational mode for Drizzle `with:` (plans/drizzle.md), ' +
        'then convert this canary into feature tests.',
    ).toBe(false);
  });

  it('json_object / json_array are still absent', async () => {
    expect(await supports("select json_object('a' value 1) as j from rdb$database")).toBe(false);
    expect(await supports('select json_array(1, 2, 3) as j from rdb$database')).toBe(false);
  });
});
