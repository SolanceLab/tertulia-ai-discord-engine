// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/house-hooks-wiring.test.ts — the client offers direct messages to a hooks module and obeys its answer. */
import './test-env.js';
import { DiscordClient } from './discord-client.js';
import { type DirectMessage, type HouseHooksApi, setHouseHooks, type DirectMessageOutcome } from './house-hooks.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

const OWNER = '100000000000000001', BOT = '100000000000000003', GUEST = '700000000000000001';

function clientWith(opts: { held?: boolean; step?: string } = {}) {
  const dc: any = new DiscordClient(OWNER);
  dc.botUserId = BOT;
  dc.presenceSettled = true;
  dc.shownOffline = Boolean(opts.held);
  const step = opts.step ?? 'reply_only';
  dc.channelRules = () => ({ step, ambient: false, answerMentions: step !== 'silent' });
  const sent: any[] = [], reacted: any[] = [];
  dc.sendDM = async (u: string, t: string) => { sent.push([u, t]); return null; };
  dc.addReaction = async (c: string, m: string, e: string) => { reacted.push([c, m, e]); return true; };
  return { dc, sent, reacted };
}
const msg = (over: any = {}): any => ({
  id: '55', channelId: 'c1', guildId: 'g1', guild: { id: 'g1' }, channel: { name: 'lounge' }, content: 'hello bot',
  author: { id: GUEST, username: 'g', bot: false }, member: { displayName: 'Gee' }, createdTimestamp: 1000,
  mentions: { has: (id: string) => id === BOT, repliedUser: null }, reference: null, ...over,
});

(async () => {
  let seen: Array<[DirectMessage, HouseHooksApi]> = [];
  let answer: DirectMessageOutcome = 'continue';
  setHouseHooks({ onDirectMessage: async (m, api) => { seen.push([m, api]); return answer; } });

  {
    const { dc } = clientWith();
    ok('mention: offered, "continue" carries on', (await dc.runDirectMessageHook(msg())) === 'continue' && seen.length === 1);
    const [m] = seen[0];
    ok('facts: plain data with a jump link', m.authorId === GUEST && m.channelName === 'lounge' && m.isMention && !m.isReplyToBot && m.link === 'https://discord.com/channels/g1/c1/55');
  }
  {
    seen = []; answer = 'handled';
    const { dc } = clientWith();
    ok('"handled" stops the message', (await dc.runDirectMessageHook(msg())) === 'handled');
  }
  {
    seen = [];
    const { dc } = clientWith();
    const reply = msg({ mentions: { has: () => false, repliedUser: { id: BOT } }, reference: { messageId: '9' } });
    await dc.runDirectMessageHook(reply);
    ok('reply to the bot is direct', seen.length === 1 && seen[0][0].isReplyToBot && !seen[0][0].isMention);
  }
  {
    seen = [];
    const { dc } = clientWith();
    await dc.runDirectMessageHook(msg({ mentions: { has: () => false, repliedUser: null } }));
    await dc.runDirectMessageHook(msg({ author: { id: GUEST, bot: true } }));
    await dc.runDirectMessageHook(msg({ author: { id: OWNER, bot: false } }));
    await dc.runDirectMessageHook(msg({ guild: null }));
    ok('not offered: plain message, bot, owner, DM', seen.length === 0);
  }
  {
    seen = [];
    const { dc } = clientWith({ held: true });
    await dc.runDirectMessageHook(msg());
    ok('not offered while the bot is shown offline', seen.length === 0);
  }
  {
    seen = [];
    const { dc } = clientWith({ step: 'silent' });
    await dc.runDirectMessageHook(msg());
    ok('not offered in a silent channel', seen.length === 0);
  }
  {
    seen = []; answer = 'handled';
    const { dc, sent, reacted } = clientWith();
    setHouseHooks({ onDirectMessage: async (m, api) => { await api.react('💛'); await api.dmOwner('note'); seen.push([m, api]); return 'handled'; } });
    await dc.runDirectMessageHook(msg());
    ok('api: react goes to that message, dmOwner goes to the owner', reacted[0]?.join() === 'c1,55,💛' && sent[0]?.join() === `${OWNER},note`);
    ok('api: quote flattens and caps', seen[0][1].quote('a\n\n  b') === 'a b' && seen[0][1].quote('x'.repeat(500)).length <= 301);
  }
  {
    // dmOwner never throws, even when Discord rejects the DM (the hook must not abort)
    const { dc } = clientWith();
    dc.sendDM = async () => { throw new Error('Cannot send messages to this user'); };
    let threw = false;
    setHouseHooks({ onDirectMessage: async (_m, api) => { try { await api.dmOwner('note'); } catch { threw = true; } return 'handled'; } });
    const r = await dc.runDirectMessageHook(msg());
    ok('api: dmOwner swallows a Discord rejection', !threw && r === 'handled');
  }
  {
    const { dc } = clientWith();
    const calls: any[] = [];
    dc.answerFromThisMessageAlone = async (m: any, note?: string) => { calls.push([m.id, note]); return true; };
    const told: boolean[] = [];
    setHouseHooks({ onDirectMessage: async () => ({ replyWithOnly: true, note: 'short', onDelivery: (d: boolean) => { told.push(d); } }) });
    const r = await dc.runDirectMessageHook(msg());
    await new Promise((res) => setTimeout(res, 10));
    ok('replyWithOnly: onDelivery hears the real result', told.join() === 'true');
    ok('replyWithOnly: the single-message reply runs with the note, and the normal path stops', r === 'handled' && calls[0]?.join() === '55,short');
  }
  {
    const { dc } = clientWith();
    setHouseHooks({ onDirectMessage: async () => { throw new Error('boom'); } });
    const origWrite = process.stderr.write.bind(process.stderr); (process.stderr as any).write = () => true;
    const r = await dc.runDirectMessageHook(msg());
    (process.stderr as any).write = origWrite;
    ok('a throwing hook carries on as without it', r === 'continue');
  }
  {
    setHouseHooks(null);
    const { dc } = clientWith();
    ok('no module: nothing happens', (await dc.runDirectMessageHook(msg())) === 'continue');
  }
  setHouseHooks(null);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
