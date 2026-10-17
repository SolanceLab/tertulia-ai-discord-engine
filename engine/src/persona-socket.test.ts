// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/persona-socket.test.ts — the persona socket: provider modes, change history + undo, settings API, companion routes, live use in the prompt. */
import './test-env.js';
import express from 'express';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { logger } from './logger.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } }

const KEY = 'sekrit-key-123';
const URLX = 'https://core.example.org/path/token-abc';
const logged: string[] = [];
for (const k of ['info', 'warn', 'error', 'debug'] as const) (logger as any)[k] = (...a: any[]) => { logged.push(JSON.stringify(a)); };

const dir = mkdtempSync(join(tmpdir(), 'persona-'));

async function run() {
  const P = await import('./seams/persona-provider.js');
  const { LocalSettingsStore } = await import('./seams/local-settings-store.js');
  const { createDashboardRouter } = await import('./dashboard/routes.js');
  const { createHttpServer } = await import('./http-server.js');
  const { PresenceEngine } = await import('./presence-engine.js');
  const { createSeams } = await import('./seams/index.js');

  // --- env ---
  const page = () => ({ text: '', name: '', voice: '' });
  ok('default is the page', P.personaFromEnv({} as any, page).source === 'page');
  const thrown = (env: any) => { try { P.personaFromEnv(env, page); return ''; } catch (e: any) { return e.message; } };
  ok('file needs PERSONA_FILE', /PERSONA_FILE/.test(thrown({ PERSONA: 'file' })));
  ok('url needs PERSONA_URL', /PERSONA_URL/.test(thrown({ PERSONA: 'url' })));
  ok('url refuses http', /https/.test(thrown({ PERSONA: 'url', PERSONA_URL: 'http://x.example/p' })));
  ok('unknown PERSONA refused', /PERSONA must be/.test(thrown({ PERSONA: 'bogus' })));
  ok('refusal does not echo the address', !thrown({ PERSONA: 'url', PERSONA_URL: 'http://x.example/secret' }).includes('secret'));

  // --- page source composes the three fields ---
  ok('empty fields add nothing', P.composePersona({ text: '', name: '', voice: '' }) === '');
  const composed = P.composePersona({ text: 'A warm host.', name: 'Bram', voice: 'dry' });
  ok('composed carries name, who and voice', composed.includes('Bram') && composed.includes('A warm host.') && composed.includes('dry'));
  const pg = await new P.PagePersona(() => ({ text: 'T', name: '', voice: '' })).get();
  ok('page source is editable', pg.source === 'page' && pg.editable === true && pg.text === 'T');

  // --- file source: re-read when the modified time changes, read-only ---
  const f = join(dir, 'persona.md');
  writeFileSync(f, 'first');
  const fp = new P.FilePersona(f);
  const a1 = await fp.get();
  ok('file read, read-only', a1.text === 'first' && a1.source === 'file' && a1.editable === false);
  writeFileSync(f, 'second'); utimesSync(f, new Date(), new Date(Date.now() + 5000));
  const a2 = await fp.get();
  ok('file re-read on change, new version', a2.text === 'second' && a2.version !== a1.version);
  const a3 = await fp.get();
  ok('unchanged file keeps its version', a3.version === a2.version);
  writeFileSync(f, 'x'.repeat(100_000)); utimesSync(f, new Date(), new Date(Date.now() + 9000));
  ok('file capped at 64 KiB', (await fp.get()).text.length === P.PERSONA_MAX_BYTES);
  const gone = new P.FilePersona(join(dir, 'gone.md'));
  ok('missing file gives empty, no throw', (await gone.get()).text === '');

  // --- url source ---
  let nowMs = 1_000_000;
  let calls = 0; let seen: any = null; let mode: 'ok' | 'fail' | 'big' | 'json' | 'redirect' = 'ok'; let body = 'core v1';
  const mkResp = (b: string | Uint8Array, status = 200, type = 'text/plain') => {
    const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b;
    return new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), { status, headers: { 'content-type': type } });
  };
  const fetchStub = (async (u: any, init: any) => {
    calls++; seen = { u, init };
    if (mode === 'fail') throw new Error(`connect failed for ${URLX} with ${KEY}`);
    if (mode === 'big') return mkResp(new Uint8Array(P.PERSONA_MAX_BYTES + 10));
    if (mode === 'json') return mkResp(JSON.stringify({ text: 'from json' }), 200, 'application/json');
    return mkResp(body);
  }) as any;
  const up = new P.UrlPersona(URLX, KEY, fetchStub, () => nowMs);
  const u1 = await up.get();
  ok('url fetched, read-only', u1.text === 'core v1' && u1.source === 'url' && u1.editable === false && calls === 1);
  ok('url sends Bearer key, no redirects', seen.init.headers.authorization === `Bearer ${KEY}` && seen.init.redirect === 'error');
  body = 'core v2'; nowMs += 5 * 60_000;
  ok('cached inside the interval', (await up.get()).text === 'core v1' && calls === 1);
  nowMs += 6 * 60_000;
  const stale = await up.get();
  ok('stale text served while it refreshes', stale.text === 'core v1');
  await new Promise((r) => setTimeout(r, 20));
  ok('refreshed after 10 minutes', (await up.get()).text === 'core v2' && calls === 2);
  mode = 'fail'; nowMs += 11 * 60_000;
  await up.get(); await new Promise((r) => setTimeout(r, 20));
  ok('failure keeps the last good text', (await up.get()).text === 'core v2');
  const callsAfterFail = calls;
  await up.get(); await up.get();
  ok('failure backs off, not hammered', calls === callsAfterFail);
  mode = 'big'; nowMs += 2 * 60_000;
  await up.get(); await new Promise((r) => setTimeout(r, 20));
  ok('oversize reply ignored, last good kept', (await up.get()).text === 'core v2');
  mode = 'json'; nowMs += 2 * 60_000;
  await up.get(); await new Promise((r) => setTimeout(r, 20));
  ok('json reply { text } accepted', (await up.get()).text === 'from json');
  ok('key and address never logged', !logged.some((l) => l.includes(KEY) || l.includes('token-abc') || l.includes('core.example.org')));
  const never = new P.UrlPersona(URLX, KEY, (async () => { throw new Error('down'); }) as any, () => nowMs);
  ok('no good text yet gives empty', (await never.get()).text === '');

  // --- history: append, undo, cap ---
  const store = new LocalSettingsStore(join(dir, 'settings.json'), () => Date.parse('2026-10-16T01:00:00Z'));
  await store.applyPersona({ name: 'Bram', text: 'Host.' }, 'owner');
  await store.applyInstructions('be brief', 'agent');
  let h = await store.getHistory();
  ok('each changed field is recorded with who and the text either side', h.length === 3 && h[1].by === 'owner' && h[1].field === 'persona.name' && h[1].before === '' && h[1].after === 'Bram' && h[2].by === 'agent' && h[2].field === 'extra_instructions' && h[2].at === '2026-10-16T01:00:00.000Z');
  await store.applyPersona({ name: 'Bram' }, 'owner');
  ok('an unchanged value records nothing', (await store.getHistory()).length === 3);
  await store.putPresenceConfig({ extra_instructions: 'be very brief' });
  h = await store.getHistory();
  ok('presence-config API change is recorded as the agent', h.length === 4 && h[3].by === 'agent' && h[3].before === 'be brief' && h[3].after === 'be very brief');
  await store.putPresenceConfig({ presence_level: 3 });
  ok('unrelated presence change records nothing', (await store.getHistory()).length === 4);
  const id3 = h[3].id;
  ok('every entry has a distinct stable id', h.every((e) => typeof e.id === 'string' && e.id) && new Set(h.map((e) => e.id)).size === h.length);
  const undone = await store.undoChange(id3, 'owner');
  ok('undo restores the before text', (await store.getInstructions()) === 'be brief' && undone.undo_of === id3 && undone.by === 'owner');
  h = await store.getHistory();
  ok('undo is its own entry', h.length === 5 && h[4].before === 'be very brief' && h[4].after === 'be brief');
  let err: any = null;
  try { await store.undoChange(id3, 'owner'); } catch (e) { err = e; }
  ok('undoing what is already restored is refused', err?.status === 409);
  try { await store.undoChange('no-such-id', 'owner'); } catch (e) { err = e; }
  ok('unknown entry is a 404', err?.status === 404);
  try { await store.undoChange(h[0].id, 'owner', false); } catch (e) { err = e; }
  ok('persona undo refused when the persona is not held here', err?.status === 409);
  for (let i = 0; i < 60; i++) await store.applyInstructions(`v${i}`, 'owner');
  ok('history keeps the last 50', (await store.getHistory()).length === 50);
  // stale undo: the page saw entry X; 50 more changes push X out of the list. The undo must not hit another entry.
  const before = await store.getHistory();
  const staleId = before[10].id;
  for (let i = 0; i < 50; i++) await store.applyInstructions(`w${i}`, 'owner');
  const instrNow = await store.getInstructions();
  err = null;
  try { await store.undoChange(staleId, 'owner'); } catch (e) { err = e; }
  ok('stale id after the cap shifted the list is a 404 and changes nothing', err?.status === 404 && (await store.getInstructions()) === instrNow);
  // a change landing between the page loading history and clicking undo does not retarget it
  const snap = await store.getHistory();
  const target = snap[snap.length - 1];
  await store.applyPersona({ voice: 'landed meanwhile' }, 'agent');
  const u2 = await store.undoChange(target.id, 'owner');
  ok('undo by id hits the entry the page showed, not whatever shifted into its slot', u2.undo_of === target.id && u2.field === 'extra_instructions');
  // a newer edit must survive an undo of an older entry
  await store.applyInstructions('first', 'owner');
  const eA = (await store.getHistory()).at(-1)!;
  await store.applyInstructions('second', 'owner');
  err = null;
  try { await store.undoChange(eA.id, 'owner'); } catch (e) { err = e; }
  ok('undo of an older entry after a newer edit is a 409 and keeps the newer value', err?.status === 409 && (await store.getInstructions()) === 'second');
  // legacy entries without an id are loaded with a stable one
  const legacyPath = join(dir, 'legacy.json');
  writeFileSync(legacyPath, JSON.stringify({ history: [{ at: '2026-01-01T00:00:00Z', by: 'owner', field: 'persona.name', before: '', after: 'A' }, { at: '2026-01-01T00:00:00Z', by: 'owner', field: 'persona.name', before: 'A', after: 'B' }] }));
  const ls = new LocalSettingsStore(legacyPath);
  const lh = await ls.getHistory();
  ok('legacy entries get distinct stable ids', lh.length === 2 && lh[0].id !== lh[1].id && (await ls.getHistory())[0].id === lh[0].id);
  ok('settings file still normalises', store.load().history.length === 50 && store.peekPersona().name === 'Bram');

  // --- settings API (owner on the page) ---
  const env: any = { DASHBOARD_PASSWORD: 'pw' };
  const provider = new P.PagePersona(() => store.peekPersona());
  const app = express();
  app.use('/settings', createDashboardRouter({ settingsStore: store, plugs: { model: 'direct', settings: 'local', memory: 'off' } as any, persona: provider, env }));
  const srv: any = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/settings`;
  const call = async (method: string, path: string, b?: unknown, cookie?: string) => {
    const r = await fetch(base + path, { method, headers: { ...(b !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
    return { status: r.status, json: (await r.json().catch(() => null)) as any, headers: r.headers };
  };
  ok('persona API needs login', (await call('GET', '/api/persona')).status === 401);
  const cookie = ((await call('POST', '/api/login', { password: 'pw' })).headers.get('set-cookie') || '').split(';')[0];
  let r = await call('GET', '/api/persona', undefined, cookie);
  ok('GET persona: source, editable, fields, instructions', r.status === 200 && r.json.source === 'page' && r.json.editable === true && r.json.persona.name === 'Bram' && typeof r.json.instructions === 'string');
  r = await call('PUT', '/api/persona', { voice: 'dry', instructions: 'short' }, cookie);
  const hh = await store.getHistory();
  ok('PUT persona saves and records as the owner', r.status === 200 && r.json.persona.voice === 'dry' && hh.slice(-2).every((e) => e.by === 'owner') && hh.at(-1)!.field === 'persona.voice' && hh.at(-2)!.field === 'extra_instructions');
  r = await call('PUT', '/api/persona', { name: 'x'.repeat(200) }, cookie);
  ok('too-long field is a 400', r.status === 400);
  r = await call('PUT', '/api/persona', { nope: 1 }, cookie);
  ok('unknown key is a 400', r.status === 400);
  r = await call('GET', '/api/settings-history', undefined, cookie);
  ok('history newest first with an id to undo by', r.status === 200 && r.json.history[0].id === hh[hh.length - 1].id && r.json.history[0].field === 'persona.voice');
  const last = r.json.history[0];
  r = await call('POST', '/api/settings-history/undo', { id: last.id }, cookie);
  ok('undo through the API', r.status === 200 && r.json.undone.after === last.before);
  r = await call('POST', '/api/settings-history/undo', { id: 7 }, cookie);
  ok('bad id is a 400', r.status === 400);
  // atomic save: a refused save changes nothing, not even the instructions
  const histLen = (await store.getHistory()).length;
  const instrBefore = await store.getInstructions();
  r = await call('PUT', '/api/persona', { instructions: 'new atomic', nope: 1 }, cookie);
  ok('rejected save (unknown key) is a 400 and leaves instructions and history alone', r.status === 400 && (await store.getInstructions()) === instrBefore && (await store.getHistory()).length === histLen);
  r = await call('PUT', '/api/persona', { instructions: 'new atomic', name: 'x'.repeat(200) }, cookie);
  ok('rejected save (too long) changes nothing', r.status === 400 && (await store.getInstructions()) === instrBefore && (await store.getHistory()).length === histLen);
  r = await call('PUT', '/api/persona', { instructions: 'x'.repeat(5000) }, cookie);
  ok('rejected save (instructions too long) changes nothing', r.status === 400 && (await store.getInstructions()) === instrBefore);
  r = await call('PUT', '/api/persona', { instructions: 'good atomic', voice: 'calm' }, cookie);
  ok('a good combined save lands both', r.status === 200 && (await store.getInstructions()) === 'good atomic' && store.peekPersona().voice === 'calm');
  // read-only source: persona edits refused, instructions still fine
  const fileProv = new P.FilePersona(f);
  const app2 = express();
  app2.use('/settings', createDashboardRouter({ settingsStore: store, plugs: { model: 'direct', settings: 'local', memory: 'off' } as any, persona: fileProv, env }));
  const srv2: any = await new Promise((res) => { const s = app2.listen(0, '127.0.0.1', () => res(s)); });
  const base2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}/settings`;
  const c2 = ((await (await fetch(base2 + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) })).headers.get('set-cookie')) || '').split(';')[0];
  const put2 = async (b: unknown) => fetch(base2 + '/api/persona', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: c2 }, body: JSON.stringify(b) });
  const instrRO = await store.getInstructions(); const lenRO = (await store.getHistory()).length;
  ok('file source: persona edit refused', (await put2({ text: 'nope' })).status === 409);
  ok('file source: refused combined save leaves instructions alone', (await put2({ instructions: 'sneaky', text: 'nope' })).status === 409 && (await store.getInstructions()) === instrRO && (await store.getHistory()).length === lenRO);
  ok('file source: instructions still editable', (await put2({ instructions: 'still ok' })).status === 200);
  ok('file source: GET says read-only', (await (await fetch(base2 + '/api/persona', { headers: { cookie: c2 } })).json() as any).editable === false);
  srv2.close();

  // --- companion routes (bot secret; recorded as the agent) ---
  const httpSrv: any = createHttpServer({} as any, {} as any, 'bot-secret', 0, { settingsStore: store, plugs: { model: 'direct', settings: 'local', memory: 'off' } as any, persona: provider });
  await new Promise((res) => httpSrv.listening ? res(null) : httpSrv.once('listening', res));
  const hb = `http://127.0.0.1:${(httpSrv.address() as AddressInfo).port}`;
  const post = async (path: string, b: unknown = {}, auth = 'bot-secret') => {
    const rr = await fetch(hb + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, body: JSON.stringify(b) });
    return { status: rr.status, json: await rr.json().catch(() => null) as any };
  };
  ok('companion routes need the bot secret', (await post('/api/persona-read', {}, 'wrong')).status === 403);
  let pr = await post('/api/persona-read');
  ok('persona-read', pr.status === 200 && pr.json.source === 'page' && pr.json.persona.name === 'Bram');
  pr = await post('/api/persona-update', { text: 'Rewritten by the companion.' });
  const hz = await store.getHistory();
  ok('persona-update saves and records by agent', pr.status === 200 && store.peekPersona().text === 'Rewritten by the companion.' && hz[hz.length - 1].by === 'agent' && hz[hz.length - 1].field === 'persona.text');
  ok('persona-update with nothing is a 400', (await post('/api/persona-update', {})).status === 400);
  pr = await post('/api/instructions-update', { text: 'agent wrote this' });
  ok('instructions-update records by agent', pr.status === 200 && (await store.getHistory()).at(-1)!.by === 'agent' && (await store.getInstructions()) === 'agent wrote this');
  ok('instructions-read', (await post('/api/instructions-read')).json.text === 'agent wrote this');
  ok('instructions-update needs text', (await post('/api/instructions-update', {})).status === 400);
  httpSrv.close();
  const roSrv: any = createHttpServer({} as any, {} as any, 'bot-secret', 0, { settingsStore: store, plugs: { model: 'direct', settings: 'local', memory: 'off' } as any, persona: fileProv });
  await new Promise((res) => roSrv.listening ? res(null) : roSrv.once('listening', res));
  const rb = `http://127.0.0.1:${(roSrv.address() as AddressInfo).port}`;
  const refused = await fetch(rb + '/api/persona-update', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bot-secret' }, body: JSON.stringify({ text: 'x' }) });
  ok('persona-update refused when the source is a file or url', refused.status === 409 && /core/.test(((await refused.json()) as any).error));
  roSrv.close();
  const noDash: any = createHttpServer({} as any, {} as any, 'bot-secret', 0);
  await new Promise((res) => noDash.listening ? res(null) : noDash.once('listening', res));
  ok('House-style setup: persona routes answer 501', (await fetch(`http://127.0.0.1:${(noDash.address() as AddressInfo).port}/api/persona-read`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bot-secret' }, body: '{}' })).status === 501);
  noDash.close();
  srv.close();

  // --- the prompt reads the persona live; a fixed string is unchanged ---
  const captured: string[] = [];
  const modelProvider: any = {
    singleModel: true, identity: { engine: 't', model: 't' },
    async complete(_t: any, system: string) { captured.push(system); return { ok: true, text: 'hi', engine: 't', model: 't' }; },
    async prepare() { return null; }, async postComplete() { throw new Error('unused'); },
  };
  let current = 'PERSONA ONE';
  const engine = new PresenceEngine('http://x.invalid', 'k', async () => current, undefined, undefined, undefined, undefined, { get: async () => ({ extra_instructions: '', presence_level: 2 }) } as any);
  engine.setModelProvider(modelProvider);
  const win: any = [{ id: '1', authorId: '5', authorName: 'Rowan', authorUsername: 'rowan', content: 'hello', timestampMs: Date.now(), replyToId: null, attachments: [] }];
  await engine.respond('room', win, undefined, false, [], '9');
  current = 'PERSONA TWO';
  await engine.respond('room', win, undefined, false, [], '9');
  ok('persona getter is read on every prompt', captured[0].startsWith('PERSONA ONE') && captured[1].startsWith('PERSONA TWO'));
  const fixed = new PresenceEngine('http://x.invalid', 'k', 'FIXED', undefined, undefined, undefined, undefined, { get: async () => ({ extra_instructions: '', presence_level: 2 }) } as any);
  fixed.setModelProvider(modelProvider);
  await fixed.respond('room', win, undefined, false, [], '9');
  ok('a fixed string persona still works', captured[2].startsWith('FIXED'));
  const throwing = new PresenceEngine('http://x.invalid', 'k', async () => { throw new Error('boom'); }, undefined, undefined, undefined, undefined, { get: async () => ({ extra_instructions: '', presence_level: 2 }) } as any);
  throwing.setModelProvider(modelProvider);
  await throwing.respond('room', win, undefined, false, [], '9');
  ok('a failing persona getter falls back to empty, never breaks the prompt', captured.length === 4);

  // --- direct (run-on-your-own-computer) mode wires the same provider into the page ---
  const { readFileSync } = await import('node:fs');
  const ms = readFileSync(new URL('./mcp-server.ts', import.meta.url), 'utf8');
  const callIdx = ms.indexOf('createHttpServer(discordClient, memory, BOT_API_SECRET');
  const block = ms.slice(ms.lastIndexOf('let dashboard', callIdx), callIdx);
  ok('direct mode builds personaFromEnv and passes it in the dashboard deps', /personaFromEnv\(process\.env/.test(block) && /dashboard = \{[^}]*persona[^}]*\}/.test(block));
  ok('direct mode leaves the House (sanctum model) with no persona', /plugs\.model === 'sanctum' \? undefined/.test(block));

  const pe = await import('./persona-edit.js');
  ok('persona tools reachable only with local settings + direct model', pe.personaToolsReachable({ model: 'direct', settings: 'local' }) && !pe.personaToolsReachable({ model: 'sanctum', settings: 'local' }) && !pe.personaToolsReachable({ model: 'direct', settings: 'solance-api' }));
  const dsrc = readFileSync(new URL('./mcp/direct.ts', import.meta.url), 'utf8');
  ok('direct persona handler refuses before touching the store', dsrc.indexOf('personaToolsReachable(houseConfig.plugs)') > 0 && dsrc.indexOf('personaToolsReachable(houseConfig.plugs)') < dsrc.indexOf("const store = settingsStoreFor(process.env.SETTINGS_PATH || './data/settings.json');\n      try {\n        const provider"));
  ok('tools reuse one store per settings file (no per-call instance)', /function settingsStoreFor\(/.test(dsrc) && !/new LocalSettingsStore\(process\.env\.SETTINGS_PATH/.test(dsrc.slice(dsrc.indexOf("case 'discord_persona_read'"))));
  {
    const shared = new LocalSettingsStore(join(dir, 'race.json'));
    const pv = P.personaFromEnv({} as any, () => shared.peekPersona());
    await Promise.all([pe.updateInstructions(shared, 'be brief', 'agent'), pe.updatePersona(shared, pv, { name: 'Wren' }, 'agent')]);
    const hist = await shared.getHistory();
    const fields = hist.map((h: any) => h.field);
    ok('two quick agent edits on one store both land, each with its history entry', fields.includes('extra_instructions') && fields.some((f: string) => /persona/.test(f)));
  }

  // --- seams: House plug builds no socket ---
  const base0 = { sanctum: { url: 'http://s.invalid', key: 'k', timeoutMs: 1000, primaryTarget: { engine: 'nvidia', model: 'm' } as any }, solance: { url: 'http://x.invalid', token: 't' } };
  const house = createSeams({ ...base0, env: { SETTINGS_PATH: join(dir, 's2.json') } as any, cfg: { plugs: { model: 'sanctum', settings: 'solance-api', memory: 'sanctum' } } as any });
  ok('House plug: no persona socket', house.personaProvider === null);
  const pub = createSeams({ ...base0, env: { SETTINGS_PATH: join(dir, 's3.json'), MODEL_API_KEY: 'k', MODEL_NAME: 'm' } as any, cfg: { plugs: { model: 'direct', settings: 'local', memory: 'off' } } as any });
  ok('public plug: page persona by default', pub.personaProvider?.source === 'page');
}

run().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }).catch((e) => { console.error(e); process.exit(1); });
