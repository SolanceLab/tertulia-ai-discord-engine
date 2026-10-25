// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Reactions in the room (2026-10-16): the store, the transcript suffix (hidden authors absent), the judge
 * and direct-reply parsing, the single-emoji check, the reaction-only decision (posts nothing, one
 * addReaction), never on my own or a hidden author's message, 6 per channel per hour, and the owner's
 * reaction on my message visible in the next window.
 * Run: npx tsx src/reactions.test.ts
 */
import './test-env.js';
import { buildReactions, ReactionStore, mentionReplyOutcome, normalizeReactionEmoji } from './reaction-store.js';
import { formatReactionSuffix } from './presence/window.js';
import { speakerLock } from './speaker-lock.js';
import { ChannelType } from 'discord.js';
import { DiscordClient } from './discord-client.js';
import { formatTranscriptMessage, REACTIONS_PER_CHANNEL_PER_HOUR, PresenceEngine } from './presence-engine.js';
import type { WindowMessage } from './presence-engine.js';
import type { ModelProvider } from './seams/model-provider.js';
import { DEFAULTS as PRESENCE_DEFAULTS } from './presence-config.js';
import { identity } from './config/identity.js';

let fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) console.log(`  ok   ${name}`); else { fail++; console.log(`  FAIL ${name}`); } };

const OWNER = '100000000000000001', BOT = '100000000000000003', GUEST = '100000000000000002', HIDDEN = '100000000000000009';
const fakeMsg = (id: string, reactions: Array<[string, number]>) => ({
  id,
  reactions: { cache: new Map(reactions.map(([e, c]) => [e, { emoji: { toString: () => e }, count: c }])) },
});

// ── store: add / remove / cap ───────────────────────────────────────────────
{
  const s = new ReactionStore(3);
  s.add('m1', '🔥', 'u1', 'Mara'); s.add('m1', '🔥', 'u2', 'Kai'); s.add('m1', '❤️', 'u1', 'Mara');
  ok('store: records who reacted with what', s.users('m1', '🔥').map((u) => u.name).join() === 'Mara,Kai');
  s.remove('m1', '🔥', 'u1');
  ok('store: remove drops one reactor', s.users('m1', '🔥').map((u) => u.id).join() === 'u2');
  s.remove('m1', '🔥', 'u2'); s.remove('m1', '❤️', 'u1');
  ok('store: an emptied message is forgotten', s.size === 0);
  s.add('a', '🔥', 'u', 'x'); s.add('b', '🔥', 'u', 'x'); s.add('c', '🔥', 'u', 'x');
  s.add('a', '👍', 'u', 'x'); // refreshes a
  s.add('d', '🔥', 'u', 'x'); // evicts the least recently used: b
  ok('store: capped, least recently used goes first', s.size === 3 && s.users('b', '🔥').length === 0 && s.users('a', '🔥').length === 1);
  s.clear('a'); ok('store: clear forgets a message', s.users('a', '🔥').length === 0);
}

// ── unknown reactors never leak an ignored user's count ─────────────────────
{
  const store = new ReactionStore();
  store.add('m9', '🔥', GUEST, 'Bones');
  const cx = { isOwner: (id: string) => id === OWNER, botId: BOT, ignored: [HIDDEN], store };
  const rs = buildReactions(fakeMsg('m9', [['🔥', 2], ['🎉', 1]]), cx)!;
  ok('reactions: unidentified reactors are not counted when an ignore list is active', rs.length === 1 && rs[0].count === 1);
  ok('reactions: no ignore list keeps the cached count', buildReactions(fakeMsg('m9', [['🎉', 1]]), { isOwner: () => false, store })![0].count === 1);
}

// ── transcript suffix, hidden authors ───────────────────────────────────────
{
  const store = new ReactionStore();
  store.add('m1', '🔥', OWNER, 'Boss'); store.add('m1', '🔥', GUEST, 'Bones'); store.add('m1', '🔥', HIDDEN, 'Ghost');
  store.add('m1', '❤️', HIDDEN, 'Ghost');
  const ctx = { isOwner: (id: string) => id === OWNER, botId: BOT, ignored: [HIDDEN], store };
  const rs = buildReactions(fakeMsg('m1', [['🔥', 3], ['❤️', 1]]), ctx)!;
  ok('reactions: a hidden author is subtracted from the count', rs.find((r) => r.emoji === '🔥')?.count === 2);
  ok('reactions: an emoji only a hidden author used disappears', !rs.some((r) => r.emoji === '❤️'));
  ok('reactions: owner shown as the owner label, byOwner set', rs[0].byOwner && rs[0].names[0] === identity.owner_label && rs[0].names[1] === 'Bones');
  ok('reactions: a hidden name never appears', !JSON.stringify(rs).includes('Ghost'));
  const base: WindowMessage = { id: 'm1', authorId: GUEST, authorName: 'Mara', content: 'hi', isFromOwner: false, isFromMe: false, timestampMs: 1 };
  const withR = formatTranscriptMessage({ ...base, reactions: rs });
  ok('suffix: compact, with counts and names', withR.endsWith(` [reactions: 🔥2 (${identity.owner_label}, Bones)]`));
  ok('suffix: absent without reactions', formatTranscriptMessage(base) === formatTranscriptMessage({ ...base, reactions: [] }) && !formatTranscriptMessage(base).includes('reactions'));
  ok('reactions: none on the message gives undefined', buildReactions(fakeMsg('x', []), ctx) === undefined);
  const many = new ReactionStore();
  for (const [i, n] of ['a', 'b', 'c', 'd', 'e'].entries()) many.add('m2', '🔥', `u${i}`, n);
  ok('reactions: at most 3 names per emoji', buildReactions(fakeMsg('m2', [['🔥', 5]]), { isOwner: () => false, store: many })![0].names.length === 3);
  const custom = new ReactionStore();
  ok('reactions: a custom emoji renders as :name:', buildReactions(fakeMsg('m3', [['<:wave:123456789012345678>', 1]]), { isOwner: () => false, store: custom })![0].emoji === ':wave:');
}

// ── owner reaction on my message is visible in the NEXT window ──────────────
{
  const store = new ReactionStore();
  const mine = fakeMsg('bot-msg', [['💛', 1]]);
  ok('notice: before the reaction event, nothing is known', buildReactions(fakeMsg('bot-msg', []), { isOwner: (i) => i === OWNER, store }) === undefined);
  store.add('bot-msg', '💛', OWNER, 'Boss');
  const rs = buildReactions(mine, { isOwner: (i) => i === OWNER, botId: BOT, store })!;
  ok('notice: next window shows the owner reacted', rs[0].byOwner && formatTranscriptMessage({ id: 'bot-msg', authorId: BOT, authorName: 'B', content: 'x', isFromOwner: false, isFromMe: true, timestampMs: 1, reactions: rs }).includes(`💛1 (${identity.owner_label})`));
}

// ── emoji check ─────────────────────────────────────────────────────────────
ok('emoji: one unicode emoji passes', normalizeReactionEmoji('🔥') === '🔥' && normalizeReactionEmoji(' ❤️ ') === '❤️' && normalizeReactionEmoji('👍🏽') === '👍🏽');
ok('emoji: null / text / several / empty are refused', [null, 'null', 'nice', '🔥🔥', '', undefined, 5].every((v) => normalizeReactionEmoji(v) === null));
ok('emoji: a custom tag or :shortcode: passes through for the send site to check', normalizeReactionEmoji('<:wave:123456789012345678>') !== null && normalizeReactionEmoji(':wave:') === ':wave:');

// ── judge / respond with react ──────────────────────────────────────────────
const NOW = 1_760_000_000_000;
function engineWith(replyText: string) {
  const provider: ModelProvider = {
    singleModel: true,
    identity: { engine: 'test', model: 'test-model' },
    async complete() { return { ok: true, text: replyText, engine: 'test', model: 'test-model' }; },
    async prepare() { return null; },
    async postComplete() { throw new Error('not used'); },
  };
  const engine = new PresenceEngine('http://sanctum.invalid', 'k', 'PERSONA', () => NOW, undefined, undefined, undefined, { get: async () => ({ ...PRESENCE_DEFAULTS }) } as any);
  engine.setModelProvider(provider);
  engine.setSelfId(BOT);
  return engine;
}
const win = (): WindowMessage[] => [{ id: 'g1', authorId: GUEST, authorName: 'Mara', content: 'I passed my exam!', isFromOwner: false, isFromMe: false, timestampMs: NOW - 30_000 }];
{
  const j = await engineWith('{"speak": false, "reason": "a reaction says enough", "message": null, "react": "🎉"}').judge('900000000000000011', 'room', win(), undefined, [], 'balanced' as any);
  ok('judge: react parsed, no speech', j.react === '🎉' && j.speak === false && j.message === null);
  const j2 = await engineWith('{"speak": true, "reason": "r", "message": "well done", "react": "nonsense"}').judge('900000000000000012', 'room', win(), undefined, [], 'balanced' as any);
  ok('judge: a non-emoji react is dropped, speech kept', j2.react === null && j2.speak === true && j2.message === 'well done');
  const j3 = await engineWith('{"speak": true, "reason": "r", "message": "well done"}').judge('900000000000000013', 'room', win(), undefined, [], 'balanced' as any);
  ok('judge: no react field is fine', !j3.react);
  const r = await engineWith('Congratulations!\nREACT: 🎉').respond('room', win(), undefined, false, [], '900000000000000014', 'I passed');
  ok('respond: REACT line parsed and stripped', r.react === '🎉' && r.text === 'Congratulations!');
  const r2 = await engineWith('Congratulations!\nREACT: 🎉\nSTICKER: wave').respond('room', win(), undefined, false, [{ id: '100000000000000998', name: 'wave', description: '' }], '900000000000000015', 'x');
  ok('respond: REACT and STICKER lines both stripped', r2.react === '🎉' && r2.stickerId === '100000000000000998' && r2.text === 'Congratulations!');
  const r3 = await engineWith('Congratulations!\nREACT: not an emoji').respond('room', win(), undefined, false, [], '900000000000000016', 'x');
  ok('respond: a bad REACT line is stripped, no reaction', r3.react === null && r3.text === 'Congratulations!');
  const r4 = await engineWith('REACT: 🎉').respond('room', win(), undefined, false, [], '900000000000000017', 'x');
  ok('respond: a reaction-only reply keeps react with empty text', r4.react === '🎉' && r4.text === '');
  const e = engineWith('{}');
  const ch = '900000000000000099';
  let allowed = 0;
  for (let i = 0; i < 10; i++) { if (e.reactionAllowed(ch)) { allowed++; e.recordReacted(ch); } }
  ok(`rate: ${REACTIONS_PER_CHANNEL_PER_HOUR} reactions per channel per hour`, allowed === 6 && !e.reactionAllowed(ch) && e.reactionAllowed('other-channel'));
}

// ── the send site: reactTo ──────────────────────────────────────────────────
function client(ignored: string[] = []) {
  const dc: any = new DiscordClient(OWNER);
  dc.botUserId = BOT;
  dc.presenceConfig = { getCached: () => ({ ...PRESENCE_DEFAULTS, ignored_user_ids: ignored }) };
  const calls: Array<[string, string, string]> = [];
  dc.addReaction = async (c: string, m: string, e: string) => { calls.push([c, m, e]); return true; };
  return { dc, calls };
}
const gate = () => { const e = engineWith('{}'); return e; };
{
  const { dc, calls } = client([HIDDEN]);
  const g = gate();
  ok('reactTo: reacts once to a guest message', await dc.reactTo('c1', { id: 'm1', authorId: GUEST }, '🎉', g) === true && calls.length === 1 && calls[0][2] === '🎉');
  ok('reactTo: never on my own message', await dc.reactTo('c1', { id: 'm2', authorId: BOT }, '🎉', g) === false && await dc.reactTo('c1', { id: 'm2', isFromMe: true }, '🎉', g) === false && calls.length === 1);
  ok('reactTo: never on a hidden author', await dc.reactTo('c1', { id: 'm3', authorId: HIDDEN }, '🎉', g) === false && calls.length === 1);
  ok('reactTo: a bad emoji or no react does nothing', await dc.reactTo('c1', { id: 'm4', authorId: GUEST }, 'hello', g) === false && await dc.reactTo('c1', { id: 'm4', authorId: GUEST }, null, g) === false && calls.length === 1);
  ok('reactTo: a custom emoji the bot cannot use is refused', await dc.reactTo('c1', { id: 'm5', authorId: GUEST }, '<:nope:123456789012345678>', g) === false && calls.length === 1);
  for (let i = 0; i < 10; i++) await dc.reactTo('c2', { id: `x${i}`, authorId: GUEST }, '👍', g);
  ok('reactTo: stops at 6 per channel per hour', calls.filter((c) => c[0] === 'c2').length === 6);
}

// ── concurrency: the cap is reserved before the await; the lock is claimed before output ──
{
  const { dc, calls } = client();
  const g = gate();
  dc.addReaction = async (c: string, m: string, e: string) => { await new Promise((r) => setTimeout(r, 10)); calls.push([c, m, e]); return true; };
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => dc.reactTo('cc', { id: `p${i}`, authorId: GUEST }, '👍', g)));
  ok('concurrent reactTo: never exceeds 6 per channel per hour', results.filter(Boolean).length === 6 && calls.length === 6);
}
{
  const { dc } = client();
  const g = gate();
  dc.addReaction = async () => false;
  for (let i = 0; i < 10; i++) await dc.reactTo('cf', { id: `f${i}`, authorId: GUEST }, '👍', g);
  dc.addReaction = async () => true;
  ok('failed reactions roll their slot back', await dc.reactTo('cf', { id: 'ok', authorId: GUEST }, '👍', g) === true);
  dc.addReaction = async () => { throw new Error('boom'); };
  for (let i = 0; i < 10; i++) await dc.reactTo('cx', { id: `t${i}`, authorId: GUEST }, '👍', g).catch(() => {});
  ok('a throwing addReaction also rolls back', g.tryReserveReaction('cx') !== null);
}
{
  const src = (await import('node:fs')).readFileSync(new URL('./cloud-server.ts', import.meta.url), 'utf8');
  const a = src.indexOf('speakerLock.tryClaimSpeaker(event.message.id)');
  const b = src.indexOf('discordClient.reactTo(event.channelId, { id: event.message.id');
  ok('mention path claims the speaker lock before reacting', a > 0 && b > a);
}

// ── a reaction-only decision through considerChannel posts nothing ──────────
{
  const { dc, calls } = client([HIDDEN]);
  dc.presenceSettled = true;
  dc.getStickerRoster = async () => [];
  dc.getPresenceConfig = async () => ({ ...PRESENCE_DEFAULTS, ignored_user_ids: [HIDDEN] });
  const t = (id: string, authorId: string, ts: number) => ({
    id, author: { id: authorId, username: 'u', globalName: 'U', tag: 'u#0' }, member: { displayName: 'U' }, content: `m-${id}`,
    createdTimestamp: ts, guildId: null, channelId: '700000000000000103', attachments: new Map(), reference: null,
    mentions: { has: () => false, users: new Map(), members: new Map() },
  });
  dc.getRecentMessages = async () => [t('1', GUEST, 1000), t('2', HIDDEN, 2000)];
  let sent = 0, recorded = 0, reactedGate = 0;
  dc.sendMessage = async () => { sent++; return { id: 'sent' }; };
  dc.ambientEngine = {
    judge: async () => ({ speak: false, reason: 'a reaction says enough', message: null, stickerId: null, react: '🎉' }),
    recordSpoke: () => { recorded++; },
    tryReserveReaction: () => { reactedGate++; return 1; },
    releaseReaction: () => {},
  };
  dc.ambientMemory = { peekMemoryContext: async () => ({}) };
  await dc.considerChannel('700000000000000103', 'room', {});
  ok('reaction-only: posts nothing, spends no speak budget', sent === 0 && recorded === 0);
  ok('reaction-only: addReaction called once, on the newest visible message (not the hidden one)', calls.length === 1 && calls[0][1] === '1' && reactedGate === 1);
}

// ── P1: reactions obey the one-answer-per-message lock in considerChannel ───
{
  const mk = (judgeResult: any) => {
    const { dc, calls } = client();
    dc.presenceSettled = true;
    dc.getStickerRoster = async () => [];
    dc.getPresenceConfig = async () => ({ ...PRESENCE_DEFAULTS });
    const m = (id: string, authorId: string, ts: number) => ({
      id, author: { id: authorId, username: 'u', globalName: 'U', tag: 'u#0' }, member: { displayName: 'U' }, content: `m-${id}`,
      createdTimestamp: ts, guildId: null, channelId: '700000000000000103', attachments: new Map(), reference: null,
      mentions: { has: () => false, users: new Map(), members: new Map() },
    });
    dc.getRecentMessages = async () => [m('t1', GUEST, 1000)];
    let sent = 0;
    dc.sendMessage = async () => { sent++; return { id: 'sent' }; };
    dc.ambientEngine = { judge: async () => judgeResult, recordSpoke: () => {}, tryReserveReaction: () => 1, releaseReaction: () => {} };
    dc.ambientMemory = { peekMemoryContext: async () => ({}) };
    return { dc, calls, sent: () => sent };
  };
  const trigger = (id: string) => ({ id, authorId: GUEST, isFromOwner: false, isFromMe: false });
  {
    const t = mk({ speak: true, reason: 'r', message: 'hi', stickerId: null, react: '🎉' });
    ok('lock setup: the scene path claims first', speakerLock.tryClaimSpeaker('claimed-1') === true);
    await t.dc.considerChannel('700000000000000103', 'room', { triggerMessage: trigger('claimed-1'), claimMessageId: 'claimed-1' });
    ok('lock: already-claimed trigger gets neither a reaction nor speech', t.calls.length === 0 && t.sent() === 0);
  }
  {
    const t = mk({ speak: false, reason: 'r', message: null, stickerId: null, react: '🎉' });
    await t.dc.considerChannel('700000000000000103', 'room', { triggerMessage: trigger('free-1'), claimMessageId: 'free-1' });
    ok('lock: a reaction-only decision claims the lock and reacts once', t.calls.length === 1 && t.sent() === 0 && speakerLock.tryClaimSpeaker('free-1') === false);
  }
  {
    const t = mk({ speak: false, reason: 'r', message: null, stickerId: null, react: '🎉' });
    t.dc.addReaction = async () => false;
    await t.dc.considerChannel('700000000000000103', 'room', { triggerMessage: trigger('fail-1'), claimMessageId: 'fail-1' });
    ok('lock: a failed reaction-only decision releases the claim', speakerLock.tryClaimSpeaker('fail-1') === true);
  }
  {
    const t = mk({ speak: true, reason: 'r', message: 'hi', stickerId: null, react: '🎉' });
    await t.dc.considerChannel('700000000000000103', 'room', { triggerMessage: trigger('both-1'), claimMessageId: 'both-1' });
    ok('lock: react plus words under one claim does both once', t.calls.length === 1 && t.sent() === 1);
  }
}

// ── P1: a reaction-only owner-mention reply is a success, not a failure ─────
{
  ok('mention outcome: text is a reply', mentionReplyOutcome({ text: 'hi', reactionLanded: false }) === 'text');
  ok('mention outcome: reaction-only that landed is a success', mentionReplyOutcome({ text: '', reactionLanded: true }) === 'reaction');
  ok('mention outcome: no text and a failed reaction is a failure', mentionReplyOutcome({ text: '', reactionLanded: false }) === 'failure');
  const src = (await import('node:fs')).readFileSync(new URL('./cloud-server.ts', import.meta.url), 'utf8');
  const a = src.indexOf("mentionReplyOutcome({ text: reply.text, reactionLanded }) === 'reaction'");
  const b = src.indexOf("reportMentionFailure(event, 'sanctum_empty_reply')");
  ok('mention path: the reaction-success branch precedes the failure alert', a > 0 && b > a);
  ok('mention path: reactionLanded is set from reactTo', /reactionLanded = reacted/.test(src));
}

// ── sweep: a reaction-only answer advances the cursor (one reaction across two sweeps) ──
{
  const { dc, calls } = client();
  dc.presenceSettled = true;
  dc.botUserId = BOT;
  dc.getStickerRoster = async () => [];
  dc.getPresenceConfig = async () => ({ ...PRESENCE_DEFAULTS });
  let sent = 0, responds = 0;
  dc.sendMessage = async () => { sent++; return { id: 'sent' }; };
  dc.ambientEngine = {
    respond: async () => { responds++; return { text: '', stickerId: null, react: '🎉' }; },
    judge: async () => ({ speak: false, reason: 'quiet', message: null, stickerId: null }),
    recordSpoke: () => {}, tryReserveReaction: () => 1, releaseReaction: () => {},
  };
  dc.ambientMemory = { peekMemoryContext: async () => ({}) };
  const CH = '700000000000000103';
  const mention = {
    id: '800000000000000001', author: { id: GUEST, username: 'mara', globalName: 'Mara', tag: 'mara#0' }, member: { displayName: 'Mara' },
    content: 'hey @bot', createdTimestamp: 1000, guildId: null, channelId: CH, attachments: new Map(), reference: null,
    mentions: { has: (id: string) => id === BOT },
  };
  dc.client = { channels: { fetch: async () => ({ type: ChannelType.GuildText, name: 'hall', messages: { fetch: async () => new Map([[mention.id, mention]]) } }) } };
  for (let i = 0; i < 2; i++) { dc.ambientDirtyChannels = new Set([CH]); await dc.runAmbientSweep(); }
  ok('sweep: reaction-only answer to one mention reacts exactly once across two sweeps', calls.length === 1 && responds === 1 && sent === 0);
}

// ── transcript suffix: order, no cap, spelling ──────────────────────────────
{
  const sfx = (emojis: string[]) => formatReactionSuffix(emojis.map((emoji) => ({ emoji, count: 1, byOwner: false, names: [] })));
  ok('spell: 🇭🇪🇱🇱🇴 spells HELLO', sfx(['🇭', '🇪', '🇱', '🇱', '🇴']).endsWith('(spells "HELLO")]'));
  ok('spell: Discord allows each emoji once per message, so a real cache with 🇭🇪🇱🇴 spells HELO (a repeated letter cannot appear twice)', sfx(['🇭', '🇪', '🇱', '🇴']).endsWith('(spells "HELO")]'));
  ok('spell: 🅰️ 🅱️ 🅾️ 🅿️ ℹ️ Ⓜ️ and keycaps map to letters', sfx(['🅰️', '🅱️', '🅾️', '🅿️', 'ℹ️', 'Ⓜ️', '1️⃣']).includes('(spells "ABOPIM1")'));
  ok('spell: non-letter reactions keep their place but are skipped', sfx(['🇭', '🔥', '🇮']).startsWith(' [reactions: 🇭1 🔥1 🇮1') && sfx(['🇭', '🔥', '🇮']).includes('(spells "HI")'));
  ok('spell: a single letter spells nothing', !sfx(['🇭', '🔥']).includes('spells'));
  ok('spell: no letters, no spelling', !sfx(['🔥', '❤️']).includes('spells'));
  const many = Array.from({ length: 25 }, (_, i) => String.fromCodePoint(0x1f600 + i));
  ok('suffix: 25 distinct emoji are all shown, in order', many.every((e) => sfx(many).includes(e)) && sfx(many).indexOf(many[0]) < sfx(many).indexOf(many[24]));
  const cacheOrder = buildReactions(fakeMsg('ord', [['🇭', 1], ['🔥', 1], ['🇮', 1]]), { isOwner: () => false, store: new ReactionStore() })!;
  ok('reactions: cache (first-added) order is preserved', cacheOrder.map((r) => r.emoji).join('') === '🇭🔥🇮');
}

console.log(`\n${fail === 0 ? 'all pass' : `${fail} failed`}`);
if (fail > 0) process.exit(1);
