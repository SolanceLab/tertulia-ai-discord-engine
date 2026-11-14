// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/message-hook.test.ts — the per-message hideMessage hook: wrapper, loader, window strip, door, ingress, history. */
import './test-env.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelType } from 'discord.js';
import { hookHidesMessage, loadHouseHooks, NOOP_HOOKS, type MessageFacts, setHouseHooks, hooksCanHideMessages } from './house-hooks.js';
import { stripIgnoredMessages, windowHidden } from './presence/window.js';
import { resetBotSpoke, noteBotSpoke } from './presence/bot-spoke.js';
import { PresenceEngine } from './presence-engine.js';
import type { WindowMessage } from './presence-engine.js';
import { DEFAULTS } from './presence-config.js';
import { DiscordClient } from './discord-client.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

const A = '700000000000000001', B = '700000000000000002', BOT = '100000000000000003', OWNER = '100000000000000001';
const H = (m: MessageFacts) => m.authorId === A && (m.mentionsBot || m.repliesToBot || (m.msSinceBotSpokeInChannel !== null && m.msSinceBotSpokeInChannel <= 300000));
const wm = (id: string, authorId: string, t: number, over: Partial<WindowMessage> = {}): WindowMessage => ({
  id, authorId, authorName: `n${authorId.slice(-1)}`, authorUsername: 'u', content: 'hi', isFromOwner: false,
  isFromMe: authorId === BOT, timestampMs: t, channelId: 'c1', ...over,
});

const dir = mkdtempSync(join(tmpdir(), 'hooks-msg-'));
const origWrite = process.stderr.write.bind(process.stderr);
const quiet = (on: boolean) => { (process.stderr as any).write = on ? (() => true) : origWrite; };

(async () => {
  try {
    // 1 absent hook
    setHouseHooks(null); resetBotSpoke();
    {
      const w = [wm('1', A, 0)];
      ok('absent: cannot hide, hides nothing, same window back', !hooksCanHideMessages() && !hookHidesMessage({ authorId: A, content: '', mentionsBot: true, repliesToBot: false, msSinceBotSpokeInChannel: 0 }) && stripIgnoredMessages(w, []) === w);
    }
    // 2 throwing hook
    setHouseHooks({ hideMessage: () => { throw new Error('x'); } });
    quiet(true);
    const threw = hookHidesMessage({ authorId: A, content: '', mentionsBot: true, repliesToBot: false, msSinceBotSpokeInChannel: 0 });
    quiet(false);
    ok('throwing hideMessage: false, no throw', threw === false);
    // 3 loader
    {
      writeFileSync(join(dir, 'good.mjs'), `export const hooks = { hideMessage: () => true };`);
      const good = await loadHouseHooks([join(dir, 'good.mjs')]);
      ok('loader: accepts a hideMessage function', typeof good.hideMessage === 'function');
      writeFileSync(join(dir, 'bad.mjs'), `export const hooks = { hideMessage: 5 };`);
      quiet(true); const bad = await loadHouseHooks([join(dir, 'bad.mjs')]); quiet(false);
      ok('loader: rejects a non-function hideMessage', bad === NOOP_HOOKS);
    }
    // 4 window strip
    setHouseHooks({ hideMessage: H }); resetBotSpoke();
    const timeline = () => [
      wm('a1', A, 0, { content: 'early' }),
      wm('b1', BOT, 1000),
      wm('a2', A, 400000, { content: `<@${BOT}> hey` }),
      wm('a3', A, 500000, { replyToId: 'b1' }),
      wm('b2', BOT, 600000),
      wm('a4', A, 720000),
      wm('a5', A, 960000),
      wm('c1', B, 970000, { content: `<@${BOT}>`, replyToId: 'b2' }),
    ];
    {
      const out = stripIgnoredMessages(timeline(), []);
      ok('strip: only her directed messages go; others and her later ones stay', out.map((m) => m.id).join() === 'a1,b1,b2,a5,c1' && windowHidden(out));
    }
    // 5 bot message outside the window
    {
      resetBotSpoke(); noteBotSpoke('c1', 1_000_000);
      const w = Array.from({ length: 16 }, (_, i) => wm(`g${i}`, B, 1_000_100 + i * 1000));
      const near = stripIgnoredMessages([...w, wm('p', A, 1_120_000, { content: 'plain' })], []);
      ok('record: bot spoke outside the window, her message 2 min later is hidden', !near.some((m) => m.id === 'p'));
      const far = stripIgnoredMessages([...w, wm('p', A, 1_400_000, { content: 'plain' })], []);
      ok('record: 6+ minutes later is kept', far.some((m) => m.id === 'p'));
    }
    // 6 replyToMe with parent outside the window
    {
      resetBotSpoke();
      const out = stripIgnoredMessages([wm('x', B, 0), wm('r', A, 9_000_000, { replyToId: 'gone', replyToMe: true })], []);
      ok('replyToMe: parent outside the window still hides it', out.length === 1 && out[0].id === 'x');
    }
    // 7 redactAtTheDoor
    {
      resetBotSpoke();
      const engine: any = new PresenceEngine('http://model.invalid', 'k', 'PERSONA', () => 1_760_000_000_000, undefined, undefined, undefined, { get: async () => ({ ...DEFAULTS }), getCached: () => ({ ...DEFAULTS }) } as any);
      engine.setSelfId(BOT);
      const w = [wm('a2', A, 1000, { content: `<@${BOT}> hey` }), wm('c2', B, 2_000_000, { replyToId: 'a2', replyToAuthorName: 'nA' })];
      const out = engine.redactAtTheDoor(w);
      ok('door: her directed message gone, a survivor replying to it loses the parent name', out.length === 1 && out[0].id === 'c2' && out[0].replyToAuthorName === undefined && out[0].replyToId === 'a2');
    }
    // 8 ingress, including the real messageCreate handler
    const gm = (id: string, authorId: string, t: number, over: any = {}): any => ({
      id, channelId: 'c1', guildId: 'g1', author: { id: authorId }, content: 'plain', createdTimestamp: t,
      mentions: { has: () => false, users: { has: () => false }, repliedUser: null }, reference: null, ...over,
    });
    {
      const dc: any = new DiscordClient(OWNER);
      dc.botUserId = BOT;
      resetBotSpoke();
      ok('ingress: mention hidden', dc.ingressMessageHidden(gm('1', A, 1, { mentions: { has: (i: string) => i === BOT, repliedUser: null } })) === true);
      ok('ingress: reply to the bot hidden', dc.ingressMessageHidden(gm('2', A, 1, { reference: { messageId: '9' }, mentions: { has: () => false, repliedUser: { id: BOT } } })) === true);
      ok('ingress: plain with no record is kept', dc.ingressMessageHidden(gm('3', A, 5_000)) === false);
      ok('ingress: a DM to the bot is hidden', dc.ingressMessageHidden(gm('3d', A, 5_000, { guildId: null })) === true);
      noteBotSpoke('c1', 1000);
      ok('ingress: 2 minutes after the bot is hidden, 6 minutes is kept', dc.ingressMessageHidden(gm('4', A, 121_000)) === true && dc.ingressMessageHidden(gm('5', A, 361_000)) === false);
      ok('ingress: the bot itself and other authors are kept', dc.ingressMessageHidden(gm('6', BOT, 2000)) === false && dc.ingressMessageHidden(gm('7', B, 2000, { mentions: { has: (i: string) => i === BOT, repliedUser: null } })) === false);

      // the real handler: a hidden message never reaches the direct-message hook; a visible one does
      resetBotSpoke();
      let offered = 0;
      dc.runDirectMessageHook = async () => { offered++; return 'handled'; };
      setHouseHooks({ hideMessage: H, onDirectMessage: async () => 'continue' });
      dc.client.emit('messageCreate', gm('8', A, 1, { mentions: { has: (i: string) => i === BOT, repliedUser: null } }));
      dc.client.emit('messageCreate', gm('9', B, 1, { mentions: { has: (i: string) => i === BOT, repliedUser: null } }));
      await new Promise((r) => setTimeout(r, 50));
      ok('messageCreate: her mention is dropped before the hook, another guest still gets through', offered === 1);
      // the bot's own gateway message sets the clock before any early return
      dc.client.emit('messageCreate', gm('10', BOT, 50_000));
      await new Promise((r) => setTimeout(r, 50));
      ok('messageCreate: the bot own message sets the channel clock', dc.ingressMessageHidden(gm('11', A, 100_000)) === true);
      // restart guard: empty clock, bot posted 60s ago in history, her plain message is dropped; later ones need no refetch
      resetBotSpoke();
      offered = 0;
      let fetches = 0;
      const hist = new Map<string, any>([['b', gm('b', BOT, 40_000)]]);
      const chan = { messages: { fetch: async () => { fetches++; return hist; } } };
      setHouseHooks({ hideMessage: H, onDirectMessage: async () => 'continue' });
      dc.client.emit('messageCreate', gm('12', A, 100_000, { channel: chan }));
      await new Promise((r) => setTimeout(r, 50));
      dc.client.emit('messageCreate', gm('13', A, 110_000, { channel: chan }));
      dc.client.emit('messageCreate', gm('14', B, 110_000, { channel: chan }));
      await new Promise((r) => setTimeout(r, 50));
      ok('restart: empty clock hydrates from history, so her plain message within 5 min is dropped', offered === 1 && fetches === 1);
      setHouseHooks({ hideMessage: H });
    }
    // 9 getRecentMessages
    {
      const dc: any = new DiscordClient(OWNER);
      dc.botUserId = BOT;
      const mk = (id: string, authorId: string, t: number, over: any = {}) => gm(id, authorId, t, over);
      const mention = { has: (i: string) => i === BOT, users: { has: (i: string) => i === BOT }, repliedUser: null };
      const newestFirst = [
        mk('a5', A, 960000), mk('a4', A, 720000), mk('b2', BOT, 600000),
        mk('a3', A, 500000, { reference: { messageId: 'b1' }, mentions: { has: () => false, users: { has: () => false }, repliedUser: { id: BOT } } }),
        mk('a2', A, 400000, { mentions: mention }), mk('b1', BOT, 1000), mk('a1', A, 0),
      ];
      const stubChannel = (list: any[]) => {
        dc.client = { channels: { fetch: async () => ({ type: ChannelType.GuildText, messages: { fetch: async () => new Map(list.map((m) => [m.id, m])) } }) } };
      };
      resetBotSpoke(); stubChannel(newestFirst);
      const got = await dc.getRecentMessages('c1', 15);
      ok('history: her directed messages are dropped, early and late ones stay', got.map((m: any) => m.id).join() === 'a1,b1,b2,a5');
      resetBotSpoke(); stubChannel(newestFirst);
      const all = await dc.getRecentMessages('c1', 15, { keepBlocked: true });
      ok('history: keepBlocked returns everything', all.length === newestFirst.length);
      resetBotSpoke(); noteBotSpoke('c1', 1_000_000); stubChannel([mk('p', A, 1_060_000), mk('q', B, 1_050_000)]);
      const rec = await dc.getRecentMessages('c1', 15);
      ok('history: the bot message only in the channel record still hides a plain message 1 minute later', rec.map((m: any) => m.id).join() === 'q');
    }
    // 10 a send records the clock (replyToMessage path)
    {
      const dc: any = new DiscordClient(OWNER);
      dc.botUserId = BOT;
      resetBotSpoke();
      const sent = { id: 's', channelId: 'c1', createdTimestamp: 70_000 };
      const m: any = { ...gm('m', B, 60_000), reply: async () => sent, channel: { sendTyping: async () => {} }, guild: { id: 'g1' } };
      await dc.replyToMessage(m, 'hello');
      const recorded = dc.ingressMessageHidden(gm('n', A, 100_000)) === true;
      ok('send: replying to a message records the bot clock', recorded);
    }
  } finally {
    quiet(false);
    setHouseHooks(null); resetBotSpoke();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
