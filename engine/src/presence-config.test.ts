// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/presence-config.test.ts */
import './test-env.js';
import './fixtures/install-gateway.js'; // this test drives the engine against a fake gateway fetch
import { DEFAULTS, parseConfig, isIgnoredAuthor, FOCUS_DEFAULT, PresenceConfig, parseNameTriggers } from './presence-config.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

type MockFetchFn = (url: string, init?: any) => Promise<{ ok: boolean; status?: number; json: () => Promise<any> }>;
let mockFetch: MockFetchFn = async () => ({ ok: true, json: async () => ({ discord: {} }) });
(globalThis as any).fetch = (url: string, init?: any) => mockFetch(url, init);

async function run() {
  // never-fetched + network down → DEFAULTS
  mockFetch = async () => { throw new Error('network down'); };
  let pc = new PresenceConfig('http://api', 'tok');
  let cfg = await pc.get();
  ok('DEFAULTS before any successful fetch', cfg.sweep_minutes === 30 && cfg.presence_level === 2);

  // parses + defaults fill gaps
  mockFetch = async () => ({ ok: true, json: async () => ({ discord: { presence_level: 4, sweep_minutes: 45 } }) });
  pc = new PresenceConfig('http://api', 'tok');
  cfg = await pc.get();
  ok('parses fetched values', cfg.presence_level === 4 && cfg.sweep_minutes === 45);
  ok('defaults fill missing keys', JSON.stringify(cfg.name_triggers) === JSON.stringify(DEFAULTS.name_triggers));

  // INVALID payload is treated like a fetch failure → clamped/last-known, never a broken value
  mockFetch = async () => ({ ok: true, json: async () => ({ discord: { sweep_minutes: 'banana', presence_level: 99, name_triggers: 'nope' } }) });
  pc = new PresenceConfig('http://api', 'tok');
  cfg = await pc.get();
  ok('invalid sweep_minutes clamped to a number', typeof cfg.sweep_minutes === 'number' && cfg.sweep_minutes >= 5 && cfg.sweep_minutes <= 240);
  ok('invalid presence_level clamped to 0..4', cfg.presence_level >= 0 && cfg.presence_level <= 4);
  ok('invalid name_triggers coerced to {owner,bot}', Array.isArray(cfg.name_triggers.owner) && Array.isArray(cfg.name_triggers.bot));

  // keeps last-known when a later fetch fails (ttl 0 forces re-fetch)
  let n = 0;
  mockFetch = async () => { n++; if (n === 1) return { ok: true, json: async () => ({ discord: { presence_level: 3 } }) }; throw new Error('down'); };
  pc = new PresenceConfig('http://api', 'tok', { ttlMs: 0 });
  ok('first get reads live', (await pc.get()).presence_level === 3);
  ok('second get keeps last-known on failure', (await pc.get()).presence_level === 3);

  // getCached() — §0.C hot-path safety: sync, never fetches.
  mockFetch = async () => { throw new Error('should never be called by getCached'); };
  pc = new PresenceConfig('http://api', 'tok');
  ok('getCached returns DEFAULTS before any fetch', pc.getCached().sweep_minutes === 30 && pc.getCached().presence_level === 2);

  mockFetch = async () => ({ ok: true, json: async () => ({ discord: { presence_level: 4 } }) });
  pc = new PresenceConfig('http://api', 'tok');
  await pc.get(); // performs the only network call in this block
  mockFetch = async () => { throw new Error('should never be called by getCached'); };
  ok('getCached returns last-known after a successful fetch, without fetching', pc.getCached().presence_level === 4);

  // name_triggers coercion (§0.E) — flat legacy array, nested pass-through, unrecognized custom trigger.
  let nt = parseNameTriggers(['owen', 'bram', 'bramley']);
  ok('flat array splits into owner/bot families', JSON.stringify(nt) === JSON.stringify({ owner: ['owen'], bot: ['bram', 'bramley'] }));

  nt = parseNameTriggers(['owen', 'fable']);
  ok('unrecognized custom trigger is kept, defaulting to the bot family', nt.owner.includes('owen') && nt.bot.includes('fable'));

  nt = parseNameTriggers({ owen: ['owen'], bram: ['bram'] });
  ok('nested wire-key shape passes through', JSON.stringify(nt) === JSON.stringify({ owner: ['owen'], bot: ['bram'] }));

  nt = parseNameTriggers({ owen: ['owen'] });
  ok('nested shape missing a family defaults it to []', Array.isArray(nt.bot) && nt.bot.length === 0);

  nt = parseNameTriggers(undefined);
  ok('missing/malformed name_triggers falls back to DEFAULTS', JSON.stringify(nt) === JSON.stringify(DEFAULTS.name_triggers));

  // ── ignore list (Owen, 2026-08-29) ──────────────────────────────────────
  let cfg2 = parseConfig({ ignored_user_ids: ['123456789012345', '98765432109876543'] });
  ok('a good ignore list survives', JSON.stringify(cfg2.ignored_user_ids) === JSON.stringify(['123456789012345', '98765432109876543']));

  cfg2 = parseConfig({ ignored_user_ids: 'not-an-array' });
  ok('non-array ignore list -> []', Array.isArray(cfg2.ignored_user_ids) && cfg2.ignored_user_ids.length === 0);

  cfg2 = parseConfig({ ignored_user_ids: ['123456789012345', 'not-a-snowflake', 42, null, '12', '1'.repeat(22)] });
  ok('non-snowflake entries are dropped, valid ones kept', JSON.stringify(cfg2.ignored_user_ids) === JSON.stringify(['123456789012345']));

  cfg2 = parseConfig({ ignored_user_ids: ['123456789012345', '123456789012345', '123456789012345'] });
  ok('duplicates collapse to one entry', JSON.stringify(cfg2.ignored_user_ids) === JSON.stringify(['123456789012345']));

  cfg2 = parseConfig({});
  ok('absent ignore field -> []', Array.isArray(cfg2.ignored_user_ids) && cfg2.ignored_user_ids.length === 0);
  ok('DEFAULTS.ignored_user_ids is []', Array.isArray(DEFAULTS.ignored_user_ids) && DEFAULTS.ignored_user_ids.length === 0);

  // ── isIgnoredAuthor ──────────────────────────────────────────────────────
  const list = ['111111111111111111', '222222222222222222'];
  ok('isIgnoredAuthor true for a listed id', isIgnoredAuthor('111111111111111111', list) === true);
  ok('isIgnoredAuthor false for an unlisted id', isIgnoredAuthor('333333333333333333', list) === false);
  ok('isIgnoredAuthor false for null author', isIgnoredAuthor(null, list) === false);
  ok('isIgnoredAuthor false for undefined author', isIgnoredAuthor(undefined, list) === false);
  ok('isIgnoredAuthor false against an empty list', isIgnoredAuthor('111111111111111111', []) === false);

  // ── focus mode ──────────────────────────
  const inactive = (c: ReturnType<typeof parseConfig>) => JSON.stringify(c.focus) === JSON.stringify(FOCUS_DEFAULT);
  const goodFocus = { active: true, raised_at: '2026-09-28T14:00:00.000Z', raised_by: 'wing', until: '2026-09-28T20:00:00.000Z', lowered_at: null };
  let cfg3 = parseConfig({ focus: goodFocus });
  ok('valid focus mode parses through', JSON.stringify(cfg3.focus) === JSON.stringify(goodFocus));
  cfg3 = parseConfig({ focus: { ...goodFocus, active: false, lowered_at: '2026-09-28T16:00:00.000Z' } });
  ok('lowered focus mode parses (active false, lowered_at kept)', cfg3.focus.active === false && cfg3.focus.lowered_at === '2026-09-28T16:00:00.000Z');
  ok('missing focus mode → inactive default', inactive(parseConfig({})));
  ok('DEFAULTS.focus is inactive', DEFAULTS.focus.active === false && DEFAULTS.focus.raised_at === null);
  ok('focus mode not an object → inactive', inactive(parseConfig({ focus: 'up' })));
  ok('focus mode array → inactive', inactive(parseConfig({ focus: [goodFocus] })));
  ok('active non-boolean → inactive', inactive(parseConfig({ focus: { ...goodFocus, active: 'true' } })));
  ok('unparseable raised_at → inactive', inactive(parseConfig({ focus: { ...goodFocus, raised_at: 'yesterday-ish' } })));
  ok('numeric until → inactive', inactive(parseConfig({ focus: { ...goodFocus, until: 12345 } })));
  ok('bad raised_by → inactive', inactive(parseConfig({ focus: { ...goodFocus, raised_by: 'pent/house!' } })));
  ok('too-long raised_by → inactive', inactive(parseConfig({ focus: { ...goodFocus, raised_by: 'x'.repeat(41) } })));
  ok('unknown key → inactive', inactive(parseConfig({ focus: { ...goodFocus, until_hours: 6 } })));
  ok('a malformed focus mode does not disturb other fields', parseConfig({ presence_level: 3, focus: 'bad' }).presence_level === 3);

  // strict parse (Codex review, 2026-09-28)
  ok('bare dates (the review repro) → inactive', inactive(parseConfig({ focus: { active: true, raised_at: '2026-09-28', until: '2026-09-29' } })));
  ok('bare dates even with all five keys → inactive', inactive(parseConfig({ focus: { ...goodFocus, raised_at: '2026-09-28', until: '2026-09-29' } })));
  ok('missing a contract key → inactive', inactive(parseConfig({ focus: { active: true, raised_at: goodFocus.raised_at, raised_by: 'wing', until: goodFocus.until } })));
  ok('offset timestamp (not Z) → inactive', inactive(parseConfig({ focus: { ...goodFocus, until: '2026-09-29T03:00:00+07:00' } })));
  ok('Z timestamp without milliseconds is accepted', parseConfig({ focus: { ...goodFocus, raised_at: '2026-09-28T14:00:00Z', until: '2026-09-28T20:00:00Z' } }).focus.active === true);
  ok('active with null raised_at → inactive', inactive(parseConfig({ focus: { ...goodFocus, raised_at: null } })));
  ok('active with null until → inactive', inactive(parseConfig({ focus: { ...goodFocus, until: null } })));
  ok('active with null raised_by → inactive', inactive(parseConfig({ focus: { ...goodFocus, raised_by: null } })));
  ok('active with lowered_at set → inactive', inactive(parseConfig({ focus: { ...goodFocus, lowered_at: '2026-09-28T15:00:00.000Z' } })));
  ok('active with until == raised_at → inactive', inactive(parseConfig({ focus: { ...goodFocus, until: goodFocus.raised_at } })));
  ok('active with until before raised_at → inactive', inactive(parseConfig({ focus: { ...goodFocus, until: '2026-09-28T13:00:00.000Z' } })));
  ok('never-raised default shape parses', JSON.stringify(parseConfig({ focus: { ...FOCUS_DEFAULT } }).focus) === JSON.stringify(FOCUS_DEFAULT));
  ok('inactive with a bad lowered_at → inactive default', inactive(parseConfig({ focus: { ...goodFocus, active: false, lowered_at: 'soon' } })));

  // fetchFresh — bypasses throttle + cache; null on any failure
  {
    let calls = 0;
    mockFetch = async () => { calls++; return { ok: true, json: async () => ({ discord: { presence_level: 1, focus: goodFocus } }) }; };
    const fp = new PresenceConfig('http://api', 'tok'); // default 120s TTL
    await fp.get();
    const fresh = await fp.fetchFresh();
    ok('fetchFresh fetches even inside the TTL window', calls === 2);
    ok('fetchFresh returns the parsed config', fresh !== null && fresh.focus.active === true);
    mockFetch = async () => ({ ok: true, json: async () => ({ discord: { presence_level: 4, focus: { ...goodFocus, active: false, lowered_at: '2026-09-28T16:00:00.000Z' } } }) });
    const fresh2 = await fp.fetchFresh();
    ok('fetchFresh sees a lowered flag', fresh2 !== null && fresh2.focus.active === false);
    ok('fetchFresh updates lastKnown', fp.getCached().presence_level === 4 && fp.getCached().focus.active === false);
    mockFetch = async () => { throw new Error('down'); };
    ok('fetchFresh → null when the fetch throws', (await fp.fetchFresh()) === null);
    ok('failed fetchFresh keeps lastKnown', fp.getCached().presence_level === 4);
    mockFetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    ok('fetchFresh → null on a non-2xx', (await fp.fetchFresh()) === null);
    mockFetch = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
    ok('fetchFresh → null on unparseable body', (await fp.fetchFresh()) === null);
    const never = new PresenceConfig('http://api', 'tok');
    ok('fetchFresh → null (not DEFAULTS) when never fetched', (await never.fetchFresh()) === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();
