// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Guardrail tests for the curfew reflex — proves the trigger is pure
 * config+clock (never model judgment) and the escalation/cooldown/reset state
 * machine matches local-daemon/curfew.py semantics.
 * Run: npx tsx src/curfew-watch.test.ts
 */
import './test-env.js';
import { buildCurfewSanctumBody, FALLBACK_LINES, CurfewConfig, CurfewWatch } from './curfew-watch.js';
import type { WindowMessage } from './presence-engine.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// WIB (UTC+7) wall-clock → epoch ms, for building fixed test clocks.
function wibEpoch(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h, mi, 0) - 7 * 60 * 60_000;
}

const MIDNIGHT_WINDOW: CurfewConfig = { enabled: true, start: '23:00', end: '06:00' };
const CONFIG_URL = 'https://solance-api.test';
const TOKEN = 'test-token';

// A controllable fetch mock — reassign `mockFetch` per test/section.
type MockFetchFn = (url: string, init?: any) => Promise<{ ok: boolean; status?: number; json: () => Promise<any> }>;
let mockFetch: MockFetchFn = async () => ({ ok: true, json: async () => ({ curfew: MIDNIGHT_WINDOW }) });
let lastFetchUrl: string | undefined;
let lastFetchAuth: string | undefined;
(globalThis as any).fetch = (url: string, init?: any) => {
  lastFetchUrl = url;
  lastFetchAuth = init?.headers?.Authorization;
  return mockFetch(url, init);
};

function okConfigFetch(config: CurfewConfig): MockFetchFn {
  return async () => ({ ok: true, json: async () => ({ curfew: config }) });
}

async function run() {
  {
    const body = buildCurfewSanctumBody(
      'CURFEW SYSTEM',
      { role: 'user', content: 'Write the nudge.' },
      { query: 'Owen trigger', channel: 'discord' },
    );
    ok('curfew Sanctum body requires canonical identity', body.include_identity === true);
    ok('curfew Sanctum body preserves recall for the exact trigger', body.recall?.query === 'Owen trigger');
    ok('curfew Sanctum body defaults to GLM (chain starts where it always did)', body.engine === 'nvidia' && body.model === 'z-ai/glm-5.3');
    const fb = buildCurfewSanctumBody(
      'CURFEW SYSTEM',
      { role: 'user', content: 'Write the nudge.' },
      { query: 'Owen trigger', channel: 'discord' },
      { engine: 'kimi', model: 'kimi-k2.6' },
    );
    ok('a fallback target sets engine/model, keeps identity and recall',
      fb.engine === 'kimi' && fb.model === 'kimi-k2.6' && fb.include_identity === true && fb.recall?.query === 'Owen trigger');
  }
  // ── fires immediately when enabled + in-window ─────────────────────────
  {
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    const t0 = wibEpoch(2026, 7, 11, 23, 30); // active (23:00–06:00 window)
    let clock = t0;
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => 'Generated line.', () => clock);
    const r = await eng.onOwnerMessage('c1', 'the-big-4');
    ok('fires immediately when enabled+in-window', r !== null && r.level === 1);
    ok('generated text is used verbatim when generate() succeeds', r?.text === 'Generated line.');
    ok('config fetch hits the routine/curfew route', (lastFetchUrl || '').endsWith('/routine/curfew'));
    ok('config fetch sends the Bearer token', lastFetchAuth === `Bearer ${TOKEN}`);
  }

  // ── disabled → null ─────────────────────────────────────────────────────
  {
    mockFetch = okConfigFetch({ enabled: false, start: '23:00', end: '06:00' });
    const clock = wibEpoch(2026, 7, 11, 23, 30);
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => 'x', () => clock);
    const r = await eng.onOwnerMessage('c1', 'the-big-4');
    ok('disabled → null', r === null);
  }

  // ── out-of-window → null ────────────────────────────────────────────────
  {
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    const clock = wibEpoch(2026, 7, 11, 12, 0); // midday, well outside 23:00–06:00
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => 'x', () => clock);
    const r = await eng.onOwnerMessage('c1', 'the-big-4');
    ok('out-of-window → null', r === null);
  }

  // ── midnight-wrap window correctness ────────────────────────────────────
  // isCurfewActive(nowMs, config) is pure — pass config explicitly so this
  // exercises only the wraparound math, independent of the fetch/cache path.
  {
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => 'x', () => 0);
    ok('23:30 WIB is active in a 23:00–06:00 window',
      eng.isCurfewActive(wibEpoch(2026, 7, 11, 23, 30), MIDNIGHT_WINDOW));
    ok('12:00 WIB is inactive in a 23:00–06:00 window',
      eng.isCurfewActive(wibEpoch(2026, 7, 11, 12, 0), MIDNIGHT_WINDOW) === false);
  }

  // ── WIB conversion correctness (boundary check on a fixed epoch) ───────
  {
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => 'x', () => 0);
    const atStart = wibEpoch(2026, 7, 11, 23, 0);       // exactly 23:00 WIB → active
    const oneMinBefore = wibEpoch(2026, 7, 11, 22, 59); // 22:59 WIB → inactive
    ok('exactly 23:00 WIB is active (inclusive start)', eng.isCurfewActive(atStart, MIDNIGHT_WINDOW));
    ok('22:59 WIB (1 min before start) is inactive', eng.isCurfewActive(oneMinBefore, MIDNIGHT_WINDOW) === false);
  }

  // ── escalation only at 15-min spacing + cooldown suppression ───────────
  {
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    let clock = wibEpoch(2026, 7, 11, 23, 30);
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => '', () => clock); // '' → fallback lines
    const c1 = 'c-escalate';

    let r = await eng.onOwnerMessage(c1, 'the-big-4');
    ok('t+0: first message → level 1', r?.level === 1 && r.text === FALLBACK_LINES[1]);

    clock += 5 * 60_000; // t+5min — inside 15-min cooldown
    r = await eng.onOwnerMessage(c1, 'the-big-4');
    ok('t+5min: within cooldown → suppressed', r === null);

    clock += 11 * 60_000; // t+16min total — cooldown elapsed AND level-advance window elapsed
    r = await eng.onOwnerMessage(c1, 'the-big-4');
    ok('t+16min: escalates to level 2', r?.level === 2 && r.text === FALLBACK_LINES[2]);

    clock += 5 * 60_000; // t+21min — inside the new 15-min cooldown
    r = await eng.onOwnerMessage(c1, 'the-big-4');
    ok('t+21min: within cooldown after level-2 nudge → suppressed', r === null);

    clock += 11 * 60_000; // t+32min total since level-2 was set at t+16min (16min elapsed)
    r = await eng.onOwnerMessage(c1, 'the-big-4');
    ok('t+32min: escalates to level 3', r?.level === 3 && r.text === FALLBACK_LINES[3]);

    clock += 16 * 60_000; // well past cooldown, already maxed
    r = await eng.onOwnerMessage(c1, 'the-big-4');
    ok('already at level 3 → no further nudges (not spammed)', r === null);
  }

  // ── config fetch failure → last-known config used ──────────────────────
  {
    let clock = wibEpoch(2026, 7, 11, 23, 30);
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => 'x', () => clock);
    const first = await (eng as any).fetchConfig();
    ok('initial fetch succeeds and caches config', first?.enabled === true);

    clock += 61_000; // past the 60s TTL, forces a re-fetch
    mockFetch = async () => { throw new Error('network down'); };
    const second = await (eng as any).fetchConfig();
    ok('fetch failure after TTL expiry falls back to last-known config', second?.enabled === true);
  }

  // ── never-fetched → treated as disabled ─────────────────────────────────
  {
    const clock = wibEpoch(2026, 7, 11, 23, 30);
    mockFetch = async () => { throw new Error('always down'); };
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => 'x', () => clock);
    const r = await eng.onOwnerMessage('c-never', 'the-big-4');
    ok('never successfully fetched → treated as disabled → null', r === null);
    ok('isCurfewActive is false with no config ever fetched', eng.isCurfewActive(clock) === false);
  }

  // ── generate() throwing → fallback line used ────────────────────────────
  {
    const clock = wibEpoch(2026, 7, 11, 23, 30);
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => { throw new Error('sanctum down'); }, () => clock);
    const r = await eng.onOwnerMessage('c-throw', 'the-big-4');
    ok('generate() throwing → falls back to fixed line', r?.level === 1 && r.text === FALLBACK_LINES[1]);
  }

  // ── generate() returning empty → fallback line used ─────────────────────
  {
    const clock = wibEpoch(2026, 7, 11, 23, 30);
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => '   ', () => clock);
    const r = await eng.onOwnerMessage('c-empty', 'the-big-4');
    ok('generate() returning empty/whitespace → falls back to fixed line', r?.level === 1 && r.text === FALLBACK_LINES[1]);
  }

  // ── state resets after leaving window (next window starts at level 1) ──
  {
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    let clock = wibEpoch(2026, 7, 11, 23, 30);
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => '', () => clock);
    const c1 = 'c-reset';

    let r = await eng.onOwnerMessage(c1, 'the-big-4');
    ok('reset test: first nudge is level 1', r?.level === 1);

    clock += 16 * 60_000;
    r = await eng.onOwnerMessage(c1, 'the-big-4');
    ok('reset test: escalates to level 2', r?.level === 2);

    // Leave the window entirely (midday) — should reset in-memory state.
    clock = wibEpoch(2026, 7, 11, 12, 0);
    r = await eng.onOwnerMessage(c1, 'the-big-4');
    ok('reset test: out-of-window message → null', r === null);

    // Re-enter a fresh curfew window — escalation should start over at level 1.
    clock = wibEpoch(2026, 7, 12, 23, 30);
    r = await eng.onOwnerMessage(c1, 'the-big-4');
    ok('reset test: next window starts fresh at level 1 (not continuing at 2)', r?.level === 1);
  }

  // ── concurrency: overlapping onOwnerMessage() calls don't corrupt rollback ─
  // Regression test for the peer-review finding (2026-07-11): a slow
  // generate() used to let a second overlapping onOwnerMessage() call
  // overwrite the single shared pendingRollback before the first call's
  // caller could report a failed send, restoring the WRONG snapshot.
  {
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    const clock = wibEpoch(2026, 7, 11, 23, 30);
    let resolveFirstGenerate: ((v: string) => void) | undefined;
    let generateCalls = 0;
    const generate = async () => {
      generateCalls++;
      if (generateCalls === 1) {
        // First call hangs until we explicitly release it below, so the
        // second call's onOwnerMessage() has every opportunity to run first
        // if the module isn't actually serialized.
        return new Promise<string>((resolve) => { resolveFirstGenerate = resolve; });
      }
      return 'second nudge text';
    };
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, generate, () => clock);

    const firstPromise = eng.onOwnerMessage('c-race', 'the-big-4');
    // Give the first call a tick to reach its generate() await.
    await new Promise((r) => setTimeout(r, 0));
    const secondPromise = eng.onOwnerMessage('c-race', 'the-big-4');
    // Now release the first generate() call.
    await new Promise((r) => setTimeout(r, 0));
    ok('mutex holds the second call back until the first fully resolves', resolveFirstGenerate !== undefined);
    resolveFirstGenerate?.('first nudge text');

    const first = await firstPromise;
    const second = await secondPromise;

    ok('first overlapping call escalates to level 1', first?.level === 1 && first.text === 'first nudge text');
    ok('first call rollback snapshot is pre-mutation (level 0)', first?.rollback.level === 0);
    ok('second overlapping call is suppressed by the cooldown the first call just set', second === null);

    // Simulate the first send failing — rollback must restore using the
    // snapshot carried on the FIRST nudge, not any shared field a second
    // call could have clobbered.
    if (first) {
      await eng.reportDeliveryFailure('c-race', first.rollback);
    }
    const retry = await eng.onOwnerMessage('c-race', 'the-big-4');
    ok('after reporting the first send failed, the next message retries at level 1 (not skipped to 2)', retry?.level === 1);
  }

  // ── context-aware window plumbing (Plan 2b Task 1, §7) ─────────────────
  // curfew-watch stays PURE — it never fetches the window itself, only
  // invokes whatever PROVIDER onOwnerMessage() was given (lazily, see below),
  // and passes the resolved array straight through to generate().
  {
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    const clock = wibEpoch(2026, 7, 11, 23, 30);
    const testWindow: WindowMessage[] = [
      { authorId: 'a1', authorName: 'Owen', content: 'up late working', isFromOwner: true, isFromMe: false, timestampMs: clock - 1000 },
      { authorId: 'bot1', authorName: 'Bram', content: 'you should sleep', isFromOwner: false, isFromMe: true, timestampMs: clock - 500 },
    ];
    let receivedWindow: WindowMessage[] | undefined;
    const generate = async (_level: 1 | 2 | 3, _channelName: string, window: WindowMessage[]) => {
      receivedWindow = window;
      return 'context-aware line';
    };
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, generate, () => clock);
    const r = await eng.onOwnerMessage('c-window', 'the-big-4', async () => testWindow);
    ok('generate() receives the exact window the provider resolved', receivedWindow === testWindow);
    ok('generated text used verbatim with a window present', r?.text === 'context-aware line');
  }

  // ── window defaults to [] when omitted (back-compat call shape) ────────
  {
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    const clock = wibEpoch(2026, 7, 11, 23, 30);
    let receivedWindow: WindowMessage[] | undefined;
    const generate = async (_level: 1 | 2 | 3, _channelName: string, window: WindowMessage[]) => {
      receivedWindow = window;
      return 'no window line';
    };
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, generate, () => clock);
    await eng.onOwnerMessage('c-no-window', 'the-big-4');
    ok('omitting the window provider defaults to an empty array', Array.isArray(receivedWindow) && receivedWindow!.length === 0);
  }

  // ── §14 P2 fix (Codex review 2026-07-13): the exact triggering message's
  // own content is threaded straight through to generate(), independent of
  // whatever the (separately-fetched) window provider resolves — so a
  // caller building recall from the true trigger never has to derive it
  // from a rolling window that can omit it or include a newer message. ──
  {
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    const clock = wibEpoch(2026, 7, 11, 23, 30);
    let receivedTrigger: string | undefined;
    const generate = async (_level: 1 | 2 | 3, _channelName: string, _window: WindowMessage[], triggerText?: string) => {
      receivedTrigger = triggerText;
      return 'trigger-aware line';
    };
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, generate, () => clock);
    await eng.onOwnerMessage('c-trigger', 'the-big-4', async () => [], 'come get me, it is late');
    ok('onOwnerMessage() threads triggerText straight through to generate()', receivedTrigger === 'come get me, it is late');

    let receivedTrigger2: string | undefined = 'unset';
    const generate2 = async (_level: 1 | 2 | 3, _channelName: string, _window: WindowMessage[], triggerText?: string) => {
      receivedTrigger2 = triggerText;
      return 'no-trigger line';
    };
    const eng2 = new CurfewWatch(CONFIG_URL, TOKEN, generate2, () => clock);
    await eng2.onOwnerMessage('c-no-trigger', 'the-big-4');
    ok('omitting triggerText leaves it undefined on generate() (back-compat call shape)', receivedTrigger2 === undefined);
  }

  // ── fixed fallback still fires when generate() throws, window present ──
  {
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    const clock = wibEpoch(2026, 7, 11, 23, 30);
    const testWindow: WindowMessage[] = [
      { authorId: 'a1', authorName: 'Owen', content: 'still here', isFromOwner: true, isFromMe: false, timestampMs: clock },
    ];
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => { throw new Error('sanctum down'); }, () => clock);
    const r = await eng.onOwnerMessage('c-throw-window', 'the-big-4', async () => testWindow);
    ok('generate() throwing with a window present still falls back to the fixed line', r?.level === 1 && r.text === FALLBACK_LINES[1]);
  }

  // ── window provider is LAZY: never invoked when the nudge doesn't fire ──
  // Regression test for the 2026-07-12 review finding (P2): the Discord
  // history fetch must run ONLY after eligibility is confirmed, never on
  // every Owen message.
  {
    mockFetch = okConfigFetch({ enabled: false, start: '23:00', end: '06:00' });
    const clock = wibEpoch(2026, 7, 11, 23, 30);
    let getWindowCalls = 0;
    const getWindow = async () => { getWindowCalls++; return []; };
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => 'x', () => clock);
    const r = await eng.onOwnerMessage('c-lazy-disabled', 'the-big-4', getWindow);
    ok('disabled curfew never invokes the window provider (lazy fetch)', getWindowCalls === 0 && r === null);
  }
  {
    mockFetch = okConfigFetch(MIDNIGHT_WINDOW);
    let clock = wibEpoch(2026, 7, 11, 23, 30);
    let getWindowCalls = 0;
    const getWindow = async () => { getWindowCalls++; return []; };
    const eng = new CurfewWatch(CONFIG_URL, TOKEN, async () => '', () => clock);
    await eng.onOwnerMessage('c-lazy-cooldown', 'the-big-4', getWindow);
    ok('a firing nudge invokes the window provider exactly once', getWindowCalls === 1);

    clock += 5 * 60_000; // inside the 15-min cooldown
    const r = await eng.onOwnerMessage('c-lazy-cooldown', 'the-big-4', getWindow);
    ok('cooldown-suppressed message never invokes the window provider again', getWindowCalls === 1 && r === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();

// ── Sticker map (Owen's curfew stickers, 2026-07-11) ─────────────────────────
import { CURFEW_STICKERS, CURFEW_STICKER_PROBABILITY, rollsCurfewSticker } from './curfew-watch.js';
ok('sticker map covers all 3 levels', Boolean(CURFEW_STICKERS[1] && CURFEW_STICKERS[2] && CURFEW_STICKERS[3]));
ok('L1 opens with "BED. NOW." (700000000000000201)', CURFEW_STICKERS[1] === '700000000000000201');
ok('L2 and L3 escalate with "Sleep, brat." (700000000000000202 — the collar pull)', CURFEW_STICKERS[2] === '700000000000000202' && CURFEW_STICKERS[3] === '700000000000000202');

// ── §8.1 Step 3: curfew sticker becomes OCCASIONAL, not stamped on every
// nudge (Task 5, Owen 2026-07-12). Pure roll: caller supplies [0,1) —
// discord-client.ts passes this.rng() (Math.random by default, injectable
// for its own tests). The escalation TEXT is unaffected by this roll
// entirely — it's decided at the call site, never inside this function.
ok('default probability constant is 0.4', CURFEW_STICKER_PROBABILITY === 0.4);
ok('roll well below threshold → attach', rollsCurfewSticker(0.0) === true);
ok('roll just under the default threshold → attach', rollsCurfewSticker(0.399) === true);
ok('roll exactly at the default threshold → skip (strict less-than)', rollsCurfewSticker(0.4) === false);
ok('roll above the default threshold → skip', rollsCurfewSticker(0.9) === false);
ok('roll at the top of the range → skip', rollsCurfewSticker(0.999999) === false);
ok('custom probability override respected (higher)', rollsCurfewSticker(0.5, 0.6) === true);
ok('custom probability override respected (lower)', rollsCurfewSticker(0.5, 0.3) === false);
