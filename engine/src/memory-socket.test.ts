// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/memory-socket.test.ts — the memory socket: adapters, the per-server wall, the filter, the prompt block. */
import './test-env.js';
import { logger } from './logger.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } }

const KEY = 'sekrit-key-123';
const URLX = 'https://mem.example.org/path/token-abc';
const logged: string[] = [];
for (const k of ['info', 'warn', 'error', 'debug'] as const) (logger as any)[k] = (...a: any[]) => { logged.push(JSON.stringify(a)); };

const resp = (body: unknown, status = 200) => ({ ok: status < 400, status, headers: new Headers(), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }) as any;

async function run() {
  const { HttpMemory, AntechamberMemory, OffMemory, memoryFromEnv, mapWinners } = await import('./seams/memory-provider.js');
  const { applyServerWall, applyMemoryFilter, buildMemoryBlock } = await import('./presence/memory-wall.js');
  const { DirectModelProvider } = await import('./seams/direct-model-provider.js');
  const { createSeams } = await import('./seams/index.js');

  // --- off / env ---
  ok('off returns null', (await new OffMemory().recall()) === null);
  ok('default env is off', memoryFromEnv({} as any).kind === 'off');
  let threw = '';
  try { memoryFromEnv({ MEMORY: 'http', MEMORY_URL: 'http://x.example/' } as any); } catch (e: any) { threw = e.message; }
  ok('http refuses non-https', /https/.test(threw));
  threw = ''; try { memoryFromEnv({ MEMORY: 'http' } as any); } catch (e: any) { threw = e.message; }
  ok('http needs MEMORY_URL', /MEMORY_URL/.test(threw));
  threw = ''; try { memoryFromEnv({ MEMORY: 'bogus' } as any); } catch (e: any) { threw = e.message; }
  ok('unknown MEMORY refused', /MEMORY must be/.test(threw));

  // --- http adapter ---
  let seen: any = null;
  const httpOk = new HttpMemory(URLX, KEY, (async (u: any, init: any) => { seen = { u, init }; return resp({ items: [{ text: 'a', source: 'discord', channel_id: 7, quotable: true }, { nope: 1 }] }); }) as any);
  const r1 = await httpOk.recall({ query: 'hello', guildId: 'G1', channelId: 'C1', scope: 'server' });
  const sent = JSON.parse(seen.init.body);
  ok('http POSTs the contract body', seen.init.method === 'POST' && sent.query === 'hello' && sent.guild_id === 'G1' && sent.channel_id === 'C1' && sent.scope === 'server');
  ok('http sends Bearer key', seen.init.headers.authorization === `Bearer ${KEY}`);
  ok('http maps items, drops junk', r1?.items.length === 1 && r1.items[0].channel_id === '7' && r1.items[0].quotable === true);
  const bad = [
    async () => resp({}, 500), async () => resp('not json'), async () => resp({ items: 'x' }),
    async () => { throw new Error(`boom ${URLX} ${KEY}`); },
    async () => resp('x'.repeat(300 * 1024)),
  ];
  for (const f of bad) ok('http failure -> null', (await new HttpMemory(URLX, KEY, f as any).recall({ query: 'q', guildId: null, channelId: null, scope: 'private' })) === null);
  ok('http timeout aborts -> null', await (async () => {
    const m = new HttpMemory(URLX, KEY, ((_u: any, init: any) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as any);
    const realSet = globalThis.setTimeout;
    (globalThis as any).setTimeout = (fn: any, ms: number, ...a: any[]) => realSet(fn, ms === 7000 ? 5 : ms, ...a);
    try { return (await m.recall({ query: 'q', guildId: null, channelId: null, scope: 'private' })) === null; } finally { globalThis.setTimeout = realSet; }
  })());
  ok('key and URL never logged', !logged.join('').includes(KEY) && !logged.join('').includes('token-abc') && !logged.join('').includes('mem.example.org'));

  // --- antechamber adapter ---
  let aurl = '', ainit: any = null;
  const winners = { winners: [
    { kind: 'message', room: 'Discord', thread: '555', date: '2026-10-01', lines: [{ sender: 'Ann', message: 'hi' }, { sender: 'Bo', message: 'yo' }, { sender: 'x', message: '' }] },
    { kind: 'message', room: 'telegram', thread: '9', lines: [{ sender: 'A', message: 'tg' }] },
    { kind: 'journal', excerpt: 'dear diary', date: '2026-09-09' },
    { kind: 'note', summary: 'sum' }, { kind: 'doc', preview: 'pv' }, { kind: 'memory', text: 'mt' },
    { kind: 'journal' },
  ] };
  const ant = new AntechamberMemory('https://ant.example.org/', 'AK', (async (u: any, init: any) => { aurl = u; ainit = init; return resp(winners); }) as any);
  const r2 = await ant.recall({ query: 'a b&c', guildId: 'G1', channelId: null, scope: 'server', limit: 5 });
  ok('antechamber GET url', aurl === 'https://ant.example.org/antechamber/recall?q=a%20b%26c&limit=5' && ainit.method === 'GET' && ainit.headers.authorization === 'Bearer AK');
  const it = r2!.items;
  ok('antechamber: 6 items mapped, empty dropped', it.length === 6);
  ok('message lines joined sender: message', it[0].text === 'Ann: hi\nBo: yo');
  ok('discord room case-insensitive: thread -> channel_id', it[0].channel_id === '555' && it[0].source === 'Discord');
  ok('non-discord message has no channel_id', it[1].channel_id === null && it[1].source === 'telegram');
  ok('other kinds use text fields and kind as source', it[2].text === 'dear diary' && it[2].source === 'journal' && it[3].text === 'sum' && it[4].text === 'pv' && it[5].text === 'mt');
  // tolerant parsing: unknown fields, counts, ranking and service fields are ignored; title is a text fallback
  const tol = mapWinners([
    { kind: 'journal', title: 'a title', served_by: 'x', rank: 3, score: 0.9, degraded: true, failed: [], extra: { deep: 1 } },
    { kind: 'message', room: 'discord', server_id: 'G1', thread: '1', rank: 1, served_by: 'q', lines: [{ sender: 'a', message: 'm', ts: 5, weird: {} }] },
    { kind: { nope: 1 }, text: 'odd kind' }, 42, null,
  ] as any, 'G1');
  ok('mapWinners tolerates unknown fields and odd shapes', tol.length === 3 && tol[0].text === 'a title' && tol[1].quotable === true && tol[2].text === 'odd kind' && tol[2].source === null);
  let tolUrl = '';
  const antTol = new AntechamberMemory('https://ant.example.org', '', (async (u: any) => { tolUrl = u; return resp({ winners: [], served_by: 'z', failed: ['a'], count: 99 }); }) as any);
  const rTol = await antTol.recall({ query: 'x', guildId: 'G1', channelId: 'C1', scope: 'server', limit: 3 });
  ok('antechamber sends only q and limit; an empty answer with extra fields is just no items', tolUrl === 'https://ant.example.org/antechamber/recall?q=x&limit=3' && rTol!.items.length === 0);
  ok('antechamber adapter carries the EXPERIMENTAL note with the tested engine commit', /EXPERIMENTAL/.test(readFileSync(new URL('./seams/memory-provider.ts', import.meta.url), 'utf8')) && /9cfbd44/.test(readFileSync(new URL('./seams/memory-provider.ts', import.meta.url), 'utf8')));
  // The real engine (9cfbd44) labels every winner kind "item": a chat winner is known by its lines, and source comes from the winner.
  const live = mapWinners([{ kind: 'item', source: 'chats', date: '2026-01-02', title: 't', text: 'flat', lines: [{ sender: 'Ann', message: 'hi', hit: true }, { sender: 'Bo', message: 'yo' }] }, { kind: 'item', source: 'notes', text: 'soup recipe', section: 's', day: 1 }], null);
  ok('mapWinners reads a 9cfbd44 chat winner by its lines, with the winner source', live.length === 2 && live[0].text === 'Ann: hi\nBo: yo' && live[0].source === 'chats' && live[1].text === 'soup recipe' && live[1].source === 'notes');
  ok('antechamber failure -> null', (await new AntechamberMemory('https://ant.example.org', '', (async () => resp({}, 500)) as any).recall({ query: 'q', guildId: null, channelId: null, scope: 'private' })) === null);
  ok('mapWinners quotable only same-server discord', mapWinners([{ kind: 'message', room: 'discord', server_id: 'G1', thread: '1', lines: [{ sender: 'a', message: 'm' }] }], 'G1')[0].quotable === true
    && mapWinners([{ kind: 'message', room: 'discord', server_id: 'G2', thread: '1', lines: [{ sender: 'a', message: 'm' }] }], 'G1')[0].quotable === undefined);

  // --- the wall ---
  const HoS = 'H1', Lun = 'L1', Snug = 'S1';
  const chan: Record<string, string> = { c_hos: HoS, c_lun: Lun, c_snug: Snug };
  const channelGuildOf = (c: string) => chan[c] ?? null;
  const items = [
    { text: 'hos-by-server', source: 'discord', server_id: HoS },
    { text: 'lun-by-server', source: 'Discord', server_id: Lun },
    { text: 'hos-by-channel', source: 'discord', channel_id: 'c_hos' },
    { text: 'snug-by-channel', channel_id: 'c_snug' },
    { text: 'unknown-channel', source: 'discord', channel_id: 'c_gone' },
    { text: 'discord-no-place', source: 'DISCORD' },
    { text: 'journal', source: 'journal' },
    { text: 'server-id-beats-channel', source: 'discord', server_id: Lun, channel_id: 'c_hos' },
  ];
  const names = (a: { text: string }[]) => a.map((x) => x.text).join(',');
  ok('HoS sees only HoS discord + non-discord', names(applyServerWall(items, { scope: 'server', guildId: HoS, channelGuildOf })) === 'hos-by-server,hos-by-channel,journal');
  ok('Harborlight', names(applyServerWall(items, { scope: 'server', guildId: Lun, channelGuildOf })) === 'lun-by-server,journal,server-id-beats-channel');
  ok('Snug', names(applyServerWall(items, { scope: 'server', guildId: Snug, channelGuildOf })) === 'snug-by-channel,journal');
  ok('guest DM (guild null, server scope): no discord items', names(applyServerWall(items, { scope: 'server', guildId: null, channelGuildOf })) === 'journal');
  ok('private scope unfiltered', applyServerWall(items, { scope: 'private', guildId: null, channelGuildOf }).length === items.length);

  // --- the filter ---
  const f = applyMemoryFilter([{ text: 'Talk about Banana pie' }, { text: 'bananas are fine' }, { text: 'a SECRET plan' }, { text: 'clean' }], ['banana', 'secret plan', ' ']);
  ok('filter: whole word, case-insensitive, phrases', names(f) === 'bananas are fine,clean');
  ok('filter: empty list keeps all', applyMemoryFilter([{ text: 'x' }], []).length === 1);

  // --- block ---
  const wall = { scope: 'server' as const, guildId: HoS, channelGuildOf };
  const b = buildMemoryBlock([
    { text: 'said in HoS', date: '2026-10-01', source: 'discord', server_id: HoS },
    { text: 'a journal line', source: 'journal' },
    { text: 'marked', source: 'note', quotable: true },
  ], wall)!;
  ok('block header', b.block.startsWith('# What you remember\n_Quotable items may be referred to. Understood items shape your understanding only: never quote or closely paraphrase them._\n'));
  ok('block labels', b.block.includes('- [quotable] (2026-10-01, discord) said in HoS') && b.block.includes('- [understood] (journal) a journal line') && b.block.includes('- [quotable] (note) marked'));
  ok('privateSnippets = understood only', b.privateSnippets.length === 1 && b.privateSnippets[0] === 'a journal line');
  const many = buildMemoryBlock(Array.from({ length: 20 }, (_, i) => ({ text: `n${i}`, source: 'journal' })), wall)!;
  ok('capped at 8 items', many.count === 8);
  const long = buildMemoryBlock(Array.from({ length: 8 }, () => ({ text: 'w '.repeat(400), source: 'journal' })), wall)!;
  ok('capped at 4000 chars', long.block.length <= 4000 && long.count < 8);
  ok('no items -> null', buildMemoryBlock([], wall) === null);

  // --- DirectModelProvider.prepare ---
  const cfg = { kind: 'openai-compatible' as const, baseUrl: 'https://m.example', apiKey: 'k', model: 'm' };
  const mem = { kind: 'http' as const, recall: async (q: any) => { (mem as any).last = q; return { items: [
    { text: 'ok here', source: 'discord', server_id: HoS },
    { text: 'other server', source: 'discord', server_id: Lun },
    { text: 'forbidden word inside', source: 'journal' },
    { text: 'private thought', source: 'journal' },
  ] }; } };
  const dp = new DirectModelProvider(cfg, 1000, { memory: mem as any, blocklist: () => ['forbidden'], channelGuildOf });
  const p = await dp.prepare('SYS', { query: 'hey', channel: 'discord', guild_id: HoS, scope: 'server' }, 'c_hos');
  ok('prepare passes query/guild/channel/scope', (mem as any).last.query === 'hey' && (mem as any).last.guildId === HoS && (mem as any).last.channelId === 'c_hos' && (mem as any).last.scope === 'server');
  ok('prepare: system kept, block appended', p!.systemPrompt.startsWith('SYS\n\n# What you remember') && p!.systemPrompt.includes('ok here') && p!.systemPrompt.includes('private thought'));
  ok('prepare: wall + filter applied', !p!.systemPrompt.includes('other server') && !p!.systemPrompt.includes('forbidden'));
  ok('prepare: privateSnippets feed the leak guard', JSON.stringify(p!.privateSnippets) === JSON.stringify(['private thought']));
  const failing = new DirectModelProvider(cfg, 1000, { memory: { kind: 'http', recall: async () => { throw new Error('x'); } } as any });
  ok('memory throw -> prompt unchanged', (await failing.prepare('SYS', { query: 'q', channel: 'discord' }))!.systemPrompt === 'SYS');
  const nul = new DirectModelProvider(cfg, 1000, { memory: { kind: 'http', recall: async () => null } as any });
  ok('memory null -> prompt unchanged', (await nul.prepare('SYS', { query: 'q', channel: 'discord' }))!.systemPrompt === 'SYS');
  const plain = new DirectModelProvider(cfg, 1000);
  const pp = await plain.prepare('SYS', { query: 'q', channel: 'discord' });
  ok('no memory: unchanged, empty snippets', pp!.systemPrompt === 'SYS' && pp!.privateSnippets!.length === 0);
  const late = new DirectModelProvider(cfg, 1000, { memory: { kind: 'http', recall: async () => ({ items: [{ text: 'by chan', channel_id: 'late_c' }] }) } as any });
  late.setChannelGuildResolver((c) => (c === 'late_c' ? 'GZ' : null));
  ok('resolver can be set after construction', (await late.prepare('S', { query: 'q', channel: 'discord', guild_id: 'GZ', scope: 'server' }))!.systemPrompt.includes('[quotable]'));

  // --- review fixes ---
  ok('server_id of another guild is rejected even with non-discord source', applyServerWall([{ text: 'x', source: 'journal', server_id: 'G2', quotable: true }], { scope: 'server', guildId: 'G1', channelGuildOf: () => null }).length === 0);
  ok('server_id of another guild is rejected with no source', applyServerWall([{ text: 'x', server_id: 'G2' }], { scope: 'server', guildId: 'G1', channelGuildOf: () => null }).length === 0);
  ok('server_id matching guild passes', applyServerWall([{ text: 'x', source: 'journal', server_id: 'G1' }], { scope: 'server', guildId: 'G1', channelGuildOf: () => null }).length === 1);
  let threwHttp = false; try { new AntechamberMemory('http://ant.example.org'); } catch { threwHttp = true; }
  ok('antechamber rejects plaintext http', threwHttp);
  let loop = true; try { new AntechamberMemory('http://127.0.0.1:8787'); } catch { loop = false; }
  ok('antechamber allows http on loopback', loop);

  // --- seams factory ---
  const base = { sanctum: { url: 'https://s.example', key: 'k', timeoutMs: 1000, primaryTarget: { engine: 'e', model: 'm' } }, solance: { url: 'https://a.example', token: 't' } };
  const house = createSeams({ ...base, cfg: { plugs: { model: 'sanctum', settings: 'solance-api', memory: 'sanctum' } } as any, env: { MEMORY: 'http', MEMORY_URL: URLX } as any });
  ok("House memory plug 'sanctum' never constructs a socket", house.memoryProvider.kind === 'off');
  const pub = createSeams({ ...base, cfg: { plugs: { model: 'direct', settings: 'local', memory: 'off' } } as any, env: { MODEL_API_KEY: 'k', MODEL_NAME: 'm', SETTINGS_PATH: '/tmp/ms-test-settings.json', MEMORY: 'antechamber', ANTECHAMBER_URL: 'https://ant.example' } as any });
  ok('public build reads MEMORY env', pub.memoryProvider.kind === 'antechamber');

  // --- a reply with no (or a false) Content-Length is still capped while streaming ---
  {
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({ pull(c) { pulled++; if (pulled > 400) { c.close(); return; } c.enqueue(new Uint8Array(1024)); } });
    const liar = new HttpMemory(URLX, KEY, (async () => new Response(big, { status: 200, headers: { 'content-length': '10' } })) as any);
    const r = await liar.recall({ query: 'q', guildId: null, channelId: null, scope: 'private' });
    ok('streamed reply over the cap -> null, stops reading early', r === null && pulled < 400);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
