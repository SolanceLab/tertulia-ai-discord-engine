// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/hidden-context.test.ts — the ignore list's gaps are never revealed (Owner, 22 Oct 2026). */
import './test-env.js';
import { HIDDEN_CONTEXT_INSTRUCTION, HIDDEN_CONTEXT_CARD_LINE } from './hidden-context.js';
import { countHiddenContext, buildContextBlock, type ContextMessage, ContextTags, collectReplyContextFull, type ContextReaders } from './reply-context.js';
import { handleReplyCommand, formatPublicReply, ReplyMemory, renderReplyDraft } from './reply-as.js';
import { handleSendCommand } from './send-to.js';
import { AsideMemory, StudyAsideQueue } from './aside.js';
import { renderAllPrompts } from './prompt-harness.js';
import { DiscordClient } from './discord-client.js';
import { DEFAULTS as PRESENCE_DEFAULTS } from './presence-config.js';
import { ChannelType } from 'discord.js';
import { windowHidden } from './presence/window.js';
let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}
const OWEN = '100000000000000001', G = '700000000000000001', C = '700000000000000002', M = '700000000000000003';
const MUTED = '100000000000000009';
const cm = (id: string, authorId: string, authorName: string, content: string): ContextMessage => ({ id, authorId, authorName, content });
const seen = (id: string) => cm(id, '5', 'Aya', `line ${id}`);
const hid = (id: string) => cm(id, MUTED, 'Muted', `hidden ${id}`);

// ── the count, from each part ──
ok('count: nothing ignored is 0', countHiddenContext({ targetId: 't', before: [seen('1')], ignored: [MUTED] }) === 0);
ok('count: surrounding messages', countHiddenContext({ targetId: 't', before: [hid('1'), seen('2')], after: [hid('3')], ignored: [MUTED] }) === 2);
ok('count: the message the clicked one replies to', countHiddenContext({ targetId: 't', chain: hid('1'), ignored: [MUTED] }) === 1);
ok('count: tagged messages', countHiddenContext({ targetId: 't', tagged: [hid('1'), hid('2'), seen('3')], ignored: [MUTED] }) === 2);
ok('count: one hidden message seen twice counts once', countHiddenContext({ targetId: 't', chain: hid('1'), before: [hid('1')], ignored: [MUTED] }) === 1);
ok('count: with no ignore list it is 0', countHiddenContext({ targetId: 't', chain: hid('1') }) === 0);
ok('block: the hidden message never appears in the block', !buildContextBlock({ targetId: 't', before: [hid('1'), seen('2')], ignored: [MUTED] }).includes('hidden'));

// ── collectReplyContextFull passes the count up ──
{
  const readers = (chain: ContextMessage | null): ContextReaders => ({
    canRead: async () => true,
    readAround: async () => ({ before: [seen('1')], after: [] }),
    readReferenced: async () => chain,
    ignored: () => [MUTED],
    tags: new ContextTags(),
  });
  const info = { target: { id: 't' }, channelId: C, ownerUserId: OWEN };
  ok('collect: a reply to an ignored author reports hidden', (await collectReplyContextFull(readers(hid('2')), info)).hidden === 1);
  ok('collect: nothing hidden reports 0', (await collectReplyContextFull(readers(seen('2')), info)).hidden === 0);
}

// ── the instruction itself: neutral ──
ok('instruction: no digits, no names', !/\d/.test(HIDDEN_CONTEXT_INSTRUCTION) && !/Muted|Rook/.test(HIDDEN_CONTEXT_INSTRUCTION));

// ── the private card, and only the card ──
{
  ok('card: the line shows when something was hidden', renderReplyDraft('> **Aya**: hi\n\nok', true).includes(HIDDEN_CONTEXT_CARD_LINE));
  ok('card: no line when nothing was hidden', !renderReplyDraft('> **Aya**: hi\n\nok', false).includes(HIDDEN_CONTEXT_CARD_LINE) && renderReplyDraft('x') === renderReplyDraft('x', false));
  const calls: any[] = [], generated: any[] = [];
  const mem = new ReplyMemory();
  const it: any = {
    commandName: 'Reply as Bram', user: { id: OWEN }, channelId: C, guildId: G, targetId: M,
    targetMessage: { id: M, content: 'HAHAHA', channelId: C, author: { id: '5', username: 'aya', globalName: 'Aya' }, member: null },
    isMessageContextMenuCommand: () => true,
    reply: async (o: any) => { calls.push(['reply', o]); }, deferReply: async () => {},
    editReply: async (o: any) => { calls.push(['edit', o]); }, followUp: async () => ({}),
  };
  await handleReplyCommand(it, {
    commandName: 'Reply as Bram', ownerUserId: OWEN, memory: mem, newId: () => 'd1', log: () => {},
    context: async () => ({ block: '', hidden: 2 }),
    generate: async (_a, _c, _g, _ctx, _img, hidden) => { generated.push(hidden); return { text: 'ha, good one' }; },
  });
  const card = calls.find((c) => c[0] === 'edit')[1].content as string;
  const draft = mem.take('d1')!;
  ok('reply: generate is told something was hidden', generated[0] === true);
  ok('reply: the private card carries the line', card.includes(HIDDEN_CONTEXT_CARD_LINE));
  ok('reply: the public text is unchanged by it', !draft.text.includes(HIDDEN_CONTEXT_CARD_LINE) && draft.text === formatPublicReply({ authorName: 'Aya', content: 'HAHAHA', guildId: G, channelId: C, messageId: M, reply: 'ha, good one' }));
}

// ── Send to: the Study item carries hidden_context ──
{
  const send = async (hidden: number | undefined) => {
    const q = new StudyAsideQueue(() => 1_000_000);
    const it: any = {
      commandName: 'Send to Bram', user: { id: OWEN }, channelId: C, guildId: G,
      isMessageContextMenuCommand: () => true,
      targetMessage: { id: M, content: 'look at this', channelId: C, guildId: G, author: { id: '5', username: 'aya', globalName: 'Aya' }, attachments: [] },
      options: { resolved: { members: { get: () => null } } },
      reply: async () => {}, deferReply: async () => {}, editReply: async () => {}, followUp: async () => ({}),
    };
    await handleSendCommand(it, {
      commandName: 'Send to Bram', ownerUserId: OWEN, studyQueue: q, memory: new AsideMemory(() => 1_000_000),
      context: async () => ({ block: '', hidden }), channelName: async () => 'meet', ignored: () => [], newId: () => 's1', log: () => {}, now: () => 1_000_000,
    });
    return q.pending()[0] as any;
  };
  const withGap = await send(1), without = await send(0);
  ok('send: hidden_context is true and token-free', withGap?.hidden_context === true && !JSON.stringify(withGap).includes(MUTED));
  ok('send: absent when nothing was hidden', without && !('hidden_context' in without));
}

// ── the prompts (House golden fixtures hold the exact text) ──
{
  const r: any = await renderAllPrompts();
  const has = (s: unknown) => typeof s === 'string' && s.includes(HIDDEN_CONTEXT_INSTRUCTION);
  ok('prompt: Reply as with hidden context carries the instruction', has(r['hidden:reply'].system));
  ok('prompt: ambient reply carries it when a window message was removed', has(r['hidden:respond'].system));
  ok('prompt: ambient judge carries it', has(r['hidden:judge'].system));
  ok('prompt: the private aside carries it', has(r['hidden:aside'].system));
  ok('prompt: the public aside proposal carries it too', has(r['hidden:aside-proposal'].system));
  ok('prompt: absent when nothing was hidden', !has(r['reply:message'].system) && !has(r['respond:guest-addressed'].system) && !has(r['judge:owner-last/balanced'].system) && !has(r['aside:with-history'].system));
  ok('prompt: the removed author never appears', !JSON.stringify([r['hidden:respond'], r['hidden:judge'], r['hidden:aside'], r['hidden:aside-proposal']]).includes('Muted'));
}

// ── the real ingress path: the fetched window is counted BEFORE the ignored author is dropped ──
{
  const raw = (id: string, authorId: string, name: string, ts: number) => ({
    id, author: { id: authorId, username: name, globalName: name, tag: `${name}#0` }, member: { displayName: name },
    content: `text ${id}`, createdTimestamp: ts, guildId: null, channelId: C, attachments: new Map(), reference: null,
    mentions: { has: () => false },
  });
  const dc: any = new DiscordClient('owen-1');
  dc.botUserId = '800000000000000001';
  const cfg = { ...PRESENCE_DEFAULTS, ignored_user_ids: [MUTED] };
  dc.presenceConfig = { getCached: () => cfg };
  const msgs = [raw('1', '5', 'Aya', 1000), raw('2', MUTED, 'Muted', 2000), raw('3', '5', 'Aya', 3000)];
  const channel = { type: ChannelType.GuildText, name: 'meet', messages: { fetch: async () => new Map(msgs.map((m) => [m.id, m])) } };
  dc.client = { channels: { fetch: async () => channel } };

  const win = await dc.readChannelWindow(channel, 15, cfg);
  ok('ingress: readChannelWindow drops the ignored author', win.length === 2 && !win.some((m: any) => m.authorId === MUTED));
  ok('ingress: readChannelWindow flags the window itself, so the prompt can say part is out of sight', windowHidden(win));
  const kept = await dc.getRecentMessages(C, 15, { keepBlocked: true });
  ok('ingress: getRecentMessages can hand the strip the unfiltered list', kept.length === 3);
  const filtered = await dc.getRecentMessages(C, 15);
  ok('ingress: getRecentMessages still filters by default (history stays clean)', filtered.length === 2 && !filtered.some((m: any) => m.author.id === MUTED));

  cfg.ignored_user_ids = [];
  const clean = await dc.readChannelWindow(channel, 15, cfg);
  ok('ingress: with nothing ignored the window has no marker', clean.length === 3 && !windowHidden(clean));
  const everyone = await dc.readChannelWindow(channel, 15, { ...cfg, ignored_user_ids: ['5', MUTED] });
  ok('ingress: a window of only ignored authors is empty but still flagged hidden', everyone.length === 0 && windowHidden(everyone));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
