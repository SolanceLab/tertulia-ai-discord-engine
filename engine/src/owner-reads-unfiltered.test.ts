// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Owner decision 14 Nov: hiding (ignore list, hideAuthor, hideMessage) governs what the bot's own model sees.
 * The owner's four read tools (read_messages, find_message, search_messages, list_pins) return every message,
 * over the real HTTP routes; the bot's own history window still leaves hidden people out.
 *
 * Run: npx tsx src/owner-reads-unfiltered.test.ts
 */
import './test-env.js';
import type { AddressInfo } from 'node:net';
import { Collection, ChannelType } from 'discord.js';
import { setHouseHooks } from './house-hooks.js';
import { resetBotSpoke } from './presence/bot-spoke.js';
import { DiscordClient } from './discord-client.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

const OWNER = '100000000000000001', BOT = '100000000000000003';
const IGN = '700000000000000001', HID = '700000000000000002', PLAIN = '700000000000000003', SECRETWRITER = '700000000000000004';
const CH = '100000000000000010', GUILD = '100000000000000020';

const mk = (id: string, authorId: string, content: string): any => ({
  id, channelId: CH, guildId: null, guild: null, author: { id: authorId, tag: `u${authorId.slice(-1)}#0` }, content,
  createdAt: new Date(1_800_000_000_000), createdTimestamp: 1_800_000_000_000, attachments: new Collection(), embeds: [],
  reference: null, mentions: { has: () => false, users: { has: () => false }, repliedUser: null },
});
const M_IGN = '800000000000000001', M_HID = '800000000000000002', M_PLAIN = '800000000000000003', M_SECRET = '800000000000000004';
const msgs = [mk(M_SECRET, SECRETWRITER, 'secret'), mk(M_PLAIN, PLAIN, 'hello'), mk(M_HID, HID, 'hi'), mk(M_IGN, IGN, 'yo')]; // newest first
const all = [M_SECRET, M_PLAIN, M_HID, M_IGN].sort();

(async () => {
  setHouseHooks({ hideAuthor: (a: string) => a === HID, hideMessage: (f: any) => f.content === 'secret' });
  resetBotSpoke();
  const dc: any = new DiscordClient(OWNER);
  dc.botUserId = BOT;
  dc.presenceConfig = { getCached: () => ({ ignored_user_ids: [IGN] }), get: async () => ({ ignored_user_ids: [IGN] }) };
  const channel: any = {
    id: CH, name: 'general', type: ChannelType.GuildText, isTextBased: () => true,
    messages: {
      fetch: async (a: any) => {
        if (typeof a === 'string') { const m = msgs.find((x) => x.id === a); if (!m) throw new Error('404'); return m; }
        return a?.before ? new Collection() : new Collection(msgs.map((m) => [m.id, m] as [string, any]));
      },
      fetchPins: async () => ({ items: msgs.map((message) => ({ message })) }),
    },
  };
  const guild: any = { id: GUILD, name: 'G', channels: { fetch: async () => new Map([[CH, channel]]), fetchActiveThreads: async () => ({ threads: new Map() }) } };
  dc.client = { channels: { fetch: async () => channel }, guilds: { fetch: async () => guild } };

  const { createHttpServer } = await import('./http-server.js');
  const srv: any = createHttpServer(dc, {} as any, 'bot-secret', 0);
  await new Promise((res) => (srv.listening ? res(null) : srv.once('listening', res)));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = async (path: string, b: unknown) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bot-secret' }, body: JSON.stringify(b) });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };
  const ids = (list: any[]) => (list ?? []).map((m) => m.id).sort().join();

  const read = await post('/api/read-messages', { channel_id: CH });
  ok('read_messages returns ignored, hidden-author and hidden-message posts', ids(read.json?.messages) === all.join());
  const pins = await post('/api/list-pins', { channel_id: CH });
  ok('list_pins returns every pinned message', ids(pins.json?.messages) === all.join());
  const search = await post('/api/search-messages', { channel_id: CH, keyword: 'h' });
  ok('search_messages finds hidden-author text', ids(search.json?.messages) === [M_HID, M_PLAIN].sort().join());
  const searchIgn = await post('/api/search-messages', { channel_id: CH, author_id: IGN });
  ok('search_messages finds an ignored author', ids(searchIgn.json?.messages) === M_IGN);
  const searchSecret = await post('/api/search-messages', { channel_id: CH, keyword: 'secret' });
  ok('search_messages finds a hideMessage post', ids(searchSecret.json?.messages) === M_SECRET);
  for (const [label, id] of [['ignored author', M_IGN], ['hideAuthor author', M_HID], ['hideMessage post', M_SECRET]] as const) {
    const f = await post('/api/find-message', { message_id: id, server_id: GUILD });
    ok(`find_message finds the ${label}`, f.json?.found === true && f.json?.message?.id === id);
  }

  // the bot's own window still leaves them out
  const win = await dc.getRecentMessages(CH, 15);
  ok('bot window (default filter) keeps only the plain post', win.map((m: any) => m.id).join() === M_PLAIN);

  srv.close();
  setHouseHooks(null);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
