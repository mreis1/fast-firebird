import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type Attachment } from '../../src/index.js';
import { FB_BASE, FB_SERVERS, HOOK_TIMEOUT } from './env.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(db: Attachment, ...names: string[]): Promise<void> {
  const body = names.map((n) => `post_event '${n}';`).join(' ');
  await db.execute(`execute block as begin ${body} end`);
}

describe.each(FB_SERVERS)('events / POST_EVENT on Firebird $version', ({ port, version }) => {
  let db: Attachment;
  let poster: Attachment;
  // Unique names per version so parallel-version runs never cross-talk.
  const A = `evt_a_${version}`;
  const B = `evt_b_${version}`;

  beforeAll(async () => {
    db = await connect({ ...FB_BASE, port });
    poster = await connect({ ...FB_BASE, port });
  }, HOOK_TIMEOUT);
  afterAll(async () => {
    await poster?.disconnect();
    await db?.disconnect();
  });

  it('delivers posted events with monotonic counts and no spurious baseline fire', async () => {
    const listener = await db.events([A, B]);
    const posts: Array<[string, number]> = [];
    listener.on('post', (name, count) => posts.push([name, count]));
    try {
      await delay(250); // let the baseline arrive (must NOT fire)
      expect(posts).toHaveLength(0);

      await post(poster, A);
      await post(poster, A, B);
      await delay(600);

      const aCounts = posts.filter(([n]) => n === A).map(([, c]) => c);
      const bCounts = posts.filter(([n]) => n === B).map(([, c]) => c);
      expect(aCounts).toHaveLength(2);
      expect(bCounts).toHaveLength(1);
      // Counts are cumulative and strictly increasing.
      expect(aCounts[1]!).toBeGreaterThan(aCounts[0]!);
    } finally {
      await listener.close();
    }
  });

  it('emits per-name events and stops after close', async () => {
    const listener = await db.events([A]);
    let hits = 0;
    listener.on(A, () => hits++);
    try {
      await delay(200);
      await post(poster, A);
      await delay(400);
      expect(hits).toBe(1);
    } finally {
      await listener.close();
    }
    // After close, further posts must not be delivered.
    const before = hits;
    await post(poster, A);
    await delay(300);
    expect(hits).toBe(before);
  });

  it('supports two independent listeners', async () => {
    const l1 = await db.events([A]);
    const l2 = await db.events([B]);
    const seen1: number[] = [];
    const seen2: number[] = [];
    l1.on(A, (c) => seen1.push(c));
    l2.on(B, (c) => seen2.push(c));
    try {
      await delay(250);
      await post(poster, A, B);
      await delay(500);
      expect(seen1).toHaveLength(1);
      expect(seen2).toHaveLength(1);
    } finally {
      await l1.close();
      await l2.close();
    }
  });
});
