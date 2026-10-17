// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/seams-public.test.ts
 * The public default plugs: local settings file, direct model provider, memory off —
 * and that the House config still selects exactly the Sanctum / solance-api classes. */
import './test-env.js';
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'seams-public-'));
process.env.HOUSE_CONFIG_PATH = join(dir, 'no-such-house.json'); // generic defaults

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

interface Call { url: string; init: any }
let calls: Call[] = [];
let reply: () => any = () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
(globalThis as any).fetch = async (url: string, init?: any) => { calls.push({ url, init }); return reply(); };
const last = () => calls[calls.length - 1];

async function run() {
  const { loadHouseConfig, GENERIC_DEFAULTS } = await import('./config/house-config.js');
  const { LocalSettingsStore, defaultSettings, CURFEW_EVENTS_CAP } = await import('./seams/local-settings-store.js');
  const { DirectModelProvider, directConfigFromEnv } = await import('./seams/direct-model-provider.js');
  const { createSeams } = await import('./seams/index.js');
  const { createLocalContextLogFlush } = await import('./seams/local-context-log.js');
  const { SanctumModelProvider } = await import('./seams/model-provider.js');
  const { SolanceApiSettingsStore } = await import('./seams/settings-store.js');
  const { parseConfig } = await import('./presence-config.js');

  ok('generic defaults select direct/local/off', JSON.stringify(GENERIC_DEFAULTS.plugs) === JSON.stringify({ model: 'direct', settings: 'local', memory: 'off' }));

  // --- local settings store ---
  const sp = join(dir, 'settings.json');
  let nowMs = Date.parse('2026-10-14T10:00:00Z');
  const store = new LocalSettingsStore(sp, () => nowMs);
  const j = async (r: Response) => r.json() as Promise<any>;

  let r = await store.getPresenceConfig();
  let body = await j(r);
  const cfg0 = parseConfig(body.discord);
  ok('defaults: presence level/sweep/triggers; context_log starts off with no House layer', cfg0.presence_level === 2 && cfg0.sweep_minutes === 30 && cfg0.context_log === 'off' && cfg0.name_triggers.bot.length === 0 && cfg0.name_triggers.owner.length === 0);
  r = await store.getCurfew();
  ok('defaults: curfew window disabled', JSON.stringify((await j(r)).curfew) === JSON.stringify({ enabled: false, start: '23:00', end: '06:00' }));
  r = await store.getAwayStatus();
  const away0 = await j(r);
  ok('defaults: not away, announce + shareable', away0.away === false && away0.announce === true && away0.reason_shareable === true);
  ok('defaults: appearance', JSON.stringify(defaultSettings().appearance) === JSON.stringify({ colour_main: '#1f3a6b', colour_accent: '#c9a227', logo: 'none', title: 'Discord settings' }));

  // round-trip presence settings (posture/roam, ignore list, context dial, triggers)
  r = await store.putPresenceConfig({
    presence_level: 4, sweep_minutes: 45, posture: { '123456789012345678': 'high', bad: 'nonsense' },
    extra_instructions: 'be brief', stickers_enabled: false, context_log: 'mentions_only',
    ignored_user_ids: ['111111111111111111', 'nope'], name_triggers: { owner: ['boss'], bot: ['bot'] },
  });
  ok('put presence config 200', r.status === 200);
  const got = parseConfig((await j(await store.getPresenceConfig())).discord);
  ok('round-trip presence', got.presence_level === 4 && got.sweep_minutes === 45 && got.posture['123456789012345678'] === 'high' && !('bad' in got.posture) && got.extra_instructions === 'be brief' && got.stickers_enabled === false);
  ok('round-trip context dial + ignore list + triggers', got.context_log === 'mentions_only' && JSON.stringify(got.ignored_user_ids) === '["111111111111111111"]' && got.name_triggers.bot[0] === 'bot' && got.name_triggers.owner[0] === 'boss');

  // away
  await store.putPresenceConfig({ away: { announce: false, override: { active: true, reason: 'at the dentist', until: '2026-10-14T12:00:00.000Z', set_at: '2026-10-14T09:00:00.000Z' } } });
  const away1 = await j(await store.getAwayStatus());
  ok('away: active with reason and return label', away1.away === true && away1.reason === 'at the dentist' && /^\d\d:\d\d$/.test(away1.until_label) && away1.announce === false);
  const reread = parseConfig((await j(await store.getPresenceConfig())).discord);
  ok('away: override visible in presence record', reread.away.override.active === true && reread.away.override.reason === 'at the dentist' && reread.away.announce === false);
  nowMs = Date.parse('2026-10-14T13:00:00Z');
  ok('away: expires after return time', (await j(await store.getAwayStatus())).away === false);

  // scene: sighting refused while flag down, accepted while up
  r = await store.putPresenceConfig({ scene_sighting: { raised_at: 't', caught: true, message_id: 'm', channel_id: 'c', channel_name: 'n', excerpt: 'e' } });
  ok('scene sighting refused (409) when flag not up', r.status === 409);
  await store.putPresenceConfig({ scene: { active: true, raised_at: '2026-10-14T10:00:00Z', raised_by: 'bram', until: '2026-10-14T20:00:00Z', lowered_at: null } });
  ok('scene flag round-trips', parseConfig((await j(await store.getPresenceConfig())).discord).scene.active === true);
  r = await store.putPresenceConfig({ scene_sighting: { raised_at: 't', caught: true, message_id: 'm', channel_id: 'c', channel_name: 'n', excerpt: 'e' } });
  ok('stale scene sighting (raised_at mismatch) refused 409', r.status === 409);
  r = await store.putPresenceConfig({ scene_sighting: { raised_at: '2026-10-14T10:00:00Z', caught: true, message_id: 'm', channel_id: 'c', channel_name: 'n', excerpt: 'e' } });
  ok('matching scene sighting accepted when flag up', r.status === 200);

  // memory 'off' also silences the legacy journal manager: no network call at all
  {
    const { MemoryManager } = await import('./memory.js');
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 200 }); }) as any;
    try {
      const mm = new MemoryManager(join(mkdtempSync(join(tmpdir(), 'mm-')), 'ledger.json'), 'tok', false);
      await mm.initialize();
      const ctx = await mm.getMemoryContext(true);
      const rd = await mm.readFromSolance();
      ok('memory off: journal manager makes no network calls', calls === 0 && rd.length === 0 && !ctx.recentJournal && !ctx.carryingForward);
    } finally { globalThis.fetch = realFetch; }
  }

  // the public build has no memory write path: nothing in memory.ts can POST a journal entry
  {
    const { MemoryManager } = await import('./memory.js');
    const src = readFileSync(new URL('./memory.ts', import.meta.url), 'utf8');
    const proto = MemoryManager.prototype as any;
    ok('memory.ts has no journal write path', !/journal\/write/.test(src) && !/method:\s*'POST'/.test(src)
      && proto.syncToSolance === undefined && proto.writeToSolance === undefined && proto.flushToSolance === undefined);
  }

  // study window
  r = await store.putPresenceConfig({ study: { active: true, channel_id: '222222222222222222', guild_id: '333333333333333333', minutes: 30 } });
  const study = parseConfig((await j(r)).discord).study;
  ok('study window opened and stamped', study.active === true && study.channel_id === '222222222222222222' && study.minutes === 30 && !!study.nonce && !!study.expires_at);

  // curfew
  await store.update((s) => { s.curfew = { enabled: true, start: '22:30', end: '05:45' }; });
  ok('curfew round-trips', JSON.stringify((await j(await store.getCurfew())).curfew) === JSON.stringify({ enabled: true, start: '22:30', end: '05:45' }));

  // curfew events capped at 200
  for (let i = 0; i < CURFEW_EVENTS_CAP + 15; i++) await store.postCurfewEvent({ level: 1, channel_id: 'c', message: `m${i}` });
  const evs = store.load().curfew_events;
  ok('curfew events capped at 200 (newest kept)', evs.length === CURFEW_EVENTS_CAP && evs[evs.length - 1].message === `m${CURFEW_EVENTS_CAP + 14}`);

  // owner, blocklist, appearance
  await store.update((s) => { s.owner_user_id = '444444444444444444'; s.memory_filter.keyword_blocklist = ['secret', 'private']; s.appearance.colour_main = 'green'; });
  const loaded = store.load();
  ok('owner/blocklist/appearance persist', loaded.owner_user_id === '444444444444444444' && loaded.memory_filter.keyword_blocklist.length === 2 && loaded.appearance.colour_main === 'green' && loaded.appearance.colour_accent === '#c9a227');
  ok('no temp files left behind (atomic rename)', readdirSync(dir).every((f) => !f.endsWith('.tmp')));
  ok('care interaction not available publicly', (await store.postCareInteraction()).status === 404);

  // corrupt file -> defaults, no throw
  writeFileSync(sp, '{ this is not json');
  const corrupt = new LocalSettingsStore(sp);
  const cc = parseConfig((await j(await corrupt.getPresenceConfig())).discord);
  ok('corrupt file falls back to defaults', cc.presence_level === 2 && (await j(await corrupt.getCurfew())).curfew.enabled === false);
  await corrupt.postCurfewEvent({ level: 1, channel_id: 'c', message: 'x' });
  ok('corrupt file is overwritten by the next write', JSON.parse(readFileSync(sp, 'utf8')).curfew_events.length === 1);
  // partially valid file keeps what is valid
  writeFileSync(sp, JSON.stringify({ curfew: { enabled: true, start: 'nope', end: '07:00' }, owner_user_id: 'x' }));
  const part = new LocalSettingsStore(sp);
  ok('partial file: valid fields kept, invalid defaulted', JSON.stringify((await j(await part.getCurfew())).curfew) === JSON.stringify({ enabled: true, start: '23:00', end: '07:00' }) && part.load().owner_user_id === '');

  // --- direct provider: OpenAI-compatible ---
  const target = { engine: 'x', model: 'ignored' };
  const oa = new DirectModelProvider({ kind: 'openai-compatible', baseUrl: 'https://llm.example/v1', apiKey: 'k1', model: 'm1' });
  reply = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hello there' } }] }), text: async () => '' });
  let res = await oa.complete(target, 'SYS', 'hi', 123, { query: 'q' } as any, true);
  let sent = JSON.parse(last().init.body);
  ok('openai: url, auth, body', last().url === 'https://llm.example/v1/chat/completions' && last().init.headers.authorization === 'Bearer k1' && sent.model === 'm1' && sent.max_tokens === 123 && sent.messages[0].role === 'system' && sent.messages[0].content === 'SYS' && sent.messages[1].content === 'hi');
  ok('openai: no recall/identity leaked into the request', !('recall' in sent) && !('include_identity' in sent));
  ok('openai: result shape', res.ok && res.text === 'hello there' && res.status === 200 && res.engine === 'openai-compatible' && res.model === 'm1');
  await oa.complete(target, 'SYS', 'look', 50, undefined, false, [{ url: 'https://cdn.discordapp.com/a.png' }]);
  sent = JSON.parse(last().init.body);
  ok('openai: image parts as image_url + text', sent.messages[1].content[0].type === 'image_url' && sent.messages[1].content[0].image_url.url === 'https://cdn.discordapp.com/a.png' && sent.messages[1].content[1].type === 'text');

  // --- direct provider: Anthropic ---
  const an = new DirectModelProvider({ kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k2', model: 'claude-x' });
  reply = () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] }), text: async () => '' });
  res = await an.complete(target, 'SYS', 'hi', 77);
  sent = JSON.parse(last().init.body);
  ok('anthropic: url + headers', last().url === 'https://api.anthropic.com/v1/messages' && last().init.headers['x-api-key'] === 'k2' && last().init.headers['anthropic-version'] === '2023-06-01' && !last().init.headers.authorization);
  ok('anthropic: system top-level, user message, max_tokens', sent.system === 'SYS' && sent.model === 'claude-x' && sent.max_tokens === 77 && sent.messages.length === 1 && sent.messages[0].role === 'user' && sent.messages[0].content === 'hi');
  ok('anthropic: ALL text blocks joined (not content[0])', res.ok && res.text === 'part one part two');
  await an.complete(target, 'SYS', 'look', 50, undefined, false, [{ url: 'https://cdn.discordapp.com/a.png' }]);
  sent = JSON.parse(last().init.body);
  ok('anthropic: image url source + text', sent.messages[0].content[0].type === 'image' && sent.messages[0].content[0].source.url === 'https://cdn.discordapp.com/a.png' && sent.messages[0].content[1].type === 'text');

  // errors
  reply = () => ({ ok: false, status: 429, json: async () => ({}), text: async () => 'slow down' });
  res = await oa.complete(target, 'S', 'u', 10);
  ok('error: non-ok -> ok:false with status', !res.ok && res.status === 429 && res.failureReason === 'provider rejected the request');
  reply = () => ({ ok: false, status: 410, json: async () => ({}), text: async () => 'model has reached end of life' });
  res = await oa.complete(target, 'S', 'u', 10);
  ok('error: retired model flagged', !res.ok && res.status === 410 && res.retired === true);
  (globalThis as any).fetch = async () => { throw new Error('boom'); };
  res = await oa.complete(target, 'S', 'u', 10);
  ok('error: network throw -> ok:false, no status', !res.ok && res.status === undefined && res.failureReason === 'request failed before a response');
  (globalThis as any).fetch = async (_u: string, init: any) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  res = await new DirectModelProvider({ kind: 'openai-compatible', baseUrl: 'https://x', apiKey: 'k', model: 'm' }, 20).complete(target, 'S', 'u', 10);
  ok('error: timeout reported', !res.ok && /timed out/.test(res.failureReason ?? ''));
  (globalThis as any).fetch = async (url: string, init?: any) => { calls.push({ url, init }); return reply(); };

  // prepare with memory off; postComplete adapter
  const prep = await oa.prepare('MY SYSTEM', { query: 'q' } as any);
  ok('prepare (memory off): system unchanged, no recall, no snippets', prep?.systemPrompt === 'MY SYSTEM' && prep.memoryNodes.length === 0 && Array.isArray(prep.privateSnippets) && prep.privateSnippets.length === 0);
  reply = () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'nudge' } }] }), text: async () => '' });
  const pc = await oa.postComplete({ engine: 'e', model: 'm', system: 'S2', messages: [{ role: 'user', content: 'U2' }], max_tokens: 100, include_identity: true }, new AbortController().signal);
  ok('postComplete adapter returns {text}', pc.ok && (await pc.json() as any).text === 'nudge' && JSON.parse(last().init.body).messages[0].content === 'S2');

  // env config
  let err = '';
  try { directConfigFromEnv({ MODEL_NAME: 'm' } as any); } catch (e: any) { err = e.message; }
  ok('missing MODEL_API_KEY -> startup error naming it', /MODEL_API_KEY/.test(err));
  err = '';
  try { directConfigFromEnv({ MODEL_API_KEY: 'k' } as any); } catch (e: any) { err = e.message; }
  ok('missing MODEL_NAME -> startup error naming it', /MODEL_NAME/.test(err));
  const envc = directConfigFromEnv({ MODEL_API_KEY: 'k', MODEL_NAME: 'm', MODEL_PROVIDER: 'anthropic' } as any);
  ok('env: anthropic default base url', envc.kind === 'anthropic' && envc.baseUrl === 'https://api.anthropic.com');
  ok('env: openai-compatible is the default kind', directConfigFromEnv({ MODEL_API_KEY: 'k', MODEL_NAME: 'm', MODEL_BASE_URL: 'http://localhost:11434/v1/' } as any).kind === 'openai-compatible');

  // --- memory off: local context log ---
  const clp = join(dir, 'ctx.jsonl');
  const flush = createLocalContextLogFlush(clp, 5);
  for (let i = 0; i < 4; i++) await flush([{ message_id: `a${i}`, context_log: { engine: 'e' } }, { message_id: `b${i}` }]);
  const lines = readFileSync(clp, 'utf8').split('\n').filter(Boolean);
  ok('context log: capped, newest kept, row shape kept', lines.length === 5 && JSON.parse(lines[4]).message_id === 'b3' && JSON.parse(lines[3]).context_log.engine === 'e');

  // --- factory ---
  const sanctum = { url: 'https://sanctum.example', key: 'sk', timeoutMs: 1000, primaryTarget: { engine: 'e', model: 'm' } };
  const solance = { url: 'https://api.example', token: 'tk' };
  const generic = loadHouseConfig({ HOUSE_CONFIG_PATH: join(dir, 'missing.json') } as any);
  const envOk = { MODEL_API_KEY: 'k', MODEL_NAME: 'm', SETTINGS_PATH: join(dir, 's2.json'), CONTEXT_LOG_PATH: join(dir, 'c2.jsonl') } as any;
  const pub = createSeams({ env: envOk, cfg: generic, sanctum, solance });
  ok('factory (generic): direct + local + off', pub.modelProvider instanceof DirectModelProvider && pub.settingsStore instanceof LocalSettingsStore && !!pub.localContextLogFlush && pub.modelReady && pub.settingsReady);
  err = '';
  try { createSeams({ env: { SETTINGS_PATH: join(dir, 's3.json') } as any, cfg: generic, sanctum, solance }); } catch (e: any) { err = e.message; }
  ok('factory (generic, no key): startup error names MODEL_API_KEY', /MODEL_API_KEY/.test(err));

  const houseFile = join(dir, 'house.json');
  writeFileSync(houseFile, JSON.stringify({ plugs: { model: 'sanctum', settings: 'solance-api', memory: 'sanctum' }, sanctumUrl: 'https://sanctum.example', solanceApiUrl: 'https://api.example' }));
  const house = loadHouseConfig({ HOUSE_CONFIG_PATH: houseFile } as any);
  const hs = createSeams({ env: {} as any, cfg: house, sanctum, solance }); // no MODEL_* env needed for the House plugs
  ok('factory (House file): exactly SanctumModelProvider + SolanceApiSettingsStore', hs.modelProvider instanceof SanctumModelProvider && hs.settingsStore instanceof SolanceApiSettingsStore && !(hs.modelProvider instanceof DirectModelProvider));
  ok('House file without contextLogDefault: the House keeps house_channels; the generic config is off', house.contextLogDefault === 'house_channels' && generic.contextLogDefault === 'off' && hs.contextLogFlush === null);
  ok('factory (House file): memory stays Sanctum (no local sink), ready flags follow the keys', hs.localContextLogFlush === null && hs.modelReady && hs.settingsReady && hs.plugs.memory === 'sanctum');
  const hsNoKeys = createSeams({ env: {} as any, cfg: house, sanctum: { ...sanctum, key: '' }, solance: { ...solance, token: '' } });
  ok('factory (House file, keys missing): not ready, as before', !hsNoKeys.modelReady && !hsNoKeys.settingsReady);

  // the real House file in the repo (a public checkout has no house/ folder: nothing to check there)
  const realPath = new URL('../../house/discord.house.json', import.meta.url);
  if (existsSync(realPath)) {
    const real = JSON.parse(readFileSync(realPath, 'utf8'));
    ok('repo House file declares the House plugs', JSON.stringify(real.plugs) === JSON.stringify({ model: 'sanctum', settings: 'solance-api', memory: 'sanctum' }));
    const realCfg = loadHouseConfig({ HOUSE_CONFIG_PATH: realPath.pathname } as any);
    const rs = createSeams({ env: {} as any, cfg: realCfg, sanctum, solance });
    ok('factory (repo House file): House plugs', rs.modelProvider instanceof SanctumModelProvider && rs.settingsStore instanceof SolanceApiSettingsStore);

  }
  ok('nothing created in cwd ./data', !existsSync('./data/settings.json'));

  // --- review fixes: blocklist, WIB label, honest attribution ---
  {
    const lp = join(dir, 'bl.jsonl');
    const flush = createLocalContextLogFlush(lp, 2000, () => ['Secret']);
    const r = await flush([{ content: 'my SECRET plan' }, { content: 'hello' }]);
    const lines = readFileSync(lp, 'utf8').split('\n').filter(Boolean);
    ok('blocklist: blocked row never stored', lines.length === 1 && !/secret/i.test(lines.join('')) && r.inserted === 1 && r.skipped === 1);
    const lp2 = join(dir, 'bl2.jsonl');
    await createLocalContextLogFlush(lp2, 2000, () => ['secret'])([{ content: 'secret' }]);
    ok('blocklist: all-blocked batch writes nothing', !existsSync(lp2));
    const st = new LocalSettingsStore(join(dir, 'wib.json'), () => Date.parse('2026-01-01T00:00:00Z'));
    await st.putPresenceConfig({ away: { override: { active: true, reason: 'x', until: '2026-01-01T03:30:00Z', set_at: null } } });
    const lab = await (await st.getAwayStatus()).json() as any;
    ok('away label is WIB regardless of host zone', lab.until_label === '10:30');
    const { PresenceEngine } = await import('./presence-engine.js');
    ok('presence-engine reports provider-returned engine/model', readFileSync(new URL('./presence-engine.ts', import.meta.url), 'utf8').includes('result.engine ?? target.engine'));
    void PresenceEngine;
  }

  // --- review fixes: single-model chain, legacy config migration ---
  {
    const { parseHouseConfig } = await import('./config/house-config.js');
    ok('config file without plugs keeps House plugs', JSON.stringify(parseHouseConfig({ hosServerId: '1' }).plugs) === JSON.stringify({ model: 'sanctum', settings: 'solance-api', memory: 'sanctum' }));
    ok('config with partial plugs fills from generic', parseHouseConfig({ plugs: { model: 'sanctum' } }).plugs.settings === 'local');
    const dp = new DirectModelProvider({ kind: 'openai-compatible', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm1' });
    ok('direct provider is single-model with identity', dp.singleModel === true && dp.identity.model === 'm1');
    const { PresenceEngine } = await import('./presence-engine.js');
    const eng: any = new PresenceEngine('http://s', 'key', 'persona');
    eng.setModelProvider(dp);
    calls = [];
    reply = () => ({ ok: false, status: 429, json: async () => ({}), text: async () => 'rate' });
    const res = await eng.sanctumComplete('sys', 'hi', 100).catch(() => null);
    void res;
    ok('failing direct call is made once, not once per chain target', calls.length === 1);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();

