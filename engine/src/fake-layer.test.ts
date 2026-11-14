// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Run: npx tsx src/fake-layer.test.ts — the engine end to end with NO deployment-specific files.
 *
 * A bare install plus one test hooks file (a temp folder, found through TERTULIA_HOOKS_PATH) that supplies a fake
 * modelProvider, settingsStore, contextSink, authorNotes and onChannelReply. One guest message goes through the
 * real gateway handler (DiscordClient 'messageCreate') and the real sweep and PresenceEngine to a reply, and each
 * fake is checked: the prompt carries the Now line, the timed transcript line and the author note; the reply went
 * out; the sink holds the reply row and nothing from an ignored author sitting in the same window; a setting
 * written through the store reads back; onChannelReply fired. A second case: no hooks path and no model provider
 * stops startup with a message that names the settings.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No deployment config at all: the engine's own generic defaults.
const dir = mkdtempSync(join(tmpdir(), 'fake-layer-'));
process.env.CONFIG_PATH = join(dir, 'no-such-config.json');
delete process.env.HOUSE_CONFIG_PATH;

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

// What the fakes saw. The hooks file below is a separate module, so it reports through this global.
type Seen = {
  prompts: string[];
  noteAsks: Array<Array<{ id: string; shownName: string }>>;
  settingsPuts: any[];
  sinkBatches: any[][];
  channelReplies: any[];
  settingsDoc: { discord: Record<string, unknown> };
};
const seen: Seen = {
  prompts: [], noteAsks: [], settingsPuts: [], sinkBatches: [], channelReplies: [],
  settingsDoc: { discord: {} },
};
(globalThis as any).__fakeLayer = seen;

const GUEST = '800000000000000001', IGNORED = '800000000000000002', BOT = '100000000000000003', OWNER = '100000000000000001';
const CHANNEL = '800000000000000101', GUILD = '800000000000000100';
const IGNORED_TEXT = 'ignored-author-secret-words', IGNORED_NAME = 'Ghostly';
const GUEST_TEXT = 'could you tell me the time please';
const NOTE_TEXT = 'Mara goes by she/her and likes tea';
const REPLY_TEXT = 'It is just after two in the afternoon, Mara.';
// 14 Nov 2026 14:05 UTC (the default zone); the engine clock reads one minute later.
const T_IGNORED = Date.UTC(2026, 10, 14, 14, 4, 0);
const T_GUEST = Date.UTC(2026, 10, 14, 14, 5, 0);
const NOW = T_GUEST + 60_000;

const hooksSource = `
const seen = globalThis.__fakeLayer;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const hooks = {
  modelProvider: () => ({
    complete: async (_target, system, userContent) => {
      seen.prompts.push(String(system) + '\\n' + (typeof userContent === 'string' ? userContent : JSON.stringify(userContent)));
      return { ok: true, text: ${JSON.stringify(REPLY_TEXT)} };
    },
    prepare: async () => null,
    postComplete: async () => new Response('{}', { status: 500 }),
  }),
  settingsStore: () => ({
    getPresenceConfig: async () => json({ discord: seen.settingsDoc.discord }),
    putPresenceConfig: async (body) => { seen.settingsPuts.push(body); seen.settingsDoc.discord = { ...seen.settingsDoc.discord, ...body }; return json({ discord: seen.settingsDoc.discord }); },
    getQuietHours: async () => json({}),
    getAwayStatus: async () => json({}),
    postQuietHoursEvent: async () => json({}),
  }),
  contextSink: () => ({
    kind: 'custom',
    recall: async () => null,
    flush: async (batch) => { seen.sinkBatches.push(batch); return { inserted: batch.length, skipped: 0 }; },
  }),
  authorNotes: async (authors) => {
    seen.noteAsks.push(authors.map((a) => ({ id: a.id, shownName: a.shownName })));
    const out = {};
    for (const a of authors) if (a.id === ${JSON.stringify(GUEST)}) out[a.id + '|' + a.shownName] = ${JSON.stringify(NOTE_TEXT)};
    return out;
  },
  onChannelReply: async (msg) => { seen.channelReplies.push(msg); return true; },
};
`;
const hooksFile = join(dir, 'test-hooks.mjs');
writeFileSync(hooksFile, hooksSource);

const asMsg = (o: { id: string; authorId: string; name: string; content: string; ts: number; mentionsBot?: boolean; reference?: any; bot?: boolean }): any => ({
  id: o.id,
  author: { id: o.authorId, username: o.name.toLowerCase(), globalName: o.name, tag: `${o.name}#0`, bot: o.bot === true },
  member: { displayName: o.name },
  content: o.content,
  createdTimestamp: o.ts,
  createdAt: new Date(o.ts),
  guildId: GUILD,
  guild: { id: GUILD, name: 'Test Hall', members: { fetch: async () => ({ displayName: o.name }) } },
  channelId: CHANNEL,
  channel: { id: CHANNEL, name: 'hall', type: 0 },
  attachments: new Map(),
  stickers: new Map(),
  embeds: [],
  reference: o.reference ?? null,
  mentions: {
    has: (id: string) => Boolean(o.mentionsBot) && id === BOT,
    users: new Map(),
    repliedUser: null,
  },
});

async function run() {
  const { setHooks, loadHooks } = await import('./hooks.js');
  const { createSeams } = await import('./seams/index.js');
  const { parseDeploymentConfig, loadDeploymentConfig } = await import('./config/deployment-config.js');
  const { DiscordClient } = await import('./discord-client.js');
  const { PresenceEngine } = await import('./presence-engine.js');
  const { PresenceConfig } = await import('./presence-config.js');
  const { ContextCollector } = await import('./context-collector.js');
  const { GenerationContextRegistry } = await import('./generation-context.js');
  const { NO_MODEL_MESSAGE } = await import('./seams/model-provider.js');

  const generic = loadDeploymentConfig({ CONFIG_PATH: join(dir, 'missing.json') } as any);
  ok('bare install: the generic defaults carry no deployment-specific plug', generic.plugs.model === 'direct' && generic.plugs.settings === 'local' && generic.plugs.memory === 'off');

  // ── case 1: the fakes, through the real gateway handler ───────────────────────────────────────────────────
  process.env.TERTULIA_HOOKS_PATH = hooksFile;
  const hooks = await loadHooks();
  ok('hooks: the test file loads through TERTULIA_HOOKS_PATH', typeof hooks.modelProvider === 'function' && typeof hooks.onChannelReply === 'function');

  const cfg = parseDeploymentConfig({ plugs: { model: 'custom', settings: 'custom', memory: 'custom' } });
  const seams = createSeams({ env: process.env, cfg, hooks });
  ok('seams: every plug is answered by the hooks file', seams.modelReady && seams.settingsReady && seams.memoryProvider.kind === 'custom' && typeof seams.contextLogFlush === 'function');

  // a setting written through the store round-trips
  seen.settingsDoc.discord = { ignored_user_ids: [IGNORED], context_log: 'all', timezone: 'UTC', presence_level: 6 };
  const put = await seams.settingsStore.putPresenceConfig({ extra_instructions: 'round-trip-marker' });
  const back: any = await (await seams.settingsStore.getPresenceConfig()).json();
  ok('settings: a value written through the store reads back', put.ok && back.discord.extra_instructions === 'round-trip-marker' && seen.settingsPuts.length === 1);

  const presenceConfig = new PresenceConfig('', '', { store: seams.settingsStore });
  await presenceConfig.refresh();
  ok('settings: the engine reads its config (ignore list, zone) from the fake store', presenceConfig.getCached().ignored_user_ids.includes(IGNORED) && presenceConfig.getCached().timezone === 'UTC');

  const dc: any = new DiscordClient(OWNER);
  dc.presenceSettled = true;
  dc.botUserId = BOT;
  dc.setSettingsStore(seams.settingsStore, true);
  dc.setPresenceConfig(presenceConfig);
  const generationContext = new GenerationContextRegistry();
  dc.setGenerationContextRegistry(generationContext);
  const collector = new ContextCollector({
    getConfig: () => presenceConfig.getCached(),
    involvesBot: (m: any) => Boolean(m.involvesBot),
    flush: (batch: any[]) => Promise.resolve(seams.contextLogFlush!(batch)),
    takeContextLog: (id: string) => generationContext.take(id),
    subscribeContextLog: (l: any) => generationContext.subscribe(l),
  } as any);
  dc.setContextCollector(collector);

  const engine: any = new PresenceEngine('', '', 'PERSONA', () => NOW, undefined, undefined, undefined, presenceConfig);
  engine.setModelProvider(seams.modelProvider);
  engine.setSelfId(BOT);
  dc.ambientEngine = engine;
  dc.ambientMemory = { peekMemoryContext: async () => ({}) };
  dc.getStickerRoster = async () => [];
  dc.stickersFor = async () => [];
  dc.channelRules = () => ({ step: 'reply_only', ambient: false, answerMentions: true });
  dc.guildIdOfChannelCached = () => GUILD;

  const ignoredMsg = asMsg({ id: '900000000000000001', authorId: IGNORED, name: IGNORED_NAME, content: IGNORED_TEXT, ts: T_IGNORED });
  const guestMsg = asMsg({ id: '900000000000000002', authorId: GUEST, name: 'Mara', content: GUEST_TEXT, ts: T_GUEST, mentionsBot: true });
  dc.client.channels.fetch = async () => ({
    type: 0, name: 'hall', guildId: GUILD,
    messages: { fetch: async () => new Map([[ignoredMsg.id, ignoredMsg], [guestMsg.id, guestMsg]]) },
  });
  const sends: Array<{ channelId: string; text: string; replyTo?: string }> = [];
  dc.sendMessage = async (channelId: string, text: string, _a: unknown, replyTo?: string) => {
    sends.push({ channelId, text, replyTo });
    return { id: '900000000000000003' };
  };
  dc.withTypingIn = async (_c: string, fn: () => Promise<any>) => fn();

  // the real handler: the ignored author's message never gets in, the guest mention marks the channel
  dc.client.emit('messageCreate', ignoredMsg);
  dc.client.emit('messageCreate', guestMsg);
  await new Promise((r) => setTimeout(r, 50));
  ok('gateway: the guest mention marks its channel for the sweep, the ignored author does not', dc.ambientDirtyChannels.has(CHANNEL));

  await dc.runAmbientSweep();

  ok('model: the fake provider was called once', seen.prompts.length === 1);
  const prompt = seen.prompts[0] ?? '';
  ok('prompt: carries the Now line', prompt.includes('Now: Saturday 14 Nov 2026, 14:06 (UTC)'));
  ok('prompt: carries the timed transcript line of the guest message', new RegExp(`\\[14:05\\] [^\\n]*Mara[^\\n]*${GUEST_TEXT}`).test(prompt));
  ok('prompt: carries the author note for the speaker', prompt.includes(NOTE_TEXT));
  ok('notes: asked for the guest, never for the ignored author', seen.noteAsks.length >= 1 && seen.noteAsks.flat().some((a) => a.id === GUEST) && !seen.noteAsks.flat().some((a) => a.id === IGNORED));
  ok('prompt: nothing from the ignored author', !prompt.includes(IGNORED_TEXT) && !prompt.includes(IGNORED_NAME));
  ok('reply: sent to the channel as an answer to the guest message', sends.length === 1 && sends[0].text === REPLY_TEXT && sends[0].channelId === CHANNEL && sends[0].replyTo === guestMsg.id);

  // the gateway echoes the bot's own post; the collector turns it into the reply row
  const echo = asMsg({ id: '900000000000000003', authorId: BOT, name: 'Bram', content: REPLY_TEXT, ts: NOW, bot: true });
  dc.client.emit('messageCreate', echo);
  await new Promise((r) => setTimeout(r, 50));
  await collector.flushAll();
  const rows = seen.sinkBatches.flat();
  const reply = rows.find((r: any) => r.content === REPLY_TEXT);
  ok('sink: received the reply row', Boolean(reply));
  const sinkText = JSON.stringify(rows);
  ok('sink: the reply row carries the guest message that triggered it', sinkText.includes(GUEST_TEXT));
  ok('sink: no row and no trigger text from the ignored author', !sinkText.includes(IGNORED_TEXT) && !sinkText.includes(IGNORED_NAME) && !rows.some((r: any) => r.author_id === IGNORED));

  // onChannelReply: a reply to another message goes to the hook first
  const replyMsg = asMsg({ id: '900000000000000004', authorId: GUEST, name: 'Mara', content: 'replying to someone', ts: NOW + 1000, reference: { messageId: '900000000000000001', channelId: CHANNEL } });
  dc.client.emit('messageCreate', replyMsg);
  await new Promise((r) => setTimeout(r, 50));
  ok('onChannelReply: fired once with plain facts of the reply', seen.channelReplies.length === 1 && seen.channelReplies[0].id === replyMsg.id && seen.channelReplies[0].authorId === GUEST && seen.channelReplies[0].channelId === CHANNEL);
  ok('onChannelReply: a handled reply goes no further (no second model call)', seen.prompts.length === 1);

  collector.stop();
  setHooks(null);

  // ── case 2: no hooks path and no model provider -> startup refuses, naming the settings ─────────────────────
  delete process.env.TERTULIA_HOOKS_PATH;
  const bare = await loadHooks([], undefined, null);
  let message = '';
  try { createSeams({ env: {} as any, cfg: generic, hooks: bare }); } catch (e: any) { message = String(e?.message ?? e); }
  ok('startup: no hooks path and no model provider is refused', message.length > 0);
  ok('startup: the message names MODEL_API_KEY, MODEL_NAME and the hooks path setting', /MODEL_API_KEY/.test(message) && /MODEL_NAME/.test(message) && /TERTULIA_HOOKS_PATH/.test(message) && message.includes(NO_MODEL_MESSAGE));
  let customWithout = '';
  try { createSeams({ env: {} as any, cfg, hooks: bare }); } catch (e: any) { customWithout = String(e?.message ?? e); }
  ok('startup: plug "custom" with no hooks file is refused naming the missing function and the path setting', /is "custom"/.test(customWithout) && /exports no \w+\(\)/.test(customWithout) && /TERTULIA_HOOKS_PATH/.test(customWithout));
}

run()
  .catch((e) => { fail++; console.error(e); })
  .finally(() => {
    setTimeout(() => {
      rmSync(dir, { recursive: true, force: true });
      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    }, 10);
  });
