// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/dashboard.test.ts
 * The bot's settings API (no page is served): routes, login, cookie, settings round-trip, context logs, labels. */
import './test-env.js';
import express from 'express';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const dir = mkdtempSync(join(tmpdir(), 'dashboard-'));
process.env.HOUSE_CONFIG_PATH = join(dir, 'no-such-house.json');

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

async function run() {
  const { createDashboardRouter, resolveLabels } = await import('./dashboard/routes.js');
  const { LocalSettingsStore, DEFAULT_LABELS } = await import('./seams/local-settings-store.js');
  const { loadHouseConfig, GENERIC_DEFAULTS } = await import('./config/house-config.js');

  let nowMs = Date.parse('2026-10-14T10:00:00Z');
  let agentSeen: number | null = null;
  const env: Record<string, string | undefined> = {};
  const store = new LocalSettingsStore(join(dir, 'settings.json'), () => nowMs);
  const logPath = join(dir, 'context-log.jsonl');
  const rows = Array.from({ length: 5 }, (_, i) => JSON.stringify({
    message_id: `m${i}`, channel_id: '1', channel_name: `chan-${i}`, author_id: '2', author_name: 'Bot', content: `reply ${i}`,
    timestamp: `2026-10-14T0${i}:00:00Z`, is_bot: true, guild_id: null, ...(i === 4 ? { context_log: { model: 'x' } } : {}),
  }));
  // a row from the public sinks (neutral shape: at / context) reads on the page too
  rows.push(JSON.stringify({ id: 'n1', at: '2026-10-14T09:00:00.000Z', guild_id: null, channel_id: '1', channel_name: 'chan-n', author_id: '2', author_name: 'Bot', is_bot: true, content: 'reply n', reply_to: null, context: { model: 'y' } }));
  writeFileSync(logPath, rows.join('\n') + '\n');

  const plugs = { model: 'direct', settings: 'local', memory: 'off' } as const;
  function serve(depsExtra: any = {}) {
    const app = express();
    app.use('/settings', createDashboardRouter({
      settingsStore: store, plugs: { ...plugs }, contextLogPath: logPath, env: env as any, now: () => nowMs, agentLastSeen: () => agentSeen, ...depsExtra,
    }));
    return new Promise<{ base: string; close: () => void }>((res) => {
      const s = app.listen(0, '127.0.0.1', () => res({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}/settings`, close: () => s.close() }));
    });
  }
  const call = async (base: string, method: string, path: string, body?: unknown, cookie?: string) => {
    const r = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  const loginCookie = async (base: string) => {
    const r = await call(base, 'POST', '/api/login', { password: 'hunter2' });
    return (r.headers.get('set-cookie') || '').split(';')[0];
  };

  const srv = await serve();
  const b = srv.base;

  // --- off without a password ---
  let r = await call(b, 'GET', '');
  ok('no password: page 503', r.status === 503 && /DASHBOARD_PASSWORD/.test(r.text));
  r = await call(b, 'POST', '/api/login', { password: 'x' });
  ok('no password: login 503', r.status === 503);
  r = await call(b, 'GET', '/api/settings');
  ok('no password: settings 503', r.status === 503);

  env.DASHBOARD_PASSWORD = 'hunter2';

  // --- login ---
  r = await call(b, 'POST', '/api/login', { password: 'nope' });
  ok('wrong password: 401 and no cookie', r.status === 401 && !r.headers.get('set-cookie'));
  r = await call(b, 'GET', '/api/settings');
  ok('settings without cookie: 401', r.status === 401);
  r = await call(b, 'POST', '/api/login', { password: 'hunter2' });
  const setCookie = r.headers.get('set-cookie') || '';
  ok('good password: 200 + hardened cookie', r.status === 200 && /^dash=/.test(setCookie) && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Path=\/settings/.test(setCookie) && !/Secure/.test(setCookie));
  const cookie = setCookie.split(';')[0];
  const viaHttps = await fetch(b + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ password: 'hunter2' }) });
  ok('cookie is Secure behind https', /Secure/.test(viaHttps.headers.get('set-cookie') || ''));

  r = await call(b, 'GET', '/api/settings', undefined, cookie);
  ok('cookie works', r.status === 200 && r.json.curfew && r.json.presence);
  const tampered = cookie.slice(0, -2) + (cookie.endsWith('AA') ? 'BB' : 'AA');
  r = await call(b, 'GET', '/api/settings', undefined, tampered);
  ok('tampered cookie: 401', r.status === 401);
  const [payload] = cookie.slice(5).split('.');
  const forged = `dash=${Buffer.from(JSON.stringify({ exp: nowMs + 1e9 })).toString('base64url')}.${cookie.split('.')[1]}`;
  r = await call(b, 'GET', '/api/settings', undefined, forged);
  ok('forged expiry with old signature: 401', r.status === 401 && !!payload);
  nowMs += 13 * 3_600_000;
  r = await call(b, 'GET', '/api/settings', undefined, cookie);
  ok('expired cookie: 401', r.status === 401);
  nowMs -= 13 * 3_600_000;

  r = await call(b, 'POST', '/api/logout', {}, cookie);
  ok('logout clears cookie', r.status === 200 && /Max-Age=0/.test(r.headers.get('set-cookie') || ''));

  // --- settings round trip ---
  r = await call(b, 'GET', '/api/settings', undefined, cookie);
  const doc0 = r.json;
  ok('defaults: labels are the default names', doc0.labels.quiet_hours === 'Quiet hours' && doc0.labels.focus === 'Focus mode' && doc0.labels.presence === 'Presence');
  ok('GET exposes can_read_context_logs for memory off', doc0.can_read_context_logs === true);
  ok('GET exposes memory status: off, no keys', doc0.memory?.kind === 'off' && doc0.memory.ready === false && Object.keys(doc0.memory).length === 2);
  const srvM = await serve({ memory: () => ({ kind: 'http', recall: async () => null, ping: async () => true, url: 'https://secret.example/x', key: 'KEY123' }) });
  const cM = await loginCookie(srvM.base);
  r = await call(srvM.base, 'GET', '/api/settings', undefined, cM);
  ok('GET exposes memory status: http connected, nothing secret', r.json.memory?.kind === 'http' && r.json.memory.ready === true && !JSON.stringify(r.json).includes('KEY123') && !JSON.stringify(r.json).includes('secret.example'));
  srvM.close();
  ok('agent: off by default, not connected', doc0.agent?.enabled === false && doc0.agent.connected === false && doc0.agent.last_seen === null);
  agentSeen = nowMs - 60_000;
  r = await call(b, 'PUT', '/api/settings', { agent: { enabled: true } }, cookie);
  ok('agent: switch saves and shows connected with last seen', r.status === 200 && r.json.agent.enabled === true && r.json.agent.connected === true && r.json.agent.last_seen === new Date(agentSeen).toISOString());
  // listener: who is listening, and the page's Stop button
  {
    let who: { name: string; since: string } | null = { name: 'Study one', since: '2026-10-14T09:30:00.000Z' };
    const l = await serve({ listener: () => who, stopListener: () => { const was = who !== null; who = null; return was; } });
    const lc = await loginCookie(l.base);
    let lr = await call(l.base, 'GET', '/api/settings', undefined, lc);
    ok('listener: the settings view names who is listening and since when', lr.json.listener?.name === 'Study one' && lr.json.listener?.since === '2026-10-14T09:30:00.000Z');
    lr = await call(l.base, 'POST', '/api/unlisten', {});
    ok('listener: Stop needs the login', lr.status === 401);
    lr = await call(l.base, 'POST', '/api/unlisten', {}, lc);
    ok('listener: Stop releases the session', lr.status === 200 && lr.json.released === true && lr.json.listener === null);
    lr = await call(l.base, 'GET', '/api/settings', undefined, lc);
    ok('listener: afterwards nobody is listening', lr.json.listener === null);
    lr = await call(l.base, 'POST', '/api/unlisten', {}, lc);
    ok('listener: Stop with nobody listening says so', lr.json.released === false);
    l.close();
  }
  agentSeen = nowMs - 4 * 60_000;
  r = await call(b, 'GET', '/api/settings', undefined, cookie);
  ok('agent: seen over 3 minutes ago is not connected', r.json.agent.connected === false && r.json.agent.enabled === true);
  r = await call(b, 'PUT', '/api/settings', { agent: { enabled: 'yes' } }, cookie);
  ok('agent: non-boolean refused', r.status === 400);
  r = await call(b, 'PUT', '/api/settings', { agent: { enabled: false } }, cookie);
  ok('agent: switch off saves', r.status === 200 && r.json.agent.enabled === false);
  r = await call(b, 'GET', '/api/settings', undefined, cookie);
  r = await call(b, 'PUT', '/api/settings', {
    presence: { presence_level: 3, posture: { '700000000000000103': 'high' } },
    curfew: { enabled: true, start: '22:30', end: '07:15' },
    away: { active: true, reason: 'at the shops', until: '2026-10-14T12:00:00.000Z', reason_shareable: false },
    focus: { active: true },
    ignored_user_ids: ['123456789012345678'],
    memory_filter: { context_log: 'all', keyword_blocklist: ['secret'] },
    appearance: { colour_main: '#112233', colour_accent: 'gold', logo: 'https://example.org/l.png', title: 'My bot' },
  }, cookie);
  ok('PUT ok', r.status === 200);
  r = await call(b, 'GET', '/api/settings', undefined, cookie);
  const d1 = r.json;
  ok('round trip: presence', d1.presence.presence_level === 3 && d1.presence.posture['700000000000000103'] === 'high');
  ok('round trip: curfew', d1.curfew.enabled && d1.curfew.start === '22:30' && d1.curfew.end === '07:15');
  ok('round trip: away', d1.away.active && d1.away.reason === 'at the shops' && d1.away.until === '2026-10-14T12:00:00.000Z' && d1.away.reason_shareable === false);
  ok('round trip: focus, mute, memory, appearance', d1.focus.active === true && d1.ignored_user_ids[0] === '123456789012345678' && d1.memory_filter.context_log === 'all' && d1.memory_filter.keyword_blocklist[0] === 'secret' && d1.appearance.title === 'My bot');
  const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  ok('written through the store to the file', onDisk.curfew.start === '22:30' && onDisk.scene.active === true && onDisk.scene.raised_by === 'dashboard' && onDisk.away.set_at);
  const cfgRes = await (await store.getPresenceConfig()).json() as any;
  ok('engine reads the same values back', cfgRes.discord.presence_level === 3 && cfgRes.discord.scene.active === true);
  r = await call(b, 'PUT', '/api/settings', { focus: { active: false } }, cookie);
  ok('lowering focus works and keeps other values', r.status === 200 && r.json.focus.active === false && r.json.curfew.start === '22:30');
  ok('lowered scene still parses as inactive', ((await (await store.getPresenceConfig()).json()) as any).discord.scene.active === false);

  // --- one ladder: the big dial, a server and a channel each take a step ---
  r = await call(b, 'PUT', '/api/settings', { presence: { step: 'chatty', posture: { '700000000000000103': 'reply_only', '700000000000000104': 'silent' } }, servers: { '800000000000000011': { step: 'sociable' } } }, cookie);
  ok('step: PUT ok', r.status === 200 && r.json.presence.step === 'chatty' && r.json.servers['800000000000000011'].step === 'sociable');
  const stepCfg = await (await store.getPresenceConfig()).json() as any;
  ok('step: the engine reads the step, the channel steps and the server step back', stepCfg.discord.step === 'chatty' && stepCfg.discord.posture['700000000000000104'] === 'silent' && stepCfg.discord.servers['800000000000000011'].step === 'sociable');
  r = await call(b, 'PUT', '/api/settings', { servers: { '800000000000000011': { step: null } } }, cookie);
  ok('step: a server can go back to "same as House" (null)', r.status === 200 && r.json.servers['800000000000000011'].step === null);
  r = await call(b, 'PUT', '/api/settings', { presence: { presence_level: 1 } }, cookie);
  ok('step: an old client setting only the 0-4 dial moves the step with it', r.status === 200 && r.json.presence.step === 'reserved');
  r = await call(b, 'PUT', '/api/settings', { presence: { posture: { '700000000000000103': 'high' } } }, cookie);
  ok('step: an old posture word is still a valid save', r.status === 200);
  for (const bad of [{ presence: { step: 'gentle' } }, { presence: { step: 2 } }, { servers: { '800000000000000011': { step: 'loud' } } }]) {
    const x = await call(b, 'PUT', '/api/settings', bad, cookie);
    ok(`step: refuses ${JSON.stringify(bad)}`, x.status === 400);
  }

  // --- validation ---
  const rejects = async (name: string, body: unknown) => {
    const x = await call(b, 'PUT', '/api/settings', body, cookie);
    ok(`reject: ${name}`, x.status === 400 && typeof x.json.error === 'string');
  };
  await rejects('unknown top-level key', { nope: 1 });
  await rejects('unknown nested key', { curfew: { enabled: true, colour: 'red' } });
  await rejects('bad time', { curfew: { start: '25:00' } });
  await rejects('bad time shape', { curfew: { end: '7pm' } });
  await rejects('bad user id', { ignored_user_ids: ['abc'] });
  await rejects('short user id', { ignored_user_ids: ['12345'] });
  await rejects('bad channel id', { presence: { posture: { abc: 'high' } } });
  await rejects('bad posture', { presence: { posture: { '700000000000000103': 'loud' } } });
  await rejects('level out of range', { presence: { presence_level: 9 } });
  await rejects('list over 500', { memory_filter: { keyword_blocklist: Array.from({ length: 501 }, (_, i) => `k${i}`) } });
  await rejects('string over 2000', { away: { reason: 'x'.repeat(2001) } });
  await rejects('javascript logo', { appearance: { logo: 'javascript:alert(1)' } });
  await rejects('css injection colour', { appearance: { colour_main: 'red;} body{display:none' } });
  await rejects('not an object', [1, 2]);
  ok('bad PUT left settings untouched', (await call(b, 'GET', '/api/settings', undefined, cookie)).json.curfew.start === '22:30');

  // --- context logs ---
  r = await call(b, 'GET', '/api/context-logs', undefined, cookie);
  ok('context logs with cookie: 200, newest first', r.status === 200 && r.json.rows.length === 6 && r.json.rows[0].reply === 'reply n' && r.json.rows[0].time === '2026-10-14T09:00:00.000Z' && r.json.rows[0].details.model === 'y' && r.json.rows[1].reply === 'reply 4' && r.json.rows[5].reply === 'reply 0');
  ok('context log row shape + details', r.json.rows[1].channel === 'chan-4' && r.json.rows[1].author === 'Bot' && r.json.rows[1].details.model === 'x' && r.json.rows[2].details === null);
  r = await call(b, 'GET', '/api/context-logs?limit=2', undefined, cookie);
  ok('limit honoured', r.json.rows.length === 2 && r.json.rows[1].reply === 'reply 4');
  r = await call(b, 'GET', '/api/context-logs');
  ok('context logs without cookie: 401', r.status === 401);

  // --- login rate limit (fresh server so the counter starts at zero) ---
  const srv2 = await serve();
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await call(srv2.base, 'POST', '/api/login', { password: 'wrong' })).status);
  ok('first 10 attempts answered, 11th is 429', codes.slice(0, 10).every((c) => c === 401) && codes[10] === 429);
  nowMs += 61_000;
  ok('window resets after a minute', (await call(srv2.base, 'POST', '/api/login', { password: 'hunter2' })).status === 200);
  srv2.close();

  // --- memory sanctum -> 501 ---
  const srv3 = await serve({ plugs: { model: 'sanctum', settings: 'local', memory: 'sanctum' } });
  const c3 = await loginCookie(srv3.base);
  r = await call(srv3.base, 'GET', '/api/context-logs', undefined, c3);
  ok("memory 'sanctum': context logs 501", r.status === 501 && /Sanctum/.test(r.json.error));
  r = await call(srv3.base, 'GET', '/api/settings', undefined, c3);
  ok("memory 'sanctum': settings tell the page not to fetch logs", r.json.can_read_context_logs === false);
  srv3.close();

  // --- a store that cannot hold the document -> 501 ---
  const bare = { ...Object.fromEntries(['getPresenceConfig', 'putPresenceConfig', 'getCurfew', 'getAwayStatus', 'postCurfewEvent', 'postCareInteraction'].map((k) => [k, async () => new Response('{}')])) };
  const srv4 = await serve({ settingsStore: bare });
  const c4 = await loginCookie(srv4.base);
  r = await call(srv4.base, 'GET', '/api/settings', undefined, c4);
  ok('store without a document: 501', r.status === 501);
  srv4.close();

  // --- labels: default vs House override ---
  ok('labels: generic house config has none', Object.keys(GENERIC_DEFAULTS.labels).length === 0);
  const houseCfg = loadHouseConfig({ HOUSE_CONFIG_PATH: join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'test-house.json') } as any);
  ok('labels: House file overrides exactly quiet_hours and focus', JSON.stringify(houseCfg.labels) === JSON.stringify({ quiet_hours: 'curfew', focus: 'scene flag' }));
  const generic = resolveLabels({}, { ...DEFAULT_LABELS });
  const house = resolveLabels(houseCfg.labels, { ...DEFAULT_LABELS });
  ok('labels: default names', JSON.stringify(generic) === JSON.stringify(DEFAULT_LABELS));
  ok('labels: House sees curfew / scene flag, the rest default', house.quiet_hours === 'curfew' && house.focus === 'scene flag' && house.presence === 'Presence' && house.away === 'Away' && house.mute === 'Mute' && house.memory_filter === 'Memory filter');
  ok('labels: a name the user edited wins over the House', resolveLabels(houseCfg.labels, { ...DEFAULT_LABELS, quiet_hours: 'Night' }).quiet_hours === 'Night');
  const srv5 = await serve({ houseLabels: houseCfg.labels });
  const c5 = await loginCookie(srv5.base);
  r = await call(srv5.base, 'GET', '/api/settings', undefined, c5);
  ok('labels: served to the page with the House override', r.json.labels.quiet_hours === 'curfew' && r.json.labels.focus === 'scene flag' && r.json.labels.mute === 'Mute');
  r = await call(srv5.base, 'PUT', '/api/settings', { labels: { away: 'Out' } }, c5);
  ok('labels: editable through PUT', r.status === 200 && r.json.labels.away === 'Out' && r.json.labels.quiet_hours === 'curfew');
  r = await call(srv5.base, 'PUT', '/api/settings', { labels: { bogus: 'x' } }, c5);
  ok('labels: unknown label key rejected', r.status === 400);
  srv5.close();

  // lost-update race: a presence-config change landing between the page's read and its save must survive
  {
    const racy = new LocalSettingsStore(join(dir, 'race.json'), () => nowMs);
    const slow = racy.updateDocument((cur) => { const d = JSON.parse(JSON.stringify(cur)); d.curfew.start = '22:30'; return d; });
    const other = racy.putPresenceConfig({ presence_level: 4, posture: { '123456789012345678': 'full' } });
    await Promise.all([slow, other]);
    const after = await racy.getDocument();
    ok('atomic save keeps concurrent presence change', after.presence.presence_level === 4 && after.presence.posture['123456789012345678'] === 'full');
    ok('atomic save applies its own change', after.curfew.start === '22:30');
    let threw = false;
    try { await racy.updateDocument(() => { throw new Error('nope'); }); } catch { threw = true; }
    ok('throwing derive writes nothing', threw && (await racy.getDocument()).curfew.start === '22:30');
  }

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
