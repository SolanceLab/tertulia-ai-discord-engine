// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/context-sink.test.ts
 * The context log's sink seam in the public build: neutral rows, the http sink, the local file, the off default. */
import './test-env.js';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ctx-sink-'));
process.env.HOUSE_CONFIG_PATH = join(dir, 'no-such-house.json'); // generic defaults

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } }

const row = (over: any = {}) => ({
  message_id: '1234567890', channel_id: 'c1', channel_name: 'general', author_id: 'b1', author_name: 'Botty', content: 'hello there',
  timestamp: '2026-10-17T22:40:00+07:00', is_bot: true, guild_id: 'g1', ...over,
});

async function run() {
  const { toNeutralRow } = await import('./seams/neutral-context-row.js');
  const { createHttpContextLogFlush } = await import('./seams/http-context-log.js');
  const { createSeams } = await import('./seams/index.js');
  const { loadHouseConfig, parseHouseConfig } = await import('./config/house-config.js');
  const { ContextCollector } = await import('./context-collector.js');
  const { logger } = await import('./logger.js');

  // --- the neutral row ---
  const n = toNeutralRow(row({ reply_to: '999', context_log: { engine: 'e' } }) as any);
  ok('neutral row: id is the Discord message id, at is ISO 8601 UTC', n.id === '1234567890' && n.at === '2026-10-17T15:40:00.000Z');
  ok('neutral row: fields', n.guild_id === 'g1' && n.channel_id === 'c1' && n.channel_name === 'general' && n.author_id === 'b1' && n.author_name === 'Botty' && n.is_bot === true && n.content === 'hello there' && n.reply_to === '999');
  ok('neutral row: generation context rides as context', (n.context as any).engine === 'e');
  const bare = toNeutralRow(row() as any);
  ok('neutral row: reply_to null and no context key when absent', bare.reply_to === null && !('context' in bare) && !('message_id' in bare) && !('timestamp' in bare));
  ok('neutral row: DM has guild_id null', toNeutralRow(row({ guild_id: null }) as any).guild_id === null);

  // --- the http sink ---
  let threw = ''; try { createHttpContextLogFlush('http://logs.example.org/in', 'k'); } catch (e: any) { threw = e.message; }
  ok('http sink: https only', /must be https/.test(threw));
  threw = ''; try { createHttpContextLogFlush('not a url', 'k'); } catch (e: any) { threw = e.message; }
  ok('http sink: a bad URL is refused by name, without echoing it', /CONTEXT_LOG_URL/.test(threw) && !/not a url/.test(threw));
  let seen: any = null;
  const good = createHttpContextLogFlush('https://logs.example.org/in', 'SECRETKEY', () => [], (async (u: any, init: any) => { seen = { u, init }; return new Response('{}', { status: 200 }); }) as any);
  const res = await good([bare]);
  ok('http sink: POST JSON {rows} with Bearer', seen.u === 'https://logs.example.org/in' && seen.init.method === 'POST' && seen.init.headers.authorization === 'Bearer SECRETKEY' && JSON.parse(seen.init.body).rows[0].id === '1234567890' && res.inserted === 1);
  seen = null;
  await createHttpContextLogFlush('https://logs.example.org/in', '', () => [], (async (u: any, init: any) => { seen = init; return new Response('{}'); }) as any)([bare]);
  ok('http sink: no key, no authorization header', !('authorization' in seen.headers));

  const logged: string[] = [];
  const origInfo = logger.info.bind(logger), origErr = logger.error.bind(logger);
  (logger as any).info = (...a: any[]) => { logged.push(JSON.stringify(a)); };
  (logger as any).error = (...a: any[]) => { logged.push(JSON.stringify(a)); };
  try {
    const bad = createHttpContextLogFlush('https://logs.example.org/in', 'SECRETKEY', () => [], (async () => new Response('no', { status: 500 })) as any);
    const r500 = await bad([bare]);
    const boom = createHttpContextLogFlush('https://logs.example.org/in', 'SECRETKEY', () => [], (async () => { throw new Error('connect https://logs.example.org/in SECRETKEY'); }) as any);
    const rBoom = await boom([bare]);
    ok('http sink: an error answer or a throw drops the batch and never rejects', r500.inserted === 0 && rBoom.inserted === 0);
    ok('http sink: neither the URL nor the key is ever logged', logged.length >= 2 && !logged.join('').includes('logs.example.org') && !logged.join('').includes('SECRETKEY'));
  } finally { (logger as any).info = origInfo; (logger as any).error = origErr; }

  const slow = createHttpContextLogFlush('https://logs.example.org/in', 'k', () => [],
    ((_u: any, init: any) => new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))); })) as any, 30);
  const t0 = Date.now(); const rs = await slow([bare]);
  ok('http sink: times out and drops', rs.inserted === 0 && Date.now() - t0 < 2000);

  let calls = 0;
  const filt = createHttpContextLogFlush('https://logs.example.org/in', 'k', () => ['Secret'], (async () => { calls++; return new Response('{}'); }) as any);
  const rf = await filt([toNeutralRow(row({ content: 'my SECRET plan' }) as any)]);
  ok('http sink: the keyword blocklist keeps a row from leaving', calls === 0 && rf.skipped === 1);

  // --- the factory: which sink a deployment gets ---
  const sanctum = { url: 'https://sanctum.example', key: 'sk', timeoutMs: 1000, primaryTarget: { engine: 'e', model: 'm' } };
  const solance = { url: 'https://api.example', token: 'tk' };
  const generic = loadHouseConfig({ HOUSE_CONFIG_PATH: join(dir, 'missing.json') } as any);
  const base = { MODEL_API_KEY: 'k', MODEL_NAME: 'm', SETTINGS_PATH: join(dir, 's.json'), CONTEXT_LOG_PATH: join(dir, 'c.jsonl') } as any;
  const local = createSeams({ env: base, cfg: generic, sanctum, solance });
  await local.contextLogFlush!([row({ reply_to: '5' }) as any]);
  const written = JSON.parse(readFileSync(join(dir, 'c.jsonl'), 'utf8').trim().split('\n')[0]);
  ok('factory: no CONTEXT_LOG_URL -> the local JSONL file gets the neutral row', written.id === '1234567890' && written.at === '2026-10-17T15:40:00.000Z' && written.reply_to === '5' && !('message_id' in written));
  let threwUrl = ''; try { createSeams({ env: { ...base, CONTEXT_LOG_URL: 'http://x.example/in' }, cfg: generic, sanctum, solance }); } catch (e: any) { threwUrl = e.message; }
  ok('factory: a plain-http CONTEXT_LOG_URL is refused at startup', /must be https/.test(threwUrl));
  let posted = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { posted++; return new Response('{}'); }) as any;
  try {
    const http = createSeams({ env: { ...base, CONTEXT_LOG_URL: 'https://logs.example.org/in', CONTEXT_LOG_KEY: 'K', CONTEXT_LOG_PATH: join(dir, 'never.jsonl') }, cfg: generic, sanctum, solance });
    await http.contextLogFlush!([row() as any]);
    ok('factory: CONTEXT_LOG_URL -> the http sink (and no local file)', posted === 1 && !existsSync(join(dir, 'never.jsonl')));
  } finally { globalThis.fetch = realFetch; }
  const house = parseHouseConfig({ plugs: { model: 'sanctum', settings: 'solance-api', memory: 'sanctum' } });
  const hs = createSeams({ env: {} as any, cfg: house, sanctum, solance });
  ok('factory: the House keeps the Sanctum path (no public sink)', hs.contextLogFlush === null && hs.localContextLogFlush === null);

  // --- the default dial ---
  const { DEFAULTS } = await import('./presence-config.js');
  ok('no House layer: the dial starts off', DEFAULTS.context_log === 'off' && generic.contextLogDefault === 'off');
  ok('House seed keeps house_channels (explicit and legacy)', house.contextLogDefault === 'house_channels' && parseHouseConfig({ hosServerId: 'x' }).contextLogDefault === 'house_channels' && parseHouseConfig({ plugs: { memory: 'sanctum' }, contextLogDefault: 'off' }).contextLogDefault === 'off');

  // --- reply_to rides on the collected row, only when it is a reply ---
  const batches: any[][] = [];
  const cc = new ContextCollector({ getConfig: () => ({ context_log: 'all' }), involvesBot: () => true, flush: async (b: any[]) => { batches.push(b); } } as any);
  const base2 = { channelId: 'c1', channelName: 'general', guildId: 'g1', authorId: 'b1', authorName: 'Botty', content: 'hi', timestamp: '2026-10-17T15:40:00.000Z', isBot: true };
  cc.observe({ ...base2, messageId: 'm1', replyTo: 'm0' });
  cc.observe({ ...base2, messageId: 'm2' });
  await cc.flushAll();
  const rows = batches.flat();
  ok('collector: reply_to set for a reply, key absent otherwise', rows.find((r) => r.message_id === 'm1')?.reply_to === 'm0' && !('reply_to' in rows.find((r) => r.message_id === 'm2')));
  cc.stop();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
