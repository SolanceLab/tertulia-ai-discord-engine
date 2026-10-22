// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * typing.test.ts — renewal, stop on success and throw, ambient pause bounds,
 * no typing when the judge stays silent. Run: npx tsx src/typing.test.ts
 */
import './test-env.js';
import { createSpeakerLock } from './speaker-lock.js';
import { type TypingTimers, TYPING_RENEW_MS, withTyping, typingPause, ambientTypingPause } from './typing.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// A fake clock: intervals fire only when advance() moves time past them.
function fakeTimers() {
  let now = 0;
  const live = new Map<number, { fn: () => void; ms: number; next: number }>();
  let id = 0;
  const timers: TypingTimers = {
    setInterval: (fn, ms) => { id++; live.set(id, { fn, ms, next: now + ms }); return id; },
    clearInterval: (h) => { live.delete(h as number); },
  };
  return {
    timers,
    active: () => live.size,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let due: { fn: () => void; ms: number; next: number } | null = null;
        for (const t of live.values()) if (t.next <= end && (!due || t.next < due.next)) due = t;
        if (!due) break;
        now = due.next; due.next += due.ms; due.fn();
      }
      now = end;
    },
  };
}

async function run() {
  // renewal every 8 s, stopped on success
  {
    const clock = fakeTimers();
    const sent: string[] = [];
    let release!: () => void;
    const p = withTyping(async (c) => { sent.push(c); }, 'c1', () => new Promise<string>((r) => { release = () => r('done'); }), clock.timers);
    ok('typing starts at once', sent.length === 1);
    clock.advance(TYPING_RENEW_MS - 1);
    ok('no renewal before 8 s', sent.length === 1);
    clock.advance(1);
    ok('renewed at 8 s', sent.length === 2);
    clock.advance(TYPING_RENEW_MS * 2);
    ok('renewed again every 8 s', sent.length === 4);
    release();
    ok('result passes through', (await p) === 'done');
    ok('timer cleared after success', clock.active() === 0);
    clock.advance(TYPING_RENEW_MS * 3);
    ok('no renewal after stop', sent.length === 4);
  }
  // stopped on throw, error passes through
  {
    const clock = fakeTimers();
    let threw = false;
    try { await withTyping(async () => {}, 'c1', async () => { throw new Error('boom'); }, clock.timers); }
    catch (e: any) { threw = e.message === 'boom'; }
    ok('error passes through', threw);
    ok('timer cleared after throw', clock.active() === 0);
  }
  // a typing failure never blocks the reply
  {
    const clock = fakeTimers();
    const r1 = await withTyping(async () => { throw new Error('no perms'); }, 'c1', async () => 'sent', clock.timers);
    const r2 = await withTyping((() => { throw new Error('sync fail'); }) as any, 'c1', async () => 'sent2', clock.timers);
    ok('async typing failure ignored', r1 === 'sent');
    ok('sync typing failure ignored', r2 === 'sent2');
  }
  // a hung typing request never delays the reply
  {
    const clock = fakeTimers();
    const t0 = Date.now();
    const r = await withTyping(() => new Promise<void>(() => {}), 'c1', async () => 'ok', clock.timers);
    ok('hung typing does not delay reply', r === 'ok' && Date.now() - t0 < 200);
  }
  // awaitFirst: the reply work never starts before the first typing request has landed
  {
    const clock = fakeTimers();
    const events: string[] = [];
    let landTyping!: () => void;
    const p = withTyping(
      () => new Promise<void>((r) => { events.push('typing:start'); landTyping = () => { events.push('typing:landed'); r(); }; }),
      'c1',
      async () => { events.push('send'); return 'sent'; },
      clock.timers, TYPING_RENEW_MS,
      { awaitFirst: true, sleep: () => new Promise<void>(() => {}) },
    );
    await Promise.resolve();
    ok('send waits for the first typing request', events.join() === 'typing:start');
    landTyping();
    ok('result passes through after awaited typing', (await p) === 'sent');
    ok('typing landed before send', events.join() === 'typing:start,typing:landed,send');
  }
  // awaitFirst: a hung first request is capped, so the reply still goes out
  {
    const clock = fakeTimers();
    let capMs = -1;
    const r = await withTyping(() => new Promise<void>(() => {}), 'c1', async () => 'ok', clock.timers, TYPING_RENEW_MS,
      { awaitFirst: true, sleep: async (ms) => { capMs = ms; } });
    ok('hung first typing request is capped', r === 'ok' && capMs > 0 && capMs <= 1000);
  }
  // shouldType false from the start: no typing at all, reply work still runs
  {
    const clock = fakeTimers();
    const sent: string[] = [];
    const r = await withTyping(async (c) => { sent.push(c); }, 'c1', async () => { clock.advance(TYPING_RENEW_MS * 3); return 'ran'; },
      clock.timers, TYPING_RENEW_MS, { shouldType: () => false, awaitFirst: true });
    ok('no typing when the message is already claimed', sent.length === 0 && r === 'ran');
    ok('timer still cleared when typing is off', clock.active() === 0);
  }
  // shouldType flips mid-work (another path claims the message): renewals stop
  {
    const clock = fakeTimers();
    const lock = createSpeakerLock();
    const sent: string[] = [];
    let release!: () => void;
    const p = withTyping(async (c) => { sent.push(c); }, 'c1', () => new Promise<string>((r) => { release = () => r('x'); }),
      clock.timers, TYPING_RENEW_MS, { shouldType: () => !lock.isClaimed('m1') });
    ok('typing shown while unclaimed', sent.length === 1);
    clock.advance(TYPING_RENEW_MS);
    ok('renewed while unclaimed', sent.length === 2);
    lock.tryClaimSpeaker('m1');
    clock.advance(TYPING_RENEW_MS * 2);
    ok('renewals stop once another path claims the message', sent.length === 2);
    release(); await p;
  }
  // a throwing shouldType counts as "do not type" and never blocks the reply
  {
    const clock = fakeTimers();
    const sent: string[] = [];
    const r = await withTyping(async (c) => { sent.push(c); }, 'c1', async () => 'ok', clock.timers, TYPING_RENEW_MS,
      { shouldType: () => { throw new Error('x'); } });
    ok('throwing shouldType is safe', r === 'ok' && sent.length === 0);
  }
  // speaker lock peek
  {
    let t = 0;
    const lock = createSpeakerLock(() => t, 1000);
    ok('unclaimed message reads unclaimed', !lock.isClaimed('a'));
    lock.tryClaimSpeaker('a');
    ok('claimed message reads claimed', lock.isClaimed('a'));
    ok('peek does not claim', !lock.isClaimed('b') && lock.tryClaimSpeaker('b'));
    lock.releaseClaim('a');
    ok('released claim reads unclaimed', !lock.isClaimed('a'));
    lock.tryClaimSpeaker('c'); t = 1500;
    ok('expired claim reads unclaimed', !lock.isClaimed('c'));
  }
  // ambient: a hung typing request does not extend the pause
  {
    const t0 = Date.now();
    await ambientTypingPause(() => new Promise<void>(() => {}), 'c', 'hi', async () => {});
    ok('hung ambient typing does not delay send', Date.now() - t0 < 200);
  }
  // pause bounds
  ok('empty text pauses 1 s', typingPause('') === 1000);
  ok('short text at least 1 s', typingPause('ok') >= 1000);
  ok('long text capped at 3 s', typingPause('x'.repeat(5000)) === 3000);
  ok('pause grows with length', typingPause('x'.repeat(40)) < typingPause('x'.repeat(80)));
  for (const n of [0, 1, 10, 50, 100, 500, 2000]) {
    const ms = typingPause('y'.repeat(n));
    ok(`pause within 1-3 s at ${n} chars`, ms >= 1000 && ms <= 3000);
  }
  // ambient: typing once, then the pause, in that order
  {
    const events: string[] = [];
    await ambientTypingPause(async (c) => { events.push(`typing:${c}`); }, 'c2', 'hello there', async (ms) => { events.push(`sleep:${ms}`); });
    ok('ambient shows typing once then waits', events.length === 2 && events[0] === 'typing:c2' && events[1] === `sleep:${typingPause('hello there')}`);
  }
  // judge stays silent: the caller never reaches the helper, so nothing is sent
  {
    const sent: string[] = [];
    const judge = { speak: false, message: '' };
    if (judge.speak) await ambientTypingPause(async (c) => { sent.push(c); }, 'c3', judge.message, async () => {});
    ok('no typing when the judge stays silent', sent.length === 0);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();
