// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/seams.test.ts
 * Proves the seam implementations send exactly the requests the pre-seam inline code sent
 * (URL, method, headers, body). Expected values below are the old inline fetch calls, verbatim. */
import './test-env.js';
import { SolanceApiSettingsStore } from './seams/settings-store.js';
import { SanctumModelProvider } from './seams/model-provider.js';
import { fetchAwayStatus } from './away-status.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

interface Call { url: string; init: any }
let calls: Call[] = [];
let reply: () => any = () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
(globalThis as any).fetch = async (url: string, init?: any) => { calls.push({ url, init }); return reply(); };
const last = () => calls[calls.length - 1];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function run() {
  const API = 'https://api.example';
  const store = new SolanceApiSettingsStore(API, 'tok');
  const sig = new AbortController().signal;

  // GET presence config (old presence-config.ts fetchOnce)
  await store.getPresenceConfig(sig);
  ok('getPresenceConfig', last().url === `${API}/routine/discord` && last().init.method === undefined && same(last().init.headers, { Authorization: 'Bearer tok' }) && last().init.signal === sig && last().init.body === undefined);

  // GET curfew (old curfew-watch.ts)
  await store.getCurfew(sig);
  ok('getCurfew', last().url === `${API}/routine/curfew` && last().init.method === undefined && same(last().init.headers, { Authorization: 'Bearer tok' }) && last().init.signal === sig);

  // GET away status (old away-status.ts)
  await store.getAwayStatus(sig);
  ok('getAwayStatus', last().url === `${API}/routine/away-status` && last().init.method === undefined && same(last().init.headers, { Authorization: 'Bearer tok' }) && last().init.signal === sig);

  // PUT scene sighting / study (old discord-client.ts)
  const sighting = { raised_at: 't', caught: true, message_id: 'm', channel_id: 'c', channel_name: 'n', excerpt: 'e' };
  await store.putPresenceConfig({ scene_sighting: sighting }, sig);
  ok('putPresenceConfig (scene_sighting)', last().url === `${API}/routine/discord` && last().init.method === 'PUT' && same(last().init.headers, { 'content-type': 'application/json', authorization: 'Bearer tok' }) && last().init.body === JSON.stringify({ scene_sighting: sighting }) && last().init.signal === sig);
  const study = { study: { active: true, channel_id: 'c', guild_id: 'g', minutes: 30 } };
  await store.putPresenceConfig(study, sig);
  ok('putPresenceConfig (study)', last().init.method === 'PUT' && last().init.body === JSON.stringify(study));

  // POST curfew event
  await store.postCurfewEvent({ level: 2, channel_id: 'c', message: 'bed' });
  ok('postCurfewEvent', last().url === `${API}/routine/curfew-event` && last().init.method === 'POST' && same(last().init.headers, { 'content-type': 'application/json', authorization: 'Bearer tok' }) && last().init.body === JSON.stringify({ level: 2, channel_id: 'c', message: 'bed' }) && last().init.signal === undefined);

  // POST care interaction
  const mi = { kind: 'custom', context_text: 'fed him', actors: ['mae'], source_platform: 'discord-reply' };
  await store.postCareInteraction(mi);
  ok('postCareInteraction', last().url === `${API}/care/interactions` && last().init.method === 'POST' && same(last().init.headers, { 'content-type': 'application/json', authorization: 'Bearer tok' }) && last().init.body === JSON.stringify(mi));

  // token as a function is read per call
  let tokenNow = 'a';
  const dyn = new SolanceApiSettingsStore(API, () => tokenNow);
  await dyn.getCurfew(); tokenNow = 'b'; await dyn.getCurfew();
  ok('token getter read at call time', calls[calls.length - 2].init.headers.Authorization === 'Bearer a' && last().init.headers.Authorization === 'Bearer b');

  // fetchAwayStatus still goes through the same request
  calls = [];
  await fetchAwayStatus(API, 'tok');
  ok('fetchAwayStatus default store request', calls.length === 1 && calls[0].url === `${API}/routine/away-status` && same(calls[0].init.headers, { Authorization: 'Bearer tok' }));

  // ── model provider ──
  const sanctum = new SanctumModelProvider('https://sanctum.example/', 'key', 5000, { engine: 'nvidia', model: 'prim' });
  const target = { engine: 'kimi', model: 'kimi-k3' };

  reply = () => ({ ok: true, status: 200, json: async () => ({ text: 'hi', memory_nodes: [1], recall_ms: 5, system_prompt: 'sp' }), text: async () => '' });
  calls = [];
  const r1 = await sanctum.complete(target, 'SYS', 'hello', 123, { query: 'q', channel: 'discord' } as any, true);
  ok('complete: url/method/headers', last().url === 'https://sanctum.example/complete' && last().init.method === 'POST' && same(last().init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer key' }));
  ok('complete: body', last().init.body === JSON.stringify({
    engine: 'kimi', model: 'kimi-k3', system: 'SYS',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 123, include_identity: true, recall: { query: 'q', channel: 'discord' },
  }));
  ok('complete: result parsed', r1.ok && r1.text === 'hi' && r1.recallMs === 5 && r1.systemPrompt === 'sp');

  await sanctum.complete(target, 'SYS', 'hello', 50);
  ok('complete: no identity/recall keys when unset', last().init.body === JSON.stringify({ engine: 'kimi', model: 'kimi-k3', system: 'SYS', messages: [{ role: 'user', content: 'hello' }], max_tokens: 50 }));

  reply = () => ({ ok: true, status: 200, json: async () => ({ prepared: true, identity_included: true, system_prompt: 'P', memory_nodes: [], private_snippets: [] }), text: async () => '' });
  const prep = await sanctum.prepare('SYS', { query: 'q', channel: 'discord' } as any);
  ok('prepare: url/method/headers', last().url === 'https://sanctum.example/complete' && last().init.method === 'POST' && same(last().init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer key' }));
  ok('prepare: body', last().init.body === JSON.stringify({ engine: 'nvidia', model: 'prim', system: 'SYS', recall: { query: 'q', channel: 'discord' }, prepare_only: true, include_identity: true }));
  ok('prepare: result', prep?.systemPrompt === 'P');

  const sg = new AbortController().signal;
  await sanctum.postComplete({ a: 1 }, sg);
  ok('postComplete (away/curfew chains)', last().url === 'https://sanctum.example//complete' && last().init.method === 'POST' && same(last().init.headers, { 'Content-Type': 'application/json', Authorization: 'Bearer key' }) && last().init.body === '{"a":1}' && last().init.signal === sg);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();
