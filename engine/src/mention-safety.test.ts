// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Mass-ping guard on model output: every send the bot's own model writes (away
 * replies, presence/ambient replies, curfew nudges, soft-presence) goes out with
 * allowedMentions that never parse @everyone, @here or roles. Only an
 * owner-directed send (MCP tools, /api/send-message) may announce on purpose.
 *
 * Run: npx tsx src/mention-safety.test.ts
 */
import './test-env.js';
import { readFileSync } from 'node:fs';
import { MODEL_ALLOWED_MENTIONS, DiscordClient } from './discord-client.js';
import { ChannelType } from 'discord.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function clientWithChannel() {
  const dc: any = new DiscordClient('owner-1');
  const sent: any[] = [];
  const channel = {
    type: ChannelType.GuildText,
    send: async (o: any) => { sent.push(o); return { id: 'sent-1', guildId: null }; },
  };
  dc.client = { channels: { fetch: async () => channel } };
  return { dc, sent };
}

async function run() {
  ok('model allowedMentions parse only users', JSON.stringify(MODEL_ALLOWED_MENTIONS.parse) === '["users"]');
  ok('model allowedMentions let the replied user through', MODEL_ALLOWED_MENTIONS.repliedUser === true);

  // A "Reply as" post: keeps the reply reference, notifies nobody (not even the replied-to author).
  {
    const { dc, sent } = clientWithChannel();
    await dc.sendMessage('c1', 'hello', undefined, 'm1', undefined, { quietReply: true });
    const am = sent[0]?.allowedMentions;
    ok('quiet reply keeps the reply reference', sent[0]?.reply?.messageReference === 'm1');
    ok('quiet reply does not ping the replied-to author', am?.repliedUser === false && JSON.stringify(am?.parse) === '["users"]');
  }

  // An away reply: the model wrote @everyone; the default send path must disable it.
  {
    const { dc, sent } = clientWithChannel();
    await dc.sendMessage('c1', 'hello @everyone and @here <@&123456789012345678>', undefined, 'm1');
    const am = sent[0]?.allowedMentions;
    ok('away-style reply with @everyone is sent with mentions disabled', !!am && am.parse.length === 1 && am.parse[0] === 'users' && !('roles' in am));
    ok('the reply reference is kept', sent[0]?.reply?.messageReference === 'm1');
  }
  // Curfew-style send (sticker, no reply) is model text too.
  {
    const { dc, sent } = clientWithChannel();
    await dc.sendMessage('c1', '@everyone bedtime', undefined, undefined, ['s1']);
    ok('curfew-style send is guarded too', sent[0]?.allowedMentions?.parse?.join() === 'users');
  }
  // Owner-directed: unchanged (no allowedMentions override).
  {
    const { dc, sent } = clientWithChannel();
    await dc.sendMessage('c1', '@everyone announcement', undefined, undefined, undefined, { ownerDirected: true });
    ok('owner-directed send keeps default mention behaviour', sent[0]?.allowedMentions === undefined);
  }
  // replyToMessage is model-only.
  {
    const dc: any = new DiscordClient('owner-1');
    let opts: any;
    dc.maybeCopyToOwner = () => {};
    await dc.replyToMessage({ channelId: 'c1', reply: async (o: any) => { opts = o; return { id: 'r1' }; } } as any, '@everyone hi');
    ok('replyToMessage is guarded', opts?.allowedMentions?.parse?.join() === 'users');
  }

  // Wiring: the away wrapper and the presence/curfew sites never opt out; the owner paths do.
  const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
  ok('cloud-server away sendMessage does not pass ownerDirected', !/ownerDirected/.test(read('./cloud-server.ts')));
  ok('mcp discord_send_message is owner-directed', /stickerIds, \{ ownerDirected: true[,} ]/.test(read('./mcp/direct.ts')));
  ok('/api/send-message is owner-directed', /sticker_ids, \{ ownerDirected: true[,} ]/.test(read('./http-server.ts')));
  ok('presence/curfew sends in discord-client are never owner-directed',
    (read('./discord-client.ts').match(/ownerDirected: true/g) ?? []).length === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run();
