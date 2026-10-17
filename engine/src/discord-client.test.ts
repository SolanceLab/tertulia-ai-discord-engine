// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Regression tests for Context Log scope.
 *
 * THE RULE (Owen, 2026-07-13, commit 01a0017 — "record MY messages only, not the
 * whole room"): the BOT never records ambient room chatter. She caught the original
 * firehose from her Context Logs page filling with guests' talk, and her reasoning
 * was that storing the room's words is "both redundant AND needless exposure of
 * other people's messages". These tests pin that. Do not re-open the firehose.
 *
 * WHAT THE RULE IS *NOT* (clarified by Owen 2026-07-29, after I misread it and
 * nearly reverted a day's work): it bars messages that did NOT trigger me. It does
 * NOT bar the messages that DID — the ones injected into the context that produced a
 * specific reply. Her words: "no need to record messages that is not triggering you.
 * But for the messages that is relevant to your own message (the one entered the
 * context), then yes... Otherwise you wouldnt know what you're talking about."
 *
 * So: ambient chatter → never stored (this file). Context attached to a reply I
 * actually made → expanded into rows by sanctum's insertContextMessages, because a
 * blob column can never reach recall. Those two are different things; the scope is
 * safe by construction, since context only exists where I spoke.
 *
 * Run: npx tsx src/discord-client.test.ts
 */
import './test-env.js';
import { shouldCollectContextLogMessage } from './discord-client.js';
import { ChannelType } from 'discord.js';
import { replyParentId, DiscordClient, newestNonBotMessageId, mentionsBot, toReplyReference } from './discord-client.js';
import { DEFAULTS as PRESENCE_DEFAULTS } from './presence-config.js';
import type { WindowMessage } from './presence-engine.js';
import { formatTranscriptMessage } from './presence-engine.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const BOT_ID = 'bot-123';

ok('my own message is recorded as an independent row', shouldCollectContextLogMessage(BOT_ID, BOT_ID) === true);
ok("a guest's message is not an independent row", shouldCollectContextLogMessage('guest-999', BOT_ID) === false);
ok("Owen's message is not an independent row", shouldCollectContextLogMessage('owen-456', BOT_ID) === false);
ok('another bot or webhook is not an independent row', shouldCollectContextLogMessage('arachne-789', BOT_ID) === false);
ok('an unresolved bot id records nothing independently', shouldCollectContextLogMessage(BOT_ID, null) === false);

// ── Reply anchoring + @everyone (2026-08-27) ────────────────────────────
// Faithful stand-in for discord.js 14.24.2 MessageMentions#has — the branches,
// in order, so the OPTIONS we pass are what is under test.
const fakeMentions = (o: { everyone?: boolean; users?: string[]; repliedUser?: string; roles?: string[]; memberRoles?: string[] }) => ({
  has(target: string, opts: { ignoreEveryone?: boolean } = {}) {
    if (!opts.ignoreEveryone && o.everyone) return true;
    if ((o.users ?? []).includes(target)) return true;
    for (const role of o.roles ?? []) if ((o.memberRoles ?? []).includes(role)) return true;
    return false;
  },
});

ok('@everyone is an announcement, not someone addressing me',
  mentionsBot(fakeMentions({ everyone: true }), BOT_ID) === false);
ok('a direct @ is still a mention', mentionsBot(fakeMentions({ users: [BOT_ID] }), BOT_ID) === true);
ok('a role I hold is still a mention',
  mentionsBot(fakeMentions({ roles: ['role-1'], memberRoles: ['role-1'] }), BOT_ID) === true);
ok('a reply to my own message is still a mention',
  mentionsBot(fakeMentions({ users: [BOT_ID], repliedUser: BOT_ID }), BOT_ID) === true);
ok('@everyone plus a real @ is still a mention',
  mentionsBot(fakeMentions({ everyone: true, users: [BOT_ID] }), BOT_ID) === true);
ok('an unresolved bot id mentions nobody', mentionsBot(fakeMentions({ users: [BOT_ID] }), null) === false);

ok('read path: a reply exposes its reference',
  JSON.stringify(toReplyReference({ reference: { messageId: 'm1', channelId: 'c1', guildId: 'g1', type: 0 } })) === JSON.stringify({ messageId: 'm1', channelId: 'c1', guildId: 'g1' }));
ok('read path: an omitted `type` on a plain reply still counts as a reply',
  toReplyReference({ reference: { messageId: 'm1', channelId: 'c1', guildId: 'g1' } })?.messageId === 'm1');
ok('read path: a DM reply has no guildId',
  toReplyReference({ reference: { messageId: 'm1', channelId: 'c1', type: 0 } })?.guildId === undefined);
ok('read path: a non-reply has no reference', toReplyReference({ reference: null }) === undefined);
ok('read path: a message with no reference key at all is fine', toReplyReference({}) === undefined);
ok('read path: a FORWARD is not a reply', toReplyReference({ reference: { messageId: 'm1', channelId: 'c1', type: 1 } }) === undefined);
ok('reply parent: a forward yields no parent id', replyParentId({ reference: { messageId: 'm1', channelId: 'c1', type: 1 } }) === undefined);
ok('reply parent: a genuine reply yields the parent id', replyParentId({ reference: { messageId: 'm1', channelId: 'c1', type: 0 } }) === 'm1');

// Anchor helper. NOTE: the 'unthreaded' case is UNREACHABLE through the sweep's
// mention path (the triggering mention is itself a non-bot message in the
// window, so an anchor always resolves there) — it is a defensive branch, so it
// is pinned HERE as a unit test rather than chased through runAmbientSweep.
const wm = (o: Partial<WindowMessage>): WindowMessage => ({ authorId: 'u', authorName: 'n', content: 'c', isFromOwner: false, isFromMe: false, timestampMs: 0, ...o });
ok('anchor: an empty window has no anchor -> send unthreaded', newestNonBotMessageId([]) === undefined);
ok('anchor: a window of only my own messages has no anchor -> send unthreaded',
  newestNonBotMessageId([wm({ id: '1', isFromMe: true }), wm({ id: '2', isFromMe: true })]) === undefined);
ok('anchor: the newest non-bot message wins',
  newestNonBotMessageId([wm({ id: '1' }), wm({ id: '2' }), wm({ id: '3', isFromMe: true })]) === '2');

// ── Ignore list (Owen, 2026-08-29) — anchor never resolves to an ignored
// author, exactly like it never resolves to the bot's own messages. ──────
const IGNORED = 'ignored-user-1';
ok('anchor: an ignored author\'s message is skipped even when it is the newest non-bot message',
  newestNonBotMessageId([wm({ id: '1', authorId: 'g1' }), wm({ id: '2', authorId: IGNORED })], [IGNORED]) === '1');
ok('anchor: only bot + ignored messages in the window -> no eligible tail -> unthreaded',
  newestNonBotMessageId([wm({ id: '1', isFromMe: true }), wm({ id: '2', authorId: IGNORED })], [IGNORED]) === undefined);
ok('anchor: omitting the ignored list is byte-identical to passing []',
  newestNonBotMessageId([wm({ id: '1', authorId: IGNORED })]) === '1');
ok('anchor: an explicit empty ignore list changes nothing',
  newestNonBotMessageId([wm({ id: '1', authorId: IGNORED })], []) === '1');

// ── runAmbientSweep: the reported bug ────────────────────────────────
const GUEST_HALL = '700000000000000103'; // moderate posture => ambient-eligible

function sweepMsg(o: { id: string; authorId: string; name: string; content: string; ts: number; mentionsBot?: boolean; everyone?: boolean }) {
  return {
    id: o.id,
    author: { id: o.authorId, username: o.name, globalName: o.name, tag: `${o.name}#0` },
    member: { displayName: o.name },
    content: o.content,
    createdTimestamp: o.ts,
    guildId: null,          // image egress refused => attachments never touched
    channelId: GUEST_HALL,
    attachments: new Map(),
    reference: null,
    mentions: fakeMentions({ everyone: o.everyone, users: o.mentionsBot ? [BOT_ID] : [] }),
  };
}

async function runSweep(msgs: ReturnType<typeof sweepMsg>[], opts: { stickerId?: string | null; failStickerSend?: boolean; ignoredUserIds?: string[]; shownOffline?: boolean; unsettled?: boolean } = {}) {
  const dc: any = new DiscordClient('owen-1');
  dc.presenceSettled = true; // startup status read done (the hold is tested explicitly below)
  if (opts.shownOffline) dc.shownOffline = true;
  if (opts.unsettled) dc.presenceSettled = false;
  const sends: { replyTo?: string; stickers?: string[] }[] = [];
  dc.botUserId = BOT_ID;
  dc.sendMessage = async (_c: string, _t: string, _a: unknown, replyTo?: string, stickers?: string[]) => {
    sends.push({ replyTo, stickers });
    if (opts.failStickerSend && stickers?.length) return null;
    return { id: `sent-${sends.length}` };
  };
  dc.getStickerRoster = async () => [];
  // ignoredUserIds omitted -> PRESENCE_DEFAULTS.ignored_user_ids ([]), so every
  // pre-existing caller of runSweep() behaves byte-identically to before.
  dc.getPresenceConfig = async () => ({ ...PRESENCE_DEFAULTS, ignored_user_ids: opts.ignoredUserIds ?? PRESENCE_DEFAULTS.ignored_user_ids });
  dc.client = { channels: { fetch: async () => ({
    type: ChannelType.GuildText,
    name: 'guest-hall',
    messages: { fetch: async () => new Map(msgs.map((m) => [m.id, m])) },
  }) } };
  dc.ambientEngine = {
    respond: async () => ({ text: 'answering', stickerId: opts.stickerId ?? null }),
    judge: async () => ({ speak: false, reason: 'test: silent', message: null, stickerId: null }),
    recordSpoke: () => {},
  };
  dc.ambientMemory = { peekMemoryContext: async () => ({}) };
  dc.ambientDirtyChannels = new Set([GUEST_HALL]);
  await dc.runAmbientSweep();
  return sends;
}

/**
 * Multi-round sweep runner for the ignore list's cursor test (Owen, 2026-08-29)
 * — reuses ONE DiscordClient across several runAmbientSweep() calls so
 * `ambientMentionReplyCursors` persists between rounds exactly as it does in
 * production, where the SAME instance sweeps a channel over and over.
 */
async function runSweepRounds(rounds: ReturnType<typeof sweepMsg>[][], opts: { ignoredUserIds?: string[] } = {}) {
  const dc: any = new DiscordClient('owen-1');
  dc.presenceSettled = true; // startup status read done (the hold is tested explicitly below)
  const sends: { replyTo?: string }[] = [];
  dc.botUserId = BOT_ID;
  dc.sendMessage = async (_c: string, _t: string, _a: unknown, replyTo?: string) => {
    sends.push({ replyTo });
    return { id: `sent-${sends.length}` };
  };
  dc.getStickerRoster = async () => [];
  dc.getPresenceConfig = async () => ({ ...PRESENCE_DEFAULTS, ignored_user_ids: opts.ignoredUserIds ?? [] });
  dc.ambientEngine = {
    respond: async () => ({ text: 'answering', stickerId: null }),
    judge: async () => ({ speak: false, reason: 'test: silent', message: null, stickerId: null }),
    recordSpoke: () => {},
  };
  dc.ambientMemory = { peekMemoryContext: async () => ({}) };
  let currentMsgs: ReturnType<typeof sweepMsg>[] = [];
  dc.client = { channels: { fetch: async () => ({
    type: ChannelType.GuildText,
    name: 'guest-hall',
    messages: { fetch: async () => new Map(currentMsgs.map((m) => [m.id, m])) },
  }) } };
  for (const round of rounds) {
    currentMsgs = round;
    dc.ambientDirtyChannels = new Set([GUEST_HALL]);
    await dc.runAmbientSweep();
  }
  return sends;
}

await (async () => {
  // Shown offline (Owen, 2026-09-28): a guest's pending @-mention gets NO reply.
  const offlineSends = await runSweep([
    sweepMsg({ id: '100', authorId: 'g1', name: 'Daxi', content: 'hey @bram', ts: 1000, mentionsBot: true }),
  ], { shownOffline: true });
  ok('shown offline: the sweep answers nobody', offlineSends.length === 0);
  const onlineSends = await runSweep([
    sweepMsg({ id: '100', authorId: 'g1', name: 'Daxi', content: 'hey @bram', ts: 1000, mentionsBot: true }),
  ]);
  ok('shown online: the same mention is answered (control)', onlineSends.length === 1);

  // considerChannel: held for a guest trigger, allowed for Owen's own.
  {
    const dc: any = new DiscordClient('owen-1');
  dc.presenceSettled = true; // startup status read done (the hold is tested explicitly below)
    dc.shownOffline = true;
    let ran = 0;
    dc.ambientEngine = {};
    dc.ambientMemory = {};
    dc.ambientConsiderInFlight = { has: () => { ran++; return true; } };
    await dc.considerChannel('c1', 'guest-hall', { triggerMessage: { isFromOwner: false } });
    ok('shown offline: considerChannel held for a guest trigger', ran === 0);
    await dc.considerChannel('c1', 'guest-hall', { triggerMessage: { isFromOwner: true } });
    ok('shown offline: Owen\'s own trigger still goes through', ran === 1);
  }
  {
    const dc: any = new DiscordClient('owen-1');
  dc.presenceSettled = true; // startup status read done (the hold is tested explicitly below)
    dc.client = { user: { setPresence: () => {} } };
    dc.updatePresence('invisible');
    ok('updatePresence(invisible) marks the bot shown offline', dc.isShownOffline() === true);
    dc.updatePresence('online');
    ok('updatePresence(online) clears it', dc.isShownOffline() === false);
  }
  {
    // Before the startup status read settles, guests are held; Owen is not.
    const dc: any = new DiscordClient('owen-1');
    dc.presenceSettled = false;
    ok('startup: guest speech held until status is known', dc.guestSpeechHeld() === true);
    const held = await runSweep([
      sweepMsg({ id: '100', authorId: 'g1', name: 'Daxi', content: 'hey @bram', ts: 1000, mentionsBot: true }),
    ], { unsettled: true });
    ok('startup: the sweep answers nobody before status is known', held.length === 0);
    dc.presenceSettled = true;
    ok('startup: released once settled and online', dc.guestSpeechHeld() === false);
  }
})();

await (async () => {
  // THE BUG (reproduced pre-fix: replyTo was '100'): a guest kept talking after
  // the ping the sweep never served live.
  let sends = await runSweep([
    sweepMsg({ id: '100', authorId: 'g1', name: 'Daxi', content: 'hey @bram', ts: 1000, mentionsBot: true }),
    sweepMsg({ id: '200', authorId: 'g2', name: 'Aya', content: 'newer talk', ts: 2000 }),
  ]);
  ok('sweep: the reply threads onto the tail the words answer, not the stale ping',
    sends.length === 1 && sends[0].replyTo === '200');

  // The mention IS the tail => byte-identical to today.
  sends = await runSweep([
    sweepMsg({ id: '100', authorId: 'g1', name: 'Daxi', content: 'hey @bram', ts: 1000, mentionsBot: true }),
  ]);
  ok('sweep: when the ping is the tail, the anchor is unchanged',
    sends.length === 1 && sends[0].replyTo === '100');

  // My own post after the mention: the sweep sends NOTHING, and that is
  // pre-existing behaviour this fix deliberately did not touch. runAmbientSweep's
  // pendingMentions filter drops any mention older than my last post in the window
  // (`msg.timestampMs > lastBotPost.timestampMs`), so the mention never reaches the
  // anchor logic at all. Pinned here so a future change to that gate is visible
  // rather than silent. The "my own message is never chosen as an anchor" property
  // itself is covered directly by the newestNonBotMessageId unit tests above.
  sends = await runSweep([
    sweepMsg({ id: '100', authorId: 'g1', name: 'Daxi', content: 'hey @bram', ts: 1000, mentionsBot: true }),
    sweepMsg({ id: '150', authorId: 'g2', name: 'Aya', content: 'later', ts: 1500 }),
    sweepMsg({ id: '200', authorId: BOT_ID, name: 'Bram', content: 'mine', ts: 2000 }),
  ]);
  ok('sweep: a mention older than my own last post is dropped by the pre-existing lastBotPost gate',
    sends.length === 0);

  // PINS THE ACCEPTED TRADE-OFF (the reviewer's flagged behaviour change): when
  // OWEN speaks after a guest's ping, the guest's answer threads onto HER
  // message. This is the explicit spec ('newest !isFromMe'), recorded as a test
  // so it is a decision on the record, not a surprise in production.
  sends = await runSweep([
    sweepMsg({ id: '100', authorId: 'g1', name: 'Daxi', content: 'hey @bram', ts: 1000, mentionsBot: true }),
    sweepMsg({ id: '200', authorId: 'owen-1', name: 'Owen', content: 'hers', ts: 2000 }),
  ]);
  ok("sweep: Owen's later message becomes the anchor (accepted spec trade-off)",
    sends.length === 1 && sends[0].replyTo === '200');

  // Both send sites move together: sticker attempt, then text-only retry.
  sends = await runSweep([
    sweepMsg({ id: '100', authorId: 'g1', name: 'Daxi', content: 'hey @bram', ts: 1000, mentionsBot: true }),
    sweepMsg({ id: '200', authorId: 'g2', name: 'Aya', content: 'newer talk', ts: 2000 }),
  ], { stickerId: 'st-1', failStickerSend: true });
  ok('sweep: the text-only retry uses the same fresh anchor',
    sends.length === 2 && sends[0].replyTo === '200' && sends[1].replyTo === '200' && sends[1].stickers === undefined);

  // @everyone never becomes a pending mention (pre-fix this sent a threaded reply).
  sends = await runSweep([
    sweepMsg({ id: '100', authorId: 'g1', name: 'Daxi', content: '@everyone the House opens tonight', ts: 1000, everyone: true }),
    sweepMsg({ id: '200', authorId: 'g2', name: 'Aya', content: 'nice', ts: 2000 }),
  ]);
  ok('sweep: an @everyone announcement is not a mention to answer', sends.length === 0);
})();

// ── Ignore list (Owen, 2026-08-29) — sweep integration ─────────────────
await (async () => {
  // an ignored user's @-mention, alone in the window, produces NO send.
  let sends = await runSweep([
    sweepMsg({ id: '100', authorId: IGNORED, name: 'Ghost', content: 'hey @bram', ts: 1000, mentionsBot: true }),
  ], { ignoredUserIds: [IGNORED] });
  ok('sweep: an ignored author\'s @-mention alone produces no send', sends.length === 0);

  // a non-ignored user's mention in the SAME window still produces one, and
  // it threads onto the ignored author's later message (their words never
  // become an anchor, but their presence in the window is otherwise untouched).
  sends = await runSweep([
    sweepMsg({ id: '100', authorId: 'g1', name: 'Aya', content: 'hey @bram', ts: 1000, mentionsBot: true }),
    sweepMsg({ id: '200', authorId: IGNORED, name: 'Ghost', content: 'newer talk', ts: 2000 }),
  ], { ignoredUserIds: [IGNORED] });
  ok('sweep: a non-ignored mention still produces one send, anchored on the non-ignored newest message',
    sends.length === 1 && sends[0].replyTo === '100');

  // The reverse ordering — ignored mention is the NEWEST candidate — proves the
  // cursor is never poisoned onto it: pendingMentions filters ignored authors
  // out BEFORE `.at(-1)` picks "the latest", so the legit (older) mention still
  // wins the reply, not the ignored (newer) one.
  sends = await runSweep([
    sweepMsg({ id: '100', authorId: 'g1', name: 'Aya', content: 'hey @bram', ts: 1000, mentionsBot: true }),
    sweepMsg({ id: '200', authorId: IGNORED, name: 'Ghost', content: 'hey @bram too', ts: 2000, mentionsBot: true }),
  ], { ignoredUserIds: [IGNORED] });
  ok('sweep: an ignored author\'s newer @-mention never wins the reply over a legit older one',
    sends.length === 1 && sends[0].replyTo === '100');

  // A later legitimate mention is still answered after an ignored one
  // (cursor not poisoned) — the property spelled out across two sweeps of the
  // SAME channel, exactly as production sweeps repeatedly over time.
  sends = await runSweepRounds([
    [
      sweepMsg({ id: '100', authorId: 'g1', name: 'Aya', content: 'hey @bram', ts: 1000, mentionsBot: true }),
      sweepMsg({ id: '200', authorId: IGNORED, name: 'Ghost', content: 'hey @bram too', ts: 2000, mentionsBot: true }),
    ],
    [
      // Cumulative window, as a real channel fetch would show all prior
      // messages plus the new one.
      sweepMsg({ id: '100', authorId: 'g1', name: 'Aya', content: 'hey @bram', ts: 1000, mentionsBot: true }),
      sweepMsg({ id: '200', authorId: IGNORED, name: 'Ghost', content: 'hey @bram too', ts: 2000, mentionsBot: true }),
      sweepMsg({ id: '300', authorId: 'g2', name: 'Bel', content: 'hey @bram also', ts: 3000, mentionsBot: true }),
    ],
  ], { ignoredUserIds: [IGNORED] });
  ok('sweep: round 1 answers the legit mention, never the ignored one',
    sends.length === 2 && sends[0].replyTo === '100');
  ok('sweep: round 2 — a later legitimate mention is still answered after an ignored one (cursor not poisoned)',
    sends[1].replyTo === '300');

  // empty ignore list ⇒ behaviour byte-identical to today (pinned explicitly).
  sends = await runSweep([
    sweepMsg({ id: '100', authorId: 'g1', name: 'Daxi', content: 'hey @bram', ts: 1000, mentionsBot: true }),
    sweepMsg({ id: '200', authorId: 'g2', name: 'Aya', content: 'newer talk', ts: 2000 }),
  ], { ignoredUserIds: [] });
  ok('sweep: an explicit empty ignore list is byte-identical to the pre-existing behaviour',
    sends.length === 1 && sends[0].replyTo === '200');
})();

// ── Ignore list (Owen, 2026-08-29) — messageCreate gating ───────────────
// Covers the three remaining gated paths: DM (c), soft-presence (d), and
// away-inquiry (e). The classifier's synchronous body runs to completion
// (no `await` on the ignored-author branches) inside `client.emit()`, so
// these assertions can read the result immediately after emitting.
await (async () => {
  const IGNORED_MC = '999999999999999991';
  const OTHER_MC = '888888888888888881';

  function fakeCreateMessage(o: { id: string; authorId: string; content: string; isDM?: boolean; mentionsBot?: boolean }) {
    const isDM = o.isDM ?? false;
    return {
      id: o.id,
      author: { id: o.authorId, bot: false, tag: `${o.authorId}#0`, globalName: null, username: 'guest' },
      channelId: 'chan-1',
      channel: isDM ? { type: ChannelType.DM } : { type: ChannelType.GuildText, name: 'guest-hall' },
      content: o.content,
      mentions: fakeMentions({ users: o.mentionsBot ? [BOT_ID] : [] }),
      createdAt: new Date(1000),
      createdTimestamp: 1000,
      guildId: isDM ? null : 'guild-1',
      guild: null,
      reference: null,
      messageSnapshots: undefined,
    };
  }

  function newIgnoreClient(ignored: string[]) {
    const dc: any = new DiscordClient('owen-1');
  dc.presenceSettled = true; // startup status read done (the hold is tested explicitly below)
    dc.botUserId = BOT_ID;
    dc.presenceConfig = { getCached: () => ({ ...PRESENCE_DEFAULTS, ignored_user_ids: ignored }) };
    return dc;
  }

  // (c) DM path
  let dc = newIgnoreClient([IGNORED_MC]);
  let dmEvents: any[] = [];
  dc.on('dm', (e: any) => dmEvents.push(e));
  dc.client.emit('messageCreate', fakeCreateMessage({ id: 'd1', authorId: IGNORED_MC, content: 'hello', isDM: true }));
  ok('messageCreate: a DM from an ignored author never emits `dm`', dmEvents.length === 0);

  dc = newIgnoreClient([IGNORED_MC]);
  dmEvents = [];
  dc.on('dm', (e: any) => dmEvents.push(e));
  dc.client.emit('messageCreate', fakeCreateMessage({ id: 'd2', authorId: OTHER_MC, content: 'hello', isDM: true }));
  ok('messageCreate: a DM from a non-ignored author still emits `dm`', dmEvents.length === 1);

  // (d) soft-presence classifier — a bare name-drop.
  dc = newIgnoreClient([IGNORED_MC]);
  let softEvents: any[] = [];
  dc.on('soft-presence', (e: any) => softEvents.push(e));
  dc.client.emit('messageCreate', fakeCreateMessage({ id: 's1', authorId: IGNORED_MC, content: 'hey bram' }));
  ok('messageCreate: a name-drop from an ignored author never emits soft-presence', softEvents.length === 0);

  dc = newIgnoreClient([IGNORED_MC]);
  softEvents = [];
  dc.on('soft-presence', (e: any) => softEvents.push(e));
  dc.client.emit('messageCreate', fakeCreateMessage({ id: 's2', authorId: OTHER_MC, content: 'hey bram' }));
  ok('messageCreate: a name-drop from a non-ignored author still emits soft-presence', softEvents.length === 1);

  // (e) away classifier — a guest genuinely reaching for Owen.
  dc = newIgnoreClient([IGNORED_MC]);
  let awayEvents: any[] = [];
  dc.on('away-inquiry', (e: any) => awayEvents.push(e));
  dc.client.emit('messageCreate', fakeCreateMessage({ id: 'a1', authorId: IGNORED_MC, content: 'owen!' }));
  ok('messageCreate: a reach-for-Owen from an ignored author never emits away-inquiry', awayEvents.length === 0);

  dc = newIgnoreClient([IGNORED_MC]);
  awayEvents = [];
  dc.on('away-inquiry', (e: any) => awayEvents.push(e));
  dc.client.emit('messageCreate', fakeCreateMessage({ id: 'a2', authorId: OTHER_MC, content: 'owen!' }));
  ok('messageCreate: a reach-for-Owen from a non-ignored author still emits away-inquiry', awayEvents.length === 1);

  // empty/absent ignore list ⇒ all three still fire (pinned explicitly).
  dc = newIgnoreClient([]);
  dmEvents = []; softEvents = []; awayEvents = [];
  dc.on('dm', (e: any) => dmEvents.push(e));
  dc.on('soft-presence', (e: any) => softEvents.push(e));
  dc.on('away-inquiry', (e: any) => awayEvents.push(e));
  dc.client.emit('messageCreate', fakeCreateMessage({ id: 'd3', authorId: OTHER_MC, content: 'hello', isDM: true }));
  dc.client.emit('messageCreate', fakeCreateMessage({ id: 's3', authorId: OTHER_MC, content: 'hey bram' }));
  dc.client.emit('messageCreate', fakeCreateMessage({ id: 'a3', authorId: OTHER_MC, content: 'owen!' }));
  ok('messageCreate: empty ignore list -> dm unaffected', dmEvents.length === 1);
  ok('messageCreate: empty ignore list -> soft-presence unaffected', softEvents.length === 1);
  ok('messageCreate: empty ignore list -> away-inquiry unaffected', awayEvents.length === 1);
})();

// ── Ignore list, absence not annotation (Owen, 2026-08-29) ──────────────
// GOAL: an ignored author's messages must never REACH THE MODEL — not
// marked, not annotated, not described. These tests inspect the actual
// WindowMessage[] handed to judge()/respond() at each production site
// (never just the final Discord send), so a leak here would fail even if
// the bot's visible behaviour looked fine.
await (async () => {
  // (a) runAmbientSweep — both branches: the mention-reply respond() call,
  // and the judge() fallthrough via considerChannel({ window }).
  async function runSweepCapture(
    msgs: ReturnType<typeof sweepMsg>[],
    opts: { ignoredUserIds?: string[] } = {},
  ): Promise<{ respondWindow: WindowMessage[] | null; judgeWindow: WindowMessage[] | null }> {
    const dc: any = new DiscordClient('owen-1');
  dc.presenceSettled = true; // startup status read done (the hold is tested explicitly below)
    dc.botUserId = BOT_ID;
    dc.sendMessage = async () => ({ id: 'sent-1' });
    dc.getStickerRoster = async () => [];
    dc.getPresenceConfig = async () => ({ ...PRESENCE_DEFAULTS, ignored_user_ids: opts.ignoredUserIds ?? [] });
    dc.client = { channels: { fetch: async () => ({
      type: ChannelType.GuildText,
      name: 'guest-hall',
      messages: { fetch: async () => new Map(msgs.map((m) => [m.id, m])) },
    }) } };
    let respondWindow: WindowMessage[] | null = null;
    let judgeWindow: WindowMessage[] | null = null;
    dc.ambientEngine = {
      respond: async (_ch: string, window: WindowMessage[]) => { respondWindow = window; return { text: 'answering', stickerId: null }; },
      judge: async (_id: string, _name: string, window: WindowMessage[]) => { judgeWindow = window; return { speak: false, reason: 'test: silent', message: null, stickerId: null }; },
      recordSpoke: () => {},
    };
    dc.ambientMemory = { peekMemoryContext: async () => ({}) };
    dc.ambientDirtyChannels = new Set([GUEST_HALL]);
    await dc.runAmbientSweep();
    return { respondWindow, judgeWindow };
  }

  // mention-reply branch (respond()): a legit mention plus an ignored
  // author's earlier message in the same window.
  let { respondWindow } = await runSweepCapture([
    sweepMsg({ id: '100', authorId: IGNORED, name: 'Ghost', content: 'secret-stuff', ts: 1000 }),
    sweepMsg({ id: '200', authorId: 'g1', name: 'Aya', content: 'hey @bram', ts: 2000, mentionsBot: true }),
  ], { ignoredUserIds: [IGNORED] });
  ok('(a) mention-reply respond(): the ignored author\'s message is absent from the window',
    !respondWindow!.some((m) => m.authorId === IGNORED));
  ok('(a) mention-reply respond(): the other speaker survives',
    respondWindow!.some((m) => m.id === '200'));
  ok('(a) mention-reply respond(): the ignored author\'s name never appears in the built transcript',
    !respondWindow!.map(formatTranscriptMessage).join('\n').includes('Ghost'));
  ok('(a) mention-reply respond(): the ignored author\'s content never appears in the built transcript',
    !respondWindow!.map(formatTranscriptMessage).join('\n').includes('secret-stuff'));

  // ambient judge() fallthrough branch (no pending mention).
  let { judgeWindow } = await runSweepCapture([
    sweepMsg({ id: '100', authorId: IGNORED, name: 'Ghost', content: 'secret-stuff', ts: 1000 }),
    sweepMsg({ id: '200', authorId: 'g1', name: 'Aya', content: 'ordinary chat', ts: 2000 }),
  ], { ignoredUserIds: [IGNORED] });
  ok('(a) ambient judge() fallthrough: the ignored author\'s message is absent from the window',
    !judgeWindow!.some((m) => m.authorId === IGNORED));
  ok('(a) ambient judge() fallthrough: the other speaker survives, in order',
    judgeWindow!.map((m) => m.id).join(',') === '200');

  // order of operations: a surviving message REPLIED to a stripped one.
  const replyMsg = sweepMsg({ id: '200', authorId: 'g1', name: 'Aya', content: 'reply', ts: 2000 }) as any;
  replyMsg.reference = { messageId: '100', channelId: GUEST_HALL, type: 0 };
  ({ judgeWindow } = await runSweepCapture([
    sweepMsg({ id: '100', authorId: IGNORED, name: 'Ghost', content: 'parent-secret', ts: 1000 }),
    replyMsg,
  ], { ignoredUserIds: [IGNORED] }));
  const sweepTranscript = judgeWindow!.map(formatTranscriptMessage).join('\n');
  ok('(a) order: a reply to a stripped message renders the generic marker',
    sweepTranscript.includes('[↳ replying to an earlier message]'));
  ok('(a) order: a reply to a stripped message never names the ignored author',
    !sweepTranscript.includes('Ghost') && !sweepTranscript.includes('parent-secret'));

  // empty ignore list -> byte-identical window (the most important property).
  const plainMsgs = [
    sweepMsg({ id: '100', authorId: 'g1', name: 'Aya', content: 'hi', ts: 1000 }),
    sweepMsg({ id: '200', authorId: 'g2', name: 'Kai', content: 'bye', ts: 2000 }),
  ];
  const withEmptyList = await runSweepCapture(plainMsgs, { ignoredUserIds: [] });
  const withNoOptOrIgnored = await runSweepCapture(plainMsgs, {});
  ok('(a) empty ignore list: fallthrough window is byte-identical to the default (no ignore list) run',
    JSON.stringify(withEmptyList.judgeWindow) === JSON.stringify(withNoOptOrIgnored.judgeWindow));
  ok('(a) empty ignore list: window still contains every message', withEmptyList.judgeWindow!.length === 2);

  // (b) considerChannel — freshly-fetched path (soft-presence never
  // supplies opts.window).
  async function considerChannelCapture(
    msgs: ReturnType<typeof sweepMsg>[],
    opts: { ignoredUserIds?: string[]; triggerMessage?: WindowMessage; window?: WindowMessage[] } = {},
  ): Promise<WindowMessage[] | null> {
    const dc: any = new DiscordClient('owen-1');
  dc.presenceSettled = true; // startup status read done (the hold is tested explicitly below)
    dc.botUserId = BOT_ID;
    dc.getStickerRoster = async () => [];
    dc.getPresenceConfig = async () => ({ ...PRESENCE_DEFAULTS, ignored_user_ids: opts.ignoredUserIds ?? [] });
    dc.getRecentMessages = async () => msgs;
    dc.sendMessage = async () => ({ id: 'sent-1' });
    let judgeWindow: WindowMessage[] | null = null;
    dc.ambientEngine = {
      judge: async (_id: string, _name: string, window: WindowMessage[]) => { judgeWindow = window; return { speak: false, reason: 'test: silent', message: null, stickerId: null }; },
      recordSpoke: () => {},
    };
    dc.ambientMemory = { peekMemoryContext: async () => ({}) };
    await dc.considerChannel(GUEST_HALL, 'guest-hall', {
      ...(opts.triggerMessage ? { triggerMessage: opts.triggerMessage } : {}),
      ...(opts.window ? { window: opts.window } : {}),
    });
    return judgeWindow;
  }

  let jw = await considerChannelCapture([
    sweepMsg({ id: '100', authorId: IGNORED, name: 'Ghost', content: 'secret-stuff', ts: 1000 }),
    sweepMsg({ id: '200', authorId: 'g1', name: 'Aya', content: 'ordinary chat', ts: 2000 }),
  ], { ignoredUserIds: [IGNORED] });
  ok('(b) considerChannel fresh-fetch path: the ignored author\'s message is absent',
    !jw!.some((m) => m.authorId === IGNORED));
  ok('(b) considerChannel fresh-fetch path: the other speaker survives',
    jw!.map((m) => m.id).join(',') === '200');

  // triggerMessage merge, THEN strip — a soft-presence wake's own trigger can
  // itself be from an ignored author.
  jw = await considerChannelCapture(
    [sweepMsg({ id: '100', authorId: 'g1', name: 'Aya', content: 'ordinary chat', ts: 1000 })],
    {
      ignoredUserIds: [IGNORED],
      triggerMessage: { id: '200', authorId: IGNORED, authorName: 'Ghost', content: 'trigger-secret', isFromOwner: false, isFromMe: false, timestampMs: 2000 },
    },
  );
  ok('(b) considerChannel: a triggerMessage from an ignored author is stripped after the merge',
    !jw!.some((m) => m.authorId === IGNORED));
  ok('(b) considerChannel: a triggerMessage from an ignored author never appears in the transcript',
    !jw!.map(formatTranscriptMessage).join('\n').includes('trigger-secret'));

  // opts.window reuse path — considerChannel strips it too, even when the
  // caller already handed it a window (defence in depth: correctness never
  // depends on the caller having stripped first).
  const preBuilt: WindowMessage[] = [
    { id: '1', authorId: 'g1', authorName: 'Aya', content: 'hi', isFromOwner: false, isFromMe: false, timestampMs: 1000 },
    { id: '2', authorId: IGNORED, authorName: 'Ghost', content: 'reused-secret', isFromOwner: false, isFromMe: false, timestampMs: 2000 },
  ];
  jw = await considerChannelCapture([], { ignoredUserIds: [IGNORED], window: preBuilt });
  ok('(b) considerChannel opts.window reuse path: strips an ignored author even from a caller-supplied window',
    !jw!.some((m) => m.authorId === IGNORED));

  // (b.1) considerChannel honours an ID-keyed posture override (Owen,
  // 2026-08-29 — the exact bug: hos-app saves `daemon_config.discord.posture`
  // keyed by channel ID, but this call site used to read
  // `cfg.posture[channelName]` — an ID-keyed override was silently ignored
  // because the keys never matched. This MUST fail against the old code.
  async function considerChannelPostureCapture(
    postureConfig: Record<string, string>,
    channelId: string,
    channelName: string,
  ): Promise<string | undefined> {
    const dc: any = new DiscordClient('owen-1');
  dc.presenceSettled = true; // startup status read done (the hold is tested explicitly below)
    dc.botUserId = BOT_ID;
    dc.getStickerRoster = async () => [];
    dc.getPresenceConfig = async () => ({ ...PRESENCE_DEFAULTS, posture: postureConfig });
    dc.getRecentMessages = async () => [];
    dc.sendMessage = async () => ({ id: 'sent-1' });
    let capturedPosture: string | undefined;
    dc.ambientEngine = {
      judge: async (
        _id: string, _name: string, _window: WindowMessage[], _memory: unknown,
        _stickers: unknown, step?: string,
      ) => {
        capturedPosture = step;
        return { speak: false, reason: 'test: silent', message: null, stickerId: null };
      },
      recordSpoke: () => {},
    };
    dc.ambientMemory = { peekMemoryContext: async () => ({}) };
    await dc.considerChannel(channelId, channelName, {});
    return capturedPosture;
  }

  const OVERRIDE_CHANNEL_ID = '700000000000000102'; // gentlemens-lounge, House seed (old 'high') = reserved
  let posture = await considerChannelPostureCapture(
    { [OVERRIDE_CHANNEL_ID]: 'chatty' },
    OVERRIDE_CHANNEL_ID,
    'gentlemens-lounge',
  );
  ok('(b.1) considerChannel: an ID-keyed live override applies (the exact bug — fails against cfg.posture[channelName])',
    posture === 'chatty');

  posture = await considerChannelPostureCapture(
    { 'gentlemens-lounge': 'sociable' },
    OVERRIDE_CHANNEL_ID,
    'gentlemens-lounge',
  );
  ok('(b.1) considerChannel: a legacy NAME-keyed override still applies', posture === 'sociable');

  posture = await considerChannelPostureCapture({ [OVERRIDE_CHANNEL_ID]: 'full' }, OVERRIDE_CHANNEL_ID, 'gentlemens-lounge');
  ok('(b.1) considerChannel: an old posture word is read as a step (full -> reserved)', posture === 'reserved');

  posture = await considerChannelPostureCapture({}, OVERRIDE_CHANNEL_ID, 'gentlemens-lounge');
  ok('(b.1) considerChannel: no live override falls back to the House seed step', posture === 'reserved');

  // (c) curfew getWindow — captured via a fake CurfewWatch double.
  function curfewMsg(o: { id: string; authorId: string; name: string; content: string; ts: number; replyToId?: string }) {
    return {
      id: o.id,
      author: { id: o.authorId, username: o.name, globalName: o.name, tag: `${o.name}#0` },
      member: { displayName: o.name },
      content: o.content,
      channel: { type: ChannelType.GuildText, name: 'lounge' },
      createdAt: new Date(o.ts),
      createdTimestamp: o.ts,
      guildId: 'guild-1',
      channelId: 'curfew-chan',
      attachments: new Map(),
      reference: o.replyToId ? { messageId: o.replyToId, channelId: 'curfew-chan', type: 0 } : null,
    };
  }

  async function curfewGetWindowCapture(
    recent: ReturnType<typeof curfewMsg>[],
    trigger: ReturnType<typeof curfewMsg>,
    opts: { ignoredUserIds?: string[] } = {},
  ): Promise<WindowMessage[] | null> {
    const dc: any = new DiscordClient('owen-1');
  dc.presenceSettled = true; // startup status read done (the hold is tested explicitly below)
    dc.botUserId = BOT_ID;
    dc.getRecentMessages = async () => recent;
    dc.getPresenceConfig = async () => ({ ...PRESENCE_DEFAULTS, ignored_user_ids: opts.ignoredUserIds ?? [] });
    let capturedWindow: WindowMessage[] | null = null;
    dc.curfewWatch = {
      onOwnerMessage: async (_channelId: string, _channelName: string, getWindow: () => Promise<WindowMessage[]>) => {
        capturedWindow = await getWindow();
        return null; // handleCurfewCheck returns right after — nothing else to mock.
      },
    };
    await dc.handleCurfewCheck(trigger);
    return capturedWindow;
  }

  const ownerTrigger = curfewMsg({ id: 'trig-1', authorId: 'owen-1', name: 'Owen', content: 'up late', ts: 3000 });
  let curfewWindow = await curfewGetWindowCapture([
    curfewMsg({ id: '100', authorId: IGNORED, name: 'Ghost', content: 'secret-stuff', ts: 1000 }),
    curfewMsg({ id: '200', authorId: 'g1', name: 'Aya', content: 'ordinary chat', ts: 2000 }),
  ], ownerTrigger, { ignoredUserIds: [IGNORED] });
  ok('(c) curfew getWindow: the ignored author\'s message is absent',
    !curfewWindow!.some((m) => m.authorId === IGNORED));
  ok('(c) curfew getWindow: the other speaker and the trigger both survive',
    curfewWindow!.map((m) => m.id).sort().join(',') === '200,trig-1');

  // order of operations: a reply to the stripped message.
  curfewWindow = await curfewGetWindowCapture([
    curfewMsg({ id: '100', authorId: IGNORED, name: 'Ghost', content: 'parent-secret', ts: 1000 }),
    curfewMsg({ id: '200', authorId: 'g1', name: 'Aya', content: 'reply', ts: 2000, replyToId: '100' }),
  ], curfewMsg({ id: 'trig-2', authorId: 'owen-1', name: 'Owen', content: 'up late', ts: 3000 }), { ignoredUserIds: [IGNORED] });
  const curfewTranscript = curfewWindow!.map(formatTranscriptMessage).join('\n');
  ok('(c) curfew order: a reply to a stripped message renders the generic marker',
    curfewTranscript.includes('[↳ replying to an earlier message]'));
  ok('(c) curfew order: a reply to a stripped message never names the ignored author',
    !curfewTranscript.includes('Ghost') && !curfewTranscript.includes('parent-secret'));

  // empty ignore list -> byte-identical.
  const plainCurfewRecent = [curfewMsg({ id: '100', authorId: 'g1', name: 'Aya', content: 'hi', ts: 1000 })];
  const plainCurfewTrigger = curfewMsg({ id: 'trig-3', authorId: 'owen-1', name: 'Owen', content: 'up late', ts: 3000 });
  const withEmpty = await curfewGetWindowCapture(plainCurfewRecent, plainCurfewTrigger, { ignoredUserIds: [] });
  const withNone = await curfewGetWindowCapture(plainCurfewRecent, plainCurfewTrigger, {});
  ok('(c) curfew empty ignore list: byte-identical to the default run',
    JSON.stringify(withEmpty) === JSON.stringify(withNone));

  // ── lastBotPost / cursor: stripping never strands a legitimate later
  // mention (extends the existing sweep coverage above with a window-level
  // capture, not just the final send). ─────────────────────────────────────
  ({ respondWindow } = await runSweepCapture([
    sweepMsg({ id: '50', authorId: BOT_ID, name: 'Bram', content: 'my earlier post', ts: 500 }),
    sweepMsg({ id: '100', authorId: IGNORED, name: 'Ghost', content: 'hey @bram too', ts: 800, mentionsBot: true }),
    sweepMsg({ id: '200', authorId: 'g1', name: 'Aya', content: 'hey @bram', ts: 1000, mentionsBot: true }),
  ], { ignoredUserIds: [IGNORED] }));
  ok('(a) lastBotPost/cursor: a legitimate mention after an ignored author\'s (also stripped) mention is still answered',
    respondWindow!.some((m) => m.id === '200'));
  ok('(a) lastBotPost/cursor: the ignored author\'s mention is absent from the answered window',
    !respondWindow!.some((m) => m.authorId === IGNORED));
})();

// ── Server modes in the sweep (DECISIONS 2026-10-16 discord-guest-mode) ──────
await (async () => {
  const G_HOME = '800000000000000001', G_GUEST = '800000000000000002', G_SILENT = '800000000000000003';
  const CH = '800000000000000099';
  const mk = (id: string, authorId: string, ts: number, mention: boolean, bot = false) => ({
    id, author: { id: authorId, bot, username: authorId, globalName: authorId, tag: `${authorId}#0` },
    member: { displayName: authorId }, content: mention ? 'hey @bram' : 'chatter', createdTimestamp: ts,
    guildId: null, channelId: CH, attachments: new Map(), reference: null,
    mentions: fakeMentions({ users: mention ? [BOT_ID] : [] }),
  });
  function build(guildId: string, mode: 'home' | 'guest' | 'silent', msgs: any[]) {
    const dc: any = new DiscordClient('owen-1');
    dc.presenceSettled = true;
    dc.botUserId = BOT_ID;
    const sends: string[] = [];
    const calls = { respond: 0, judge: 0 };
    dc.sendMessage = async (_c: string, t: string) => { sends.push(t); return { id: `sent-${sends.length}` }; };
    dc.getStickerRoster = async () => [];
    // 'moderate' posture on the channel so Home is eligible; Guest and Silent are on Default (no channel key).
    const posture = mode === 'home' ? { [CH]: 'moderate' } : {};
    dc.getPresenceConfig = async () => ({ ...PRESENCE_DEFAULTS, posture, servers: { [guildId]: { mode } } });
    dc.presenceConfig = { getCached: () => ({ ...PRESENCE_DEFAULTS, posture, servers: { [guildId]: { mode } } }) };
    dc.client = {
      channels: {
        cache: { get: () => ({ guildId }) },
        fetch: async () => ({ type: ChannelType.GuildText, name: 'hall', guildId, messages: { fetch: async () => new Map(msgs.map((m) => [m.id, m])) } }),
      },
    };
    dc.ambientEngine = {
      respond: async () => { calls.respond++; return { text: 'answering', stickerId: null }; },
      judge: async () => { calls.judge++; return { speak: true, reason: 'x', message: 'unasked', stickerId: null }; },
      recordSpoke: () => {},
    };
    dc.ambientMemory = { peekMemoryContext: async () => ({}) };
    dc.considerChannel = async () => { calls.judge++; };
    return { dc, sends, calls };
  }

  // Guest: a pending mention is answered at the sweep; no chime-in without one.
  let t = build(G_GUEST, 'guest', [mk('100', 'g1', 1000, true)]);
  t.dc.ambientDirtyChannels = new Set([CH]);
  await t.dc.runAmbientSweep();
  ok('guest: a pending mention is answered at the sweep', t.sends.length === 1 && t.calls.respond === 1);
  ok('guest: the mention reply never calls the judge', t.calls.judge === 0);

  t = build(G_GUEST, 'guest', [mk('100', 'g1', 1000, false)]);
  t.dc.ambientDirtyChannels = new Set([CH]);
  await t.dc.runAmbientSweep();
  ok('guest: no pending mention -> no reply and no judge (never an unasked chime-in)', t.sends.length === 0 && t.calls.judge === 0 && t.calls.respond === 0);

  // Guest observe: only a mention marks the channel dirty.
  t = build(G_GUEST, 'guest', []);
  t.dc.ambientEngine.recordReplyReceived = () => {};
  const obs = (mention: boolean) => ({ guildId: G_GUEST, channelId: CH, channel: { name: 'hall' }, mentions: fakeMentions({ users: mention ? [BOT_ID] : [] }) });
  t.dc.observeAmbientActivity(obs(false));
  ok('guest: a plain message does not mark the channel for the sweep', t.dc.ambientDirtyChannels.size === 0);
  t.dc.observeAmbientActivity(obs(true));
  ok('guest: a mention marks the channel for the sweep', t.dc.ambientDirtyChannels.has(CH));

  // Silent: marked never, answered never.
  t = build(G_SILENT, 'silent', [mk('100', 'g1', 1000, true)]);
  t.dc.ambientEngine.recordReplyReceived = () => {};
  t.dc.observeAmbientActivity({ guildId: G_SILENT, channelId: CH, channel: { name: 'hall' }, mentions: fakeMentions({ users: [BOT_ID] }) });
  ok('silent: a mention does not mark the channel', t.dc.ambientDirtyChannels.size === 0);
  t.dc.ambientDirtyChannels = new Set([CH]);
  await t.dc.runAmbientSweep();
  ok('silent: the sweep says nothing even for a pending mention', t.sends.length === 0 && t.calls.respond === 0 && t.calls.judge === 0);

  // Home: unchanged — mention answered, otherwise the judge runs.
  t = build(G_HOME, 'home', [mk('100', 'g1', 1000, true)]);
  t.dc.ambientDirtyChannels = new Set([CH]);
  await t.dc.runAmbientSweep();
  ok('home: a pending mention is answered at the sweep', t.sends.length === 1 && t.calls.respond === 1);
  t = build(G_HOME, 'home', [mk('100', 'g1', 1000, false)]);
  t.dc.ambientDirtyChannels = new Set([CH]);
  await t.dc.runAmbientSweep();
  ok('home: with no pending mention the judge still runs', t.calls.judge === 1);

  // Dedup: two sweeps, one mention, one reply (same instance, cursor persists).
  t = build(G_GUEST, 'guest', [mk('100', 'g1', 1000, true)]);
  t.dc.ambientDirtyChannels = new Set([CH]);
  await t.dc.runAmbientSweep();
  t.dc.ambientDirtyChannels = new Set([CH]);
  await t.dc.runAmbientSweep();
  ok('guest: two sweeps with one mention produce one reply', t.sends.length === 1);

  // A bot account mentioning in a guest channel: at most one reply per sweep.
  t = build(G_GUEST, 'guest', [mk('100', 'other-bot', 1000, true, true), mk('101', 'other-bot', 1001, true, true)]);
  t.dc.ambientDirtyChannels = new Set([CH]);
  await t.dc.runAmbientSweep();
  ok('guest: a bot account mentioning gets at most one reply per sweep', t.sends.length === 1);

  // Mid-sweep: a mention arriving while the sweep is awaiting stays queued.
  t = build(G_GUEST, 'guest', [mk('100', 'g1', 1000, true)]);
  t.dc.ambientEngine.recordReplyReceived = () => {};
  t.dc.ambientMemory = { peekMemoryContext: async () => {
    t.dc.observeAmbientActivity({ guildId: G_GUEST, channelId: CH, channel: { name: 'hall' }, mentions: fakeMentions({ users: [BOT_ID] }) });
    return {};
  } };
  t.dc.ambientDirtyChannels = new Set([CH]);
  await t.dc.runAmbientSweep();
  ok('guest: a mention arriving mid-sweep keeps the channel dirty for the next sweep', t.dc.ambientDirtyChannels.has(CH));
})();

// ── Channel overrides in every server (DECISIONS 2026-10-17 discord-channel-overrides) ──
await (async () => {
  const { channelBehaviour, effectiveStep } = await import('./presence/posture.js');
  const G = '800000000000000011', CH = '800000000000000098';
  // Pure resolver: a step says what the bot may do.
  const eq = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
  ok('resolver: silent = nothing', eq(channelBehaviour('silent'), { ambient: false, answerMentions: false }));
  ok('resolver: reply_only = mentions only', eq(channelBehaviour('reply_only'), { ambient: false, answerMentions: true }));
  ok('resolver: each ambient step is ambient, with mentions answered', (['reserved', 'balanced', 'sociable', 'chatty'] as const).every((st) => eq(channelBehaviour(st), { ambient: st, answerMentions: true })));
  // effective step = channel ?? server ?? House
  const HOUSE = { step: 'balanced' as const, posture: {} as Record<string, string> };
  ok('effective step: nothing set -> the House dial', effectiveStep(CH, 'x', HOUSE, null) === 'balanced');
  ok('effective step: the server replaces the House dial', effectiveStep(CH, 'x', HOUSE, { step: 'reply_only' }) === 'reply_only');
  ok('effective step: server "same as House" (null) -> the House dial', effectiveStep(CH, 'x', HOUSE, { step: null }) === 'balanced');
  ok('effective step: the channel replaces the server', effectiveStep(CH, 'x', { ...HOUSE, posture: { [CH]: 'chatty' } }, { step: 'reply_only' }) === 'chatty');
  ok('effective step: a channel silent beats everything', effectiveStep(CH, 'x', { ...HOUSE, posture: { [CH]: 'off' } }, { step: 'chatty' }) === 'silent');

  const mk = (id: string, authorId: string, ts: number, mention: boolean) => ({
    id, author: { id: authorId, bot: false, username: authorId, globalName: authorId, tag: `${authorId}#0` },
    member: { displayName: authorId }, content: mention ? 'hey @bram' : 'chatter', createdTimestamp: ts,
    guildId: null, channelId: CH, attachments: new Map(), reference: null,
    mentions: fakeMentions({ users: mention ? [BOT_ID] : [] }),
  });
  function build(mode: 'home' | 'guest' | 'silent', posture: Record<string, string>, msgs: any[]) {
    const dc: any = new DiscordClient('owen-1');
    dc.presenceSettled = true;
    dc.botUserId = BOT_ID;
    const sends: string[] = [];
    const reacts: string[] = [];
    const calls = { respond: 0, judge: 0 };
    dc.sendMessage = async (_c: string, t: string) => { sends.push(t); return { id: `sent-${sends.length}` }; };
    dc.addReaction = async () => { reacts.push('r'); return true; };
    dc.getStickerRoster = async () => [];
    const cfg = () => ({ ...PRESENCE_DEFAULTS, posture, servers: { [G]: { mode } } });
    dc.getPresenceConfig = async () => cfg();
    dc.presenceConfig = { getCached: cfg };
    dc.client = {
      channels: {
        cache: { get: () => ({ guildId: G, name: 'hall' }) },
        fetch: async () => ({ type: ChannelType.GuildText, name: 'hall', guildId: G, messages: { fetch: async () => new Map(msgs.map((m) => [m.id, m])) } }),
      },
      emojis: { cache: new Map() },
    };
    dc.ambientEngine = {
      respond: async () => { calls.respond++; return { text: 'answering', stickerId: null }; },
      judge: async () => { calls.judge++; return { speak: true, reason: 'x', message: 'unasked', stickerId: null }; },
      recordSpoke: () => {}, recordReplyReceived: () => {},
      tryReserveReaction: () => 1, releaseReaction: () => {},
    };
    dc.ambientMemory = { peekMemoryContext: async () => ({}) };
    dc.considerChannel = async () => { calls.judge++; };
    return { dc, sends, calls, reacts };
  }
  const obs = (mention: boolean) => ({ guildId: G, channelId: CH, channel: { name: 'hall' }, mentions: fakeMentions({ users: mention ? [BOT_ID] : [] }) });

  // off blocks a guest server's mention answer, and does not mark the channel.
  let t = build('guest', { [CH]: 'off' }, [mk('100', 'g1', 1000, true)]);
  t.dc.observeAmbientActivity(obs(true));
  ok('off (guest): a mention does not mark the channel', t.dc.ambientDirtyChannels.size === 0);
  t.dc.ambientDirtyChannels = new Set([CH]);
  await t.dc.runAmbientSweep();
  ok('off (guest): the sweep answers nothing and drops the queue entry', t.sends.length === 0 && t.calls.respond === 0 && !t.dc.ambientDirtyChannels.has(CH));

  // off blocks ambient in a home server even when the House map would open it.
  t = build('home', { [CH]: 'off' }, [mk('100', 'g1', 1000, false)]);
  t.dc.observeAmbientActivity(obs(false));
  ok('off (home): a plain message does not mark the channel', t.dc.ambientDirtyChannels.size === 0);
  // the real considerChannel refuses an 'off' channel, and a Default guest channel, before the judge runs.
  for (const [mode, posture] of [['home', { [CH]: 'off' }], ['guest', { [CH]: 'off' }], ['guest', {}]] as const) {
    const u = build(mode, { ...posture }, []);
    u.dc.considerChannel = DiscordClient.prototype.considerChannel;
    u.dc.guildIdOfChannel = async () => G;
    await u.dc.considerChannel(CH, 'hall', {});
    ok(`considerChannel: ${mode} ${JSON.stringify(posture)} never reaches the judge`, u.calls.judge === 0 && u.sends.length === 0);
  }

  // off blocks reactions (the real considerChannel/reactTo, not the stub).
  t = build('guest', { [CH]: 'off' }, []);
  const reactedOff = await t.dc.reactTo(CH, { id: 'm1', authorId: 'g1' }, '👍', t.dc.ambientEngine);
  ok('off: no reaction on a guest message', reactedOff === false && t.reacts.length === 0);

  // a gentle channel in a guest server gets ambient.
  t = build('guest', { [CH]: 'gentle' }, [mk('100', 'g1', 1000, false)]);
  t.dc.observeAmbientActivity(obs(false));
  ok('gentle (guest): a plain message marks the channel', t.dc.ambientDirtyChannels.has(CH));
  await t.dc.runAmbientSweep();
  ok('gentle (guest): the sweep runs the judge', t.calls.judge === 1);

  // a gentle channel in a silent server gets ambient.
  t = build('silent', { [CH]: 'gentle' }, [mk('100', 'g1', 1000, false)]);
  t.dc.observeAmbientActivity(obs(false));
  ok('gentle (silent): a plain message marks the channel', t.dc.ambientDirtyChannels.has(CH));

  // a reactive channel in a silent server answers mentions, never chimes in.
  t = build('silent', { [CH]: 'reactive' }, [mk('100', 'g1', 1000, true)]);
  t.dc.observeAmbientActivity(obs(true));
  ok('reactive (silent): a mention marks the channel', t.dc.ambientDirtyChannels.has(CH));
  await t.dc.runAmbientSweep();
  ok('reactive (silent): the mention is answered', t.sends.length === 1 && t.calls.respond === 1);
  t = build('silent', { [CH]: 'reactive' }, [mk('100', 'g1', 1000, false)]);
  t.dc.observeAmbientActivity(obs(false));
  ok('reactive (silent): a plain message does not mark the channel', t.dc.ambientDirtyChannels.size === 0);
  t.dc.ambientDirtyChannels = new Set([CH]);
  await t.dc.runAmbientSweep();
  ok('reactive (silent): no pending mention -> no chime-in', t.sends.length === 0 && t.calls.judge === 0);
})();

// Bot-loop guard: a non-owner mention is never answered in real time, in any mode.
await (async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./cloud-server.ts', import.meta.url), 'utf8');
  const start = src.indexOf("discordClient.on('mention'");
  const end = src.indexOf("// --- DM Handler ---");
  const handler = src.slice(start, end);
  const elseBranch = handler.slice(handler.indexOf('} else {\n    // Someone else mentioned the bot'));
  ok('non-owner mention branch found', elseBranch.length > 0 && start > 0);
  ok('non-owner mention: no real-time reply (no respond/sendMessage/judge), only the owner DM',
    !/respond\(|sendMessage\(|judge\(/.test(elseBranch) && /sendDM\(OWNER_USER_ID/.test(elseBranch));
})();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
