// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * presence-debounce — Owen's phone blips must not flip the bot invisible (Owen, 2 Oct 2026).
 * Run: npx tsx src/presence-debounce.test.ts
 */
import './test-env.js';
import { OFFLINE_GRACE_MS, PresenceDebouncer, isOnlineStatus } from './presence-debounce.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function harness(onlineNow = false) {
  const applied: string[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const state = { onlineNow };
  const d = new PresenceDebouncer({
    apply: (s) => applied.push(s),
    isOwnerOnlineNow: async () => state.onlineNow,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (h: any) => { h.cleared = true; },
  });
  const fireLive = async () => { for (const t of timers.filter((x) => !x.cleared)) { t.cleared = true; t.fn(); } await new Promise((r) => setTimeout(r, 0)); };
  return { d, applied, timers, state, fireLive };
}

(async () => {
  ok('grace is 5 minutes', OFFLINE_GRACE_MS === 300_000);
  ok('online / idle / dnd count as online', isOnlineStatus('online') && isOnlineStatus('idle') && isOnlineStatus('dnd'));
  ok('offline / invisible / missing count as offline', !isOnlineStatus('offline') && !isOnlineStatus('invisible') && !isOnlineStatus(undefined));

  // the real 16:39 blip: offline ×3 (one per guild), back online 8s later
  {
    const h = harness();
    h.d.settle(true);
    h.d.observe('offline'); h.d.observe('offline'); h.d.observe('offline');
    ok('blip: three per-guild offline events start ONE timer', h.timers.length === 1);
    ok('blip: nothing applied yet — the bot stays online', h.applied.join() === 'online');
    h.d.observe('online'); h.d.observe('online'); h.d.observe('online');
    ok('blip: back online cancels the timer', h.timers[0].cleared);
    ok('blip: no flip, no repeat apply', h.applied.join() === 'online');
  }

  // really gone: timer fires and she is still offline
  {
    const h = harness(false);
    h.d.settle(true);
    h.d.observe('offline');
    await h.fireLive();
    ok('gone 5 min: bot goes invisible once', h.applied.join() === 'online,invisible' && h.d.shown === 'invisible');
    h.d.observe('offline');
    ok('gone: further offline events change nothing, no new timer', h.timers.length === 1 && h.applied.length === 2);
    h.d.observe('idle');
    ok('back (idle): online at once', h.applied.join() === 'online,invisible,online');
  }

  // timer fires but a fresh read says she is online (an online event was missed)
  {
    const h = harness(true);
    h.d.settle(true);
    h.d.observe('offline');
    await h.fireLive();
    ok('timer fire re-checks: still online → no flip', h.applied.join() === 'online');
  }

  // boot: an authoritative read applies immediately, either way
  {
    const h = harness();
    h.d.settle(false);
    ok('settle(false) at boot: invisible at once', h.applied.join() === 'invisible');
    h.d.observe('dnd');
    ok('then dnd: online at once', h.applied.join() === 'invisible,online');
  }

  // ── concurrency (Codex round 1) — reads resolved by hand ──
  function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: any) => void; const p = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { p, resolve, reject }; }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  function manual() {
    const applied: string[] = [];
    const timers: { fn: () => void; cleared: boolean }[] = [];
    let read = deferred<boolean>();
    const d = new PresenceDebouncer({
      apply: (st) => applied.push(st),
      isOwnerOnlineNow: () => read.p,
      setTimer: (fn) => { const t = { fn, cleared: false }; timers.push(t); return t; },
      clearTimer: (h: any) => { h.cleared = true; },
    });
    return { d, applied, timers, get read() { return read; }, newRead() { read = deferred<boolean>(); } };
  }
  {
    const m = manual();
    m.d.settle(true);
    m.d.observe('offline');
    m.timers[0].fn();                 // grace over → fresh read in flight
    m.d.observe('online');            // she's back while the read is pending
    m.read.resolve(false);            // the stale read says offline
    await tick();
    ok('race: a stale offline read never overwrites her coming back online', m.applied.join() === 'online' && m.d.shown === 'online');
  }
  {
    const m = manual();
    m.d.settle(true);
    m.d.observe('offline');
    m.timers[0].fn();
    m.d.observe('online');
    m.read.reject(new Error('fetch failed'));
    await tick();
    ok('race: a failed stale read never overwrites her coming back online', m.applied.join() === 'online');
  }
  {
    const m = manual();
    m.d.settle(true);
    m.d.observe('offline');
    m.timers[0].fn();                 // read in flight
    m.d.observe('offline'); m.d.observe('offline');
    ok('read in flight: duplicate offline events start no second timer', m.timers.length === 1);
    m.read.resolve(false); await tick();
    ok('read completes offline: invisible once', m.applied.join() === 'online,invisible');
  }
  {
    const m = manual();
    const boot = deferred<boolean | null>();
    const done = m.d.settleFrom(() => boot.p);
    m.d.observe('online');            // a live event decides first
    boot.resolve(false);              // the boot read (stale) says offline
    await done;
    ok('boot: a stale boot read never overrides a live event', m.applied.join() === 'online');
  }
  {
    const m = manual();
    const boot = deferred<boolean | null>();
    const done = m.d.settleFrom(() => boot.p);
    m.d.observe('offline');           // an offline event only STARTS a grace check
    boot.resolve(true);
    await done;
    ok('boot: an offline event during the boot read still leaves a definite status', m.d.shown === 'online');
    ok('boot: and the grace check it started is still running', m.timers.length === 1 && !m.timers[0].cleared);
    m.timers[0].fn(); m.read.resolve(false); await tick();
    ok('boot: the grace check then decides from a fresh read', m.d.shown === 'invisible');
  }
  {
    const m = manual();
    await m.d.settleFrom(async () => null);
    ok('boot: nobody answered → invisible (hold until known)', m.applied.join() === 'invisible');
    const m2 = manual();
    await m2.d.settleFrom(async () => { throw new Error('gateway'); });
    ok('boot: read threw → invisible', m2.applied.join() === 'invisible');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
