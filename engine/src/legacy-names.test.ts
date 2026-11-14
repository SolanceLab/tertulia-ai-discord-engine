// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * The earlier names still work (legacy-names.ts). For every renamed env var, file, config key, stored
 * setting, plug value, route and CLI flag: set only the earlier name -> the new reading is the same and exactly one
 * warning names the new one; set both and differ -> the new name wins and the warning says so.
 * Run: npx tsx src/legacy-names.test.ts
 */
import './test-env.js';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  ENV_ALIASES, normalizeLegacy, legacyWarningCount, normalizeCliFlag, configFileCandidates, normalizeAsideTo, noteConfigFile,
  REMOVED_PLUG_VALUES, hooksFileCandidates, bundleSources, resetLegacyWarnings, isLegacyLayerPath, rewriteLegacyRoute, noteHooksFile, readEnv, normalizeContextLog,
} from './config/legacy-names.js';
import { loadDeploymentConfig, parseDeploymentConfig } from './config/deployment-config.js';
import { toGatewayWire } from './fixtures/gateway-providers.js';
import { parseIdentity } from './config/identity-defaults.js';
import { normalizeServerContextLog, parseServerEntry } from './presence/servers.js';
import { parseConfig } from './presence-config.js';
import { normalizeSettings, LocalSettingsStore } from './seams/local-settings-store.js';
import { asideTargetsAgent } from './aside.js';
import { validateDocument } from './dashboard/routes.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Capture the warnings the module gives (it warns through console.warn).
const warnings: string[] = [];
const realWarn = console.warn;
console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
function fresh(): void { resetLegacyWarnings(); warnings.length = 0; }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function run() {
  // ── env vars: one test per alias ──
  for (const [fresh_, old] of Object.entries(ENV_ALIASES)) {
    fresh();
    ok(`env ${fresh_}: only the earlier name set -> its value is used`, readEnv(fresh_, { [old]: 'old-value' }) === 'old-value');
    ok(`env ${fresh_}: ... and exactly one warning names the new one`, warnings.length === 1 && warnings[0].includes(fresh_) && warnings[0].includes(old));
    readEnv(fresh_, { [old]: 'old-value' });
    ok(`env ${fresh_}: ... a second read does not warn again`, warnings.length === 1);
    fresh();
    ok(`env ${fresh_}: both set and different -> the new one wins`, readEnv(fresh_, { [fresh_]: 'new-value', [old]: 'old-value' }) === 'new-value');
    ok(`env ${fresh_}: ... and the warning says both were set`, warnings.length === 1 && /both are set and differ/.test(warnings[0]));
    fresh();
    ok(`env ${fresh_}: only the new name set -> no warning`, readEnv(fresh_, { [fresh_]: 'v' }) === 'v' && warnings.length === 0);
  }

  // ── config file: the earlier env var and file names load ──
  {
    fresh();
    const dir = mkdtempSync(join(tmpdir(), 'legacy-names-'));
    const file = join(dir, 'whatever.json');
    writeFileSync(file, JSON.stringify({ hosServerId: '700000000000000001' }));
    const cfg = loadDeploymentConfig({ HOUSE_CONFIG_PATH: file } as any);
    ok('config path: the earlier env var HOUSE_CONFIG_PATH loads the file', cfg.homeServerId === '700000000000000001');
    ok('config path: ... with one warning naming CONFIG_PATH', warnings.some((w) => w.includes('CONFIG_PATH')) && warnings.filter((w) => w.includes('CONFIG_PATH')).length === 1);
    fresh();
    const other = join(dir, 'other.json');
    writeFileSync(other, JSON.stringify({ homeServerId: '700000000000000009' }));
    ok('config path: both env vars set -> CONFIG_PATH wins', loadDeploymentConfig({ CONFIG_PATH: other, HOUSE_CONFIG_PATH: file } as any).homeServerId === '700000000000000009' && warnings.some((w) => /differ/.test(w)));
    fresh();
    const c = configFileCandidates('/b/engine', '/b/engine/dist', join);
    ok('config file: the new location is tried before the earlier one', c[0].endsWith('deployment/discord.config.json') && c[1].endsWith('house/discord.house.json') && c[2].endsWith('dist/discord.config.json') && c[3].endsWith('dist/discord.house.json'));
    noteConfigFile('/x/discord.house.json'); noteConfigFile('/x/discord.house.json');
    ok('config file: the earlier file name warns once', warnings.length === 1 && warnings[0].includes('discord.config.json'));
    fresh(); noteConfigFile('/x/discord.config.json');
    ok('config file: the new name does not warn', warnings.length === 0);
    ok('build: the earlier layer folder is a legacy path, the new one is not', isLegacyLayerPath('/r/house/hooks.ts') && isLegacyLayerPath('/r/house/discord.house.json') && !isLegacyLayerPath('/r/deployment/hooks.ts'));
    ok('build: the sources list the new location first', bundleSources('/b/engine', join).config[0].includes('deployment') && bundleSources('/b/engine', join).hooks[1].includes('house'));
  }

  // ── hooks file ──
  {
    fresh();
    const dist = hooksFileCandidates('/b/dist', false, join);
    const src = hooksFileCandidates('/b/src', true, join);
    ok('hooks file: the new name is first, the earlier one second', dist.length === 2 && dist[0].endsWith('hooks.js') && dist[1].endsWith('house.hooks.js'));
    ok('hooks file: from source, the layer folder is tried (new first)', src.length === 4 && src[2].endsWith('deployment/hooks.ts') && src[3].endsWith('house/hooks.ts'));
    noteHooksFile('/b/dist/house.hooks.js'); noteHooksFile('/b/dist/house.hooks.js');
    ok('hooks file: the earlier name warns once', warnings.length === 1 && warnings[0].includes('hooks.js'));
  }

  // ── config keys: the earlier shape reads the same as the new one; both set -> the new wins ──
  {
    const oldShape = {
      hosServerId: '700000000000000001', intimateStickerIds: ['700000000000000201'], curfewStickers: { '1': 'a', '2': 'b', '3': 'c' },
      contextLogDefault: 'house_channels',
      identity: {
        study_command: 'summon', intimate_tells: 'darling',
        text: { 'curfew.tone.1': 'late', 'scene.1': 'raised' },
        aside_choices: [{ name: 'Model', value: 'sanctum' }, { name: 'Agent', value: 'study' }],
      },
      servers: { '700000000000000001': { context_log: 'house_channels', rules: { curfew: false, flag: true } } },
    };
    const newShape = {
      homeServerId: '700000000000000001', ownerOnlyStickerIds: ['700000000000000201'], quietHoursStickers: { '1': 'a', '2': 'b', '3': 'c' },
      contextLogDefault: 'this_server',
      identity: {
        agent_command: 'summon', private_tells: 'darling',
        text: { 'quiet.tone.1': 'late', 'focus.1': 'raised' },
        aside_choices: [{ name: 'Model', value: 'model' }, { name: 'Agent', value: 'agent' }],
      },
      servers: { '700000000000000001': { context_log: 'this_server', rules: { quiet_hours: false, focus: true } } },
    };
    fresh();
    const a = parseDeploymentConfig(oldShape), b = parseDeploymentConfig(newShape);
    ok('config keys: the earlier shape parses exactly like the new one', same(a, b));
    ok('config key hosServerId -> homeServerId', a.homeServerId === '700000000000000001');
    ok('config key intimateStickerIds -> ownerOnlyStickerIds', same(a.ownerOnlyStickerIds, ['700000000000000201']));
    ok('config key curfewStickers -> quietHoursStickers', a.quietHoursStickers['2'] === 'b');
    ok('plug values sanctum / solance-api are not read as custom any more: they are listed as removed', same([...REMOVED_PLUG_VALUES], ['sanctum', 'solance-api']) && parseDeploymentConfig({ plugs: { model: 'sanctum', settings: 'solance-api' } }).plugs.removed?.length === 2);
    ok('contextLogDefault house_channels -> this_server', a.contextLogDefault === 'this_server');
    ok('identity key study_command -> agent_command', a.identity.agent_command === 'summon');
    ok('identity key intimate_tells -> private_tells', a.identity.private_tells === 'darling');
    ok('identity text keys curfew.* and scene.* -> quiet.* and focus.*', a.identity.text['quiet.tone.1'] === 'late' && a.identity.text['focus.1'] === 'raised' && !('curfew.tone.1' in a.identity.text));
    ok('aside choice values sanctum / study -> model / agent', same(a.identity.aside_choices.map((c) => c.value), ['model', 'agent']));
    ok('per-server rules curfew / flag -> quiet_hours / focus', same(a.servers['700000000000000001'].rules, { quiet_hours: false, focus: true }));
    ok('per-server context_log house_channels -> this_server', a.servers['700000000000000001'].context_log === 'this_server');
    ok('each earlier config name warned once, naming the new one', warnings.length > 10 && new Set(warnings).size === warnings.length);

    fresh();
    const both = parseDeploymentConfig({ hosServerId: '700000000000000001', homeServerId: '700000000000000009', curfewStickers: { '1': 'x' }, quietHoursStickers: { '1': 'y' } });
    ok('config keys: both set and different -> the new one wins', both.homeServerId === '700000000000000009' && both.quietHoursStickers['1'] === 'y');
    ok('config keys: ... and the warning says so', warnings.some((w) => /both are set and differ/.test(w) && w.includes('homeServerId')));

    // identity parsed on its own (a caller that has only the identity block)
    fresh();
    const id = parseIdentity({ study_command: 'summon', intimate_tells: 'x', aside_choices: [{ name: 'A', value: 'study' }] });
    ok('parseIdentity on its own reads the earlier keys', id.agent_command === 'summon' && id.private_tells === 'x' && id.aside_choices[0].value === 'agent');
    ok('context-log and aside helpers pass other values through', normalizeContextLog('off') === 'off' && normalizeAsideTo('model') === 'model' && normalizeAsideTo(undefined) === undefined);
  }

  // ── aside values ──
  {
    fresh();
    ok('aside to: study is the agent, sanctum is the model, agent stays the agent', asideTargetsAgent('study') && !asideTargetsAgent('sanctum') && asideTargetsAgent('agent') && !asideTargetsAgent('model') && !asideTargetsAgent(null));
  }

  // ── stored settings: read under the earlier keys, written under the new ones ──
  {
    fresh();
    const stored = {
      presence: { curfew_stickers: { '1': '700000000000000301', '2': null, '3': null } },
      curfew: { enabled: true, start: '22:00', end: '05:00' },
      curfew_events: [{ at: '2026-01-01T00:00:00.000Z', level: 2, channel_id: 'c', message: 'm' }],
      scene: { active: true, raised_by: 'wing', raised_at: '2026-11-10T10:00:00.000Z', until: '2999-01-01T00:00:00.000Z', lowered_at: null },
      scene_sighting: { raised_at: '2026-11-10T10:00:00.000Z', caught: true },
      study: { active: false },
      memory_filter: { context_log: 'house_channels', keyword_blocklist: [] },
      servers: { '700000000000000001': { rules: { curfew: false, flag: true } } },
    };
    const s = normalizeSettings(stored);
    ok('stored curfew -> quiet_hours', s.quiet_hours.enabled === true && s.quiet_hours.start === '22:00' && s.quiet_hours.end === '05:00');
    ok('stored curfew_events -> quiet_hours_events', s.quiet_hours_events.length === 1 && s.quiet_hours_events[0].level === 2);
    ok('stored presence.curfew_stickers -> quiet_hours_stickers', s.presence.quiet_hours_stickers['1'] === '700000000000000301');
    ok('stored scene -> focus', s.focus.active === true && s.focus.raised_by === 'wing');
    ok('stored scene_sighting -> focus_sighting', (s.focus_sighting as any)?.caught === true);
    ok('stored study -> agent_window', typeof s.agent_window === 'object' && (s.agent_window as any).active === false);
    ok('stored context_log house_channels -> this_server', s.memory_filter.context_log === 'this_server');
    ok('stored per-server rules curfew / flag -> quiet_hours / focus', same(s.servers['700000000000000001'].rules, { quiet_hours: false, focus: true }));
    ok('stored keys: new and earlier set together -> the new one wins', normalizeSettings({ curfew: { enabled: true, start: '21:00', end: '05:00' }, quiet_hours: { enabled: false, start: '23:30', end: '06:30' } }).quiet_hours.start === '23:30');

    // written under the new keys on the next write
    const dir = mkdtempSync(join(tmpdir(), 'legacy-store-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify(stored));
    const store = new LocalSettingsStore(path, () => Date.parse('2026-11-14T12:00:00.000Z'));
    const doc = await store.getDocument!();
    ok('local file: an old-keyed file loads through the store', doc.quiet_hours.enabled === true && doc.focus.active === true);
    await store.putDocument!({ ...doc, quiet_hours: { ...doc.quiet_hours, start: '21:15' } });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    ok('local file: the next write uses the new keys only', written.quiet_hours?.start === '21:15' && !('curfew' in written) && !('scene' in written) && !('study' in written) && !('curfew_events' in written) && 'agent_window' in written);

    // presence config (the hosted API's answer) and the server seed
    fresh();
    const pc = parseConfig({ curfew_stickers: { '1': '700000000000000302' }, scene: { active: true, raised_by: 'wing', raised_at: '2026-11-10T10:00:00.000Z', until: '2999-01-01T00:00:00.000Z', lowered_at: null }, study: { active: false }, context_log: 'house_channels' });
    ok('presence config: hosted answer keys curfew_stickers / scene / study are read', pc.quiet_hours_stickers['1'] === '700000000000000302' && pc.focus.active === true && pc.agent_window.active === false && pc.context_log === 'this_server');
    ok('server entry: earlier rules and context_log are read', same(parseServerEntry({ rules: { curfew: true, flag: false }, context_log: 'house_channels' }), { context_log: 'this_server', rules: { quiet_hours: true, focus: false } }) && normalizeServerContextLog('house_channels') === 'this_server');

    // the test gateway fixture still speaks the earlier names on the wire
    ok('wire: new keys go out under the names the gateway fixture knows', same(toGatewayWire({ focus_sighting: { a: 1 }, agent_window: { b: 2 }, quiet_hours: { c: 3 } }), { scene_sighting: { a: 1 }, study: { b: 2 }, curfew: { c: 3 } }));

    // a page that still sends the earlier keys
    fresh();
    const current = (await store.getDocument!());
    const merged = validateDocument({ curfew: { enabled: true, start: '20:00', end: '04:00' } }, current);
    ok('settings request: an older page sending curfew is read as quiet_hours', merged.quiet_hours.start === '20:00');
  }

  // ── routes ──
  {
    fresh();
    ok('route: /api/aside/study/<x> is rewritten to /api/aside/agent/<x>', rewriteLegacyRoute('/api/aside/study/pending?session_id=s') === '/api/aside/agent/pending?session_id=s');
    ok('route: ... with one warning', warnings.length === 1 && warnings[0].includes('/api/aside/agent'));
    ok('route: the new route and others are left alone', rewriteLegacyRoute('/api/aside/agent/pending') === '/api/aside/agent/pending' && rewriteLegacyRoute('/api/send-dm') === '/api/send-dm');

    // end to end: the server answers on both
    const { createHttpServer } = await import('./http-server.js');
    const released: Array<string | undefined> = [];
    const fake: any = {
      agentPresence: { touch() {}, lastSeen: () => null },
      agentAsides: { pending: () => [], listener: { release: (sid?: string) => { released.push(sid); return true; }, current: () => null } },
    };
    const srv: any = createHttpServer(fake, {} as any, 'bot-secret', 0);
    await new Promise((res) => (srv.listening ? res(null) : srv.once('listening', res)));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const call = async (path: string, method = 'GET', body?: unknown) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer bot-secret' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    };
    const n = await call('/api/aside/agent/pending');
    const o = await call('/api/aside/study/pending');
    ok('route: GET /api/aside/agent/pending answers', n.status === 200 && Array.isArray(n.json?.pending));
    ok('route: GET /api/aside/study/pending still answers the same', o.status === 200 && same(o.json, n.json));
    const o2 = await call('/api/aside/study/unlisten', 'POST', { session_id: 'sess' });
    ok('route: POST /api/aside/study/unlisten still reaches the handler', o2.status === 200 && released[0] === 'sess');
    srv.close();
  }

  // ── command-line flag ──
  {
    fresh();
    ok('flag: --study is read as --agent, with one warning', normalizeCliFlag('--study') === '--agent' && warnings.length === 1 && normalizeCliFlag('--followup') === '--followup');
  }

  // ── both names present: the new name wins whatever the property order ──
  {
    const pairs: Array<[string, string]> = [
      ['curfew', 'quiet_hours'], ['curfew_events', 'quiet_hours_events'], ['curfew_stickers', 'quiet_hours_stickers'], ['curfewStickers', 'quietHoursStickers'],
      ['scene', 'focus'], ['scene_sighting', 'focus_sighting'], ['scene_sightings', 'focus_sightings'], ['study', 'agent_window'], ['study_command', 'agent_command'],
      ['intimate_tells', 'private_tells'], ['intimateStickerIds', 'ownerOnlyStickerIds'], ['hosServerId', 'homeServerId'],
    ];
    for (const [o, n] of pairs) {
      fresh();
      const a: any = normalizeLegacy({ [n]: 'new', [o]: 'old' });
      const b: any = normalizeLegacy({ [o]: 'old', [n]: 'new' });
      ok(`collision key: ${n} beats ${o} (modern first and legacy first), one warning`, a[n] === 'new' && !(o in a) && b[n] === 'new' && !(o in b) && warnings.length === 1, JSON.stringify([a, b, warnings.length]));
    }
    for (const [o, n] of [['curfew', 'quiet_hours'], ['flag', 'focus']] as Array<[string, string]>) {
      fresh();
      const a: any = normalizeLegacy({ servers: { s: { rules: { [n]: true, [o]: false } } } });
      const b: any = normalizeLegacy({ servers: { s: { rules: { [o]: false, [n]: true } } } });
      ok(`collision rules: ${n} beats ${o} (both orders)`, same(a.servers.s.rules, { [n]: true }) && same(b.servers.s.rules, { [n]: true }));
    }
    for (const [o, n] of [['curfew_description', 'quiet_hours_description'], ['house_channels_option', 'this_server_option'], ['server_rule_curfew', 'server_rule_quiet_hours'], ['server_rule_flag', 'server_rule_focus']]) {
      fresh();
      const a: any = normalizeLegacy({ labels: { [n]: 'new', [o]: 'old' } });
      const b: any = normalizeLegacy({ labels: { [o]: 'old', [n]: 'new' } });
      ok(`collision label: ${n} beats ${o} (both orders)`, a.labels[n] === 'new' && b.labels[n] === 'new' && !(o in a.labels) && !(o in b.labels));
    }
    for (const [o, n] of [['curfew.tone.1', 'quiet.tone.1'], ['scene.2', 'focus.2']]) {
      fresh();
      const a: any = normalizeLegacy({ text: { [n]: 'new', [o]: 'old' } });
      const b: any = normalizeLegacy({ text: { [o]: 'old', [n]: 'new' } });
      ok(`collision text: ${n} beats ${o} (both orders)`, a.text[n] === 'new' && b.text[n] === 'new' && !(o in a.text) && !(o in b.text));
    }
    for (const [n, o] of Object.entries(ENV_ALIASES)) {
      fresh();
      const e1 = { [n]: 'new', [o]: 'old' } as NodeJS.ProcessEnv;
      const e2 = { [o]: 'old', [n]: 'new' } as NodeJS.ProcessEnv;
      ok(`collision env: ${n} beats ${o} (both orders)`, readEnv(n, e1) === 'new' && readEnv(n, e2) === 'new');
    }
  }

  console.warn = realWarn;
  ok('the module counts the warnings it gave', typeof legacyWarningCount() === 'number');
}

run().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }).catch((e) => { console.warn = realWarn; console.error(e); process.exit(1); });
