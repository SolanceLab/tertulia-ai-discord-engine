// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Run: npx tsx src/provider-socket.test.ts
 * The hooks file as the provider socket: TERTULIA_HOOKS_PATH (set but missing is a loud error), the provider
 * functions it may export, the timezone and judge-intro settings, and the richer member list.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'provider-socket-'));
// A config with a judge-intro override and a zone, read before anything loads the config.
writeFileSync(join(dir, 'config.json'), JSON.stringify({ timezone: 'Europe/Lisbon', identity: { text: { 'judge.intro': 'You decide whether to speak in the reading room.' } } }));
process.env.CONFIG_PATH = join(dir, 'config.json');

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

(async () => {
  const { loadHooks, hooksPathFromEnv, getHooks, setHooks, NOOP_HOOKS } = await import('./hooks.js');
  const { parseDeploymentConfig, deployConfig, GENERIC_DEFAULTS } = await import('./config/deployment-config.js');
  const { isValidTimezone, resolveTimezone, zonedHHMM, zoneOffsetMs, zonedWallToMs } = await import('./config/timezone.js');
  const { validateDocument } = await import('./dashboard/routes.js');
  const { LocalSettingsStore } = await import('./seams/local-settings-store.js');
  const { say } = await import('./config/identity.js');
  const { DEFAULT_TEXT } = await import('./config/identity-defaults.js');
  const { listMembers } = await import('./discord/admin.js');

  // ── TERTULIA_HOOKS_PATH ──
  ok('no env var: no path', hooksPathFromEnv({} as any) === null && hooksPathFromEnv({ TERTULIA_HOOKS_PATH: '  ' } as any) === null);
  ok('env var: an absolute path', hooksPathFromEnv({ TERTULIA_HOOKS_PATH: join(dir, 'h.mjs') } as any) === join(dir, 'h.mjs'));
  let err = '';
  try { await loadHooks([], undefined, join(dir, 'missing.mjs')); } catch (e: any) { err = e.message; }
  ok('path set but the file is missing: a loud startup error naming the path', /TERTULIA_HOOKS_PATH/.test(err) && err.includes(join(dir, 'missing.mjs')));
  writeFileSync(join(dir, 'broken.mjs'), `throw new Error('boom');`);
  err = ''; try { await loadHooks([], undefined, join(dir, 'broken.mjs')); } catch (e: any) { err = e.message; }
  ok('path set but the file throws on import: a loud startup error', /TERTULIA_HOOKS_PATH/.test(err) && /boom/.test(err));
  writeFileSync(join(dir, 'badshape.mjs'), `export const hooks = { modelProvider: 'nope' };`);
  err = ''; try { await loadHooks([], undefined, join(dir, 'badshape.mjs')); } catch (e: any) { err = e.message; }
  ok('path set but a provider member is not a function: a loud startup error', /TERTULIA_HOOKS_PATH/.test(err));
  writeFileSync(join(dir, 'good.mjs'), `export const hooks = { modelProvider: () => ({}), settingsStore: () => ({}), contextSink: () => ({}), auditSink: () => ({}), authorNotes: () => ({}), onChannelReply: () => false };`);
  const loaded = await loadHooks([], undefined, join(dir, 'good.mjs'));
  ok('path set and good: every socket function is on the hooks', ['modelProvider', 'settingsStore', 'contextSink', 'auditSink', 'authorNotes', 'onChannelReply'].every((k) => typeof (loaded as any)[k] === 'function') && getHooks() === loaded);
  setHooks(null);
  const none = await loadHooks([join(dir, 'nope.mjs')], undefined, null);
  ok('no path and no file next to the engine: no-op hooks, no error', none === NOOP_HOOKS);

  // ── timezone ──
  ok('timezone: the config file value is read', deployConfig.timezone === 'Europe/Lisbon');
  ok('timezone: the generic default is UTC', GENERIC_DEFAULTS.timezone === 'UTC' && parseDeploymentConfig({}).timezone === 'UTC');
  ok('timezone: a name Intl does not know falls back to UTC', parseDeploymentConfig({ timezone: 'Not/AZone' }).timezone === 'UTC');
  ok('timezone: validity', isValidTimezone('Asia/Tokyo') && isValidTimezone('UTC') && !isValidTimezone('Mars/Base') && !isValidTimezone('') && resolveTimezone(undefined) === 'UTC');
  ok('timezone: the wall clock in a zone', zonedHHMM(Date.UTC(2026, 6, 11, 14, 30), 'Asia/Tokyo') === '23:30' && zonedHHMM(Date.UTC(2026, 6, 11, 14, 30), 'UTC') === '14:30');
  ok('timezone: offsets follow daylight saving', zoneOffsetMs(Date.UTC(2026, 6, 1), 'America/New_York') === -4 * 3600_000 && zoneOffsetMs(Date.UTC(2026, 0, 1), 'America/New_York') === -5 * 3600_000);
  ok('timezone: wall time back to an instant', zonedWallToMs(2026, 7, 11, 23, 0, 'Asia/Tokyo') === Date.UTC(2026, 6, 11, 14, 0) && zonedWallToMs(2026, 7, 0, 23, 0, 'UTC') === Date.UTC(2026, 5, 30, 23, 0));
  const store = new LocalSettingsStore(join(dir, 's.json'));
  const doc0 = await store.getDocument!();
  ok('timezone: the settings document starts on the config value', doc0.timezone === 'Europe/Lisbon');
  const doc1 = validateDocument({ timezone: 'Asia/Tokyo' }, doc0);
  ok('timezone: the page document accepts an IANA name', doc1.timezone === 'Asia/Tokyo');
  let bad = ''; try { validateDocument({ timezone: 'UTC+7' }, doc0); } catch (e: any) { bad = e.message; }
  ok('timezone: the page document refuses anything else', /IANA/.test(bad));
  await store.putDocument!(doc1);
  ok('timezone: the saved setting wins over the config value', (await store.getDocument!()).timezone === 'Asia/Tokyo');

  // ── judge intro ──
  ok('judge intro: the engine\'s default text is neutral', DEFAULT_TEXT['judge.intro'].startsWith('You are deciding whether to SPEAK in a channel of this server'));
  ok('judge intro: a deployment replaces it under identity.text', say('judge.intro') === 'You decide whether to speak in the reading room.');
  const { PresenceEngine } = await import('./presence-engine.js');
  const { DEFAULTS } = await import('./presence-config.js');
  const captured: string[] = [];
  const engine = new PresenceEngine('', '', 'PERSONA', () => 1_760_000_100_000, undefined, undefined, undefined, { get: async () => ({ ...DEFAULTS }) } as any);
  engine.setModelProvider({
    singleModel: true, identity: { engine: 't', model: 't' },
    async complete(_t: any, system: string) { captured.push(system); return { ok: true, text: '{"speak":false,"reason":"x","message":null}', engine: 't', model: 't' }; },
    async prepare() { return null; }, async postComplete() { throw new Error('unused'); },
  } as any);
  await engine.judge('700000000000000103', 'room', [{ id: '1', authorId: '700000000000000001', authorName: 'Mara', content: 'hi', isFromOwner: false, isFromMe: false, timestampMs: 1_760_000_000_000 }], undefined, [], 'balanced');
  ok('judge intro: the judge prompt opens with the configured sentence, not the default', captured[0]?.includes('## Ambient Discord presence\n\nYou decide whether to speak in the reading room.') === true && !captured[0]?.includes('deciding whether to SPEAK'));

  // ── the member list ──
  const fakeMember = (over: any) => ({ id: '1', nickname: null, user: { tag: 'mara#0', username: 'mara', globalName: null, bot: false }, roles: { cache: { map: (f: any) => [{ name: 'Guest' }].map(f) } }, ...over });
  const fakeClient: any = { guilds: { fetch: async () => ({ members: { fetch: async () => new Map([
    ['1', fakeMember({ id: '1', nickname: 'Mari', user: { tag: 'mara#0', username: 'mara', globalName: 'Mara L', bot: false } })],
    ['2', fakeMember({ id: '2', user: { tag: 'helper#0', username: 'helper', globalName: null, bot: true } })],
  ]) } }) } };
  const members = (await listMembers(fakeClient, 'g1', 10))!;
  ok('list_members: id, tag, username, global display name, server nickname, bot flag, roles', members.length === 2
    && members[0].id === '1' && members[0].tag === 'mara#0' && members[0].username === 'mara' && members[0].globalName === 'Mara L' && members[0].nickname === 'Mari' && members[0].isBot === false && members[0].roles.join() === 'Guest'
    && members[1].globalName === null && members[1].nickname === null && members[1].isBot === true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
