// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/sticker-history.test.ts */
import './test-env.js';
import { StickerHistory } from './sticker-history.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function run() {
  // same id twice in a row → recentlyUsed true
  {
    const h = new StickerHistory();
    h.record('c1', 'sticker-a');
    ok('same id recorded → recentlyUsed true', h.recentlyUsed('c1', 'sticker-a') === true);
  }

  // a different id → false
  {
    const h = new StickerHistory();
    h.record('c1', 'sticker-a');
    ok('a different id is not recentlyUsed', h.recentlyUsed('c1', 'sticker-b') === false);
  }

  // TTL expiry (advance the injected clock) → false
  {
    let t = 1_000_000;
    const h = new StickerHistory({ ttlMs: 1000, now: () => t });
    h.record('c1', 'sticker-a');
    ok('within TTL still recentlyUsed', h.recentlyUsed('c1', 'sticker-a') === true);
    t += 1001;
    ok('after TTL expiry no longer recentlyUsed', h.recentlyUsed('c1', 'sticker-a') === false);
  }

  // per-channel isolation
  {
    const h = new StickerHistory();
    h.record('channel-A', 'sticker-a');
    ok('id used in channel A is recentlyUsed there', h.recentlyUsed('channel-A', 'sticker-a') === true);
    ok('id used in channel A is NOT recentlyUsed in channel B', h.recentlyUsed('channel-B', 'sticker-a') === false);
  }

  // capacity: recording a 4th id evicts the oldest of the 3
  {
    const h = new StickerHistory({ capacity: 3 });
    h.record('c1', 's1');
    h.record('c1', 's2');
    h.record('c1', 's3');
    ok('s1 still recentlyUsed before the 4th record', h.recentlyUsed('c1', 's1') === true);
    h.record('c1', 's4');
    ok('oldest (s1) evicted after a 4th distinct id', h.recentlyUsed('c1', 's1') === false);
    ok('s2 still tracked', h.recentlyUsed('c1', 's2') === true);
    ok('s3 still tracked', h.recentlyUsed('c1', 's3') === true);
    ok('s4 (newest) tracked', h.recentlyUsed('c1', 's4') === true);
  }

  // LRU channel cap: 51 channels → oldest-touched channel evicted, others intact
  {
    const h = new StickerHistory({ maxChannels: 50 });
    for (let i = 0; i < 50; i++) {
      h.record(`chan-${i}`, 'x');
    }
    ok('chan-0 (first touched) still tracked at exactly 50 channels', h.recentlyUsed('chan-0', 'x') === true);
    // 51st distinct channel pushes count over the cap.
    h.record('chan-50', 'x');
    ok('chan-0 (least-recently-touched) evicted once cap exceeded', h.recentlyUsed('chan-0', 'x') === false);
    ok('chan-1 (next oldest) still intact', h.recentlyUsed('chan-1', 'x') === true);
    ok('chan-49 (most recently touched before the 51st) still intact', h.recentlyUsed('chan-49', 'x') === true);
    ok('chan-50 (the new one) tracked', h.recentlyUsed('chan-50', 'x') === true);
  }

  // re-touching an existing channel via record() refreshes its LRU position
  {
    const h = new StickerHistory({ maxChannels: 3 });
    h.record('a', 'x');
    h.record('b', 'x');
    h.record('c', 'x');
    // re-touch 'a' so 'b' becomes the least-recently-touched
    h.record('a', 'y');
    h.record('d', 'x'); // pushes count to 4 → evicts LRU
    ok('re-touched channel a survives', h.recentlyUsed('a', 'y') === true);
    ok('least-recently-touched channel b is evicted', h.recentlyUsed('b', 'x') === false);
    ok('channel c survives', h.recentlyUsed('c', 'x') === true);
    ok('newly added channel d survives', h.recentlyUsed('d', 'x') === true);
  }

  // injectable clock — no real time dependency
  {
    let t = 0;
    const h = new StickerHistory({ ttlMs: 500, now: () => t });
    h.record('c1', 's1');
    t += 100;
    ok('clock fully controlled by injected now()', h.recentlyUsed('c1', 's1') === true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();
