// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/status-tools.test.ts — the custom status line: default, set + persist, limits, shown live, auth. */
import './test-env.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { logger } from './logger.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } }
for (const k of ['info', 'warn', 'error', 'debug'] as const) (logger as any)[k] = () => {};

async function run() {
  const { LocalSettingsStore } = await import('./seams/local-settings-store.js');
  const { readStatus, setStatus, cleanStatus, StatusEditError, STATUS_MAX } = await import('./status-edit.js');
  const { createHttpServer } = await import('./http-server.js');
  const { DiscordClient } = await import('./discord-client.js');
  const { parseIdentity, GENERIC_IDENTITY } = await import('./config/identity-defaults.js');

  const dir = mkdtempSync(join(tmpdir(), 'status-'));
  const path = join(dir, 'settings.json');
  const store = new LocalSettingsStore(path);

  // default, set + persist, empty back to default
  ok('public default is no status', GENERIC_IDENTITY.custom_status === '' && parseIdentity({}).custom_status === '');
  ok('identity reads custom_status', parseIdentity({ custom_status: '  Hello  ' }).custom_status === 'Hello');
  let v = await readStatus(store, 'Default text');
  ok('nothing set: the default shows, flagged', v.text === 'Default text' && v.is_default === true);
  v = await setStatus(store, '  Waiting at the pier  ', 'Default text');
  ok('set trims and reports not default', v.text === 'Waiting at the pier' && v.is_default === false);
  ok('persists across a fresh store on the same file', (await new LocalSettingsStore(path).getCustomStatus()) === 'Waiting at the pier');
  v = await setStatus(store, '', 'Default text');
  ok('empty returns to the default', v.text === 'Default text' && v.is_default && (await store.getCustomStatus()) === null);
  await setStatus(store, 'x', 'D');
  v = await setStatus(store, null, 'D');
  ok('null returns to the default', v.is_default);

  // limits
  ok('line breaks become spaces', cleanStatus('a\nb') === 'a b');
  ok('128 characters accepted', cleanStatus('a'.repeat(STATUS_MAX)) === 'a'.repeat(STATUS_MAX));
  let err: any; try { cleanStatus('a'.repeat(STATUS_MAX + 1)); } catch (e) { err = e; }
  ok('129 characters refused with 400', err instanceof StatusEditError && err.status === 400);
  err = undefined; try { cleanStatus(42); } catch (e) { err = e; }
  ok('non-text refused with 400', err instanceof StatusEditError && err.status === 400);

  // applied live: the callback sees the new effective text; a refused value changes nothing
  const seen: string[] = [];
  await setStatus(store, 'Live one', 'D', (t) => seen.push(t));
  err = undefined; try { await setStatus(store, 'a'.repeat(200), 'D', (t) => seen.push(t)); } catch (e) { err = e; }
  ok('applyLive gets the text; a refused value is not applied or saved', seen.length === 1 && seen[0] === 'Live one' && (await store.getCustomStatus()) === 'Live one');

  // the client shows it at once while online, and the default after a clear
  const dc: any = new DiscordClient('owner-1');
  const shown: any[] = [];
  dc.client = { user: { setPresence: (p: any) => shown.push(p) } };
  dc.setCustomStatus('Before online');
  ok('no presence yet: nothing is pushed', shown.length === 0);
  dc.updatePresence('online');
  ok('online shows the status text', shown.at(-1).activities[0].name === 'Before online');
  dc.setCustomStatus('Changed now');
  ok('changing while online applies at once', shown.at(-1).activities[0].name === 'Changed now');
  dc.updatePresence('invisible');
  const n = shown.length; dc.setCustomStatus('Hidden change');
  ok('while offline: no status shown, nothing pushed', shown.at(-1).activities.length === 0 && shown.length === n);
  dc.setCustomStatus('');
  dc.updatePresence('online');
  ok('empty text shows no status', shown.at(-1).activities.length === 0);
  await store.setCustomStatus('Saved earlier');
  dc.setSettingsStore(store);
  await dc.refreshCustomStatus();
  dc.updatePresence('online');
  ok('a saved status loads at startup', shown.at(-1).activities[0].name === 'Saved earlier');

  // routes: auth, shape, 501 without a settings document
  const fake: any = { setCustomStatus: (t: string) => seen.push(`route:${t}`) };
  const srv: any = createHttpServer(fake, {} as any, 'bot-secret', 0, { settingsStore: store, plugs: { model: 'direct', settings: 'local', memory: 'off' } as any });
  await new Promise((res) => srv.listening ? res(null) : srv.once('listening', res));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = async (p: string, b: unknown = {}, auth = 'bot-secret') => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, body: JSON.stringify(b) });
    return { status: r.status, json: await r.json().catch(() => null) as any };
  };
  ok('status routes need the bot secret', (await post('/api/status-read', {}, 'wrong')).status === 403 && (await post('/api/status-update', { text: 'x' }, 'wrong')).status === 403);
  let r = await post('/api/status-update', { text: 'Groom' });
  ok('status-update saves, answers, and applies live', r.status === 200 && r.json.text === 'Groom' && r.json.is_default === false && seen.at(-1) === 'route:Groom');
  r = await post('/api/status-read');
  ok('status-read returns the saved text', r.status === 200 && r.json.text === 'Groom' && r.json.is_default === false);
  ok('status-update without text is a 400', (await post('/api/status-update', {})).status === 400);
  ok('status-update too long is a 400', (await post('/api/status-update', { text: 'a'.repeat(129) })).status === 400);
  r = await post('/api/status-update', { text: '' });
  ok('empty text goes back to the default', r.status === 200 && r.json.is_default === true);
  srv.close();
  const bare: any = createHttpServer({} as any, {} as any, 'bot-secret', 0);
  await new Promise((res) => bare.listening ? res(null) : bare.once('listening', res));
  ok('no settings document: 501', (await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/api/status-read`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bot-secret' }, body: '{}' })).status === 501);
  bare.close();

}

run().then(() => { console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, (e) => { console.error(e); process.exit(1); });
