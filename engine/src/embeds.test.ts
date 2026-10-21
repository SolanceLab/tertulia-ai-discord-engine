// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Embeds on the Discord tools: the discord.js Embed -> plain mapping, the checks that run
 * before Discord is called, and the send and edit paths.
 *
 * Run: npx tsx src/embeds.test.ts
 */
import './test-env.js';
import { isDeepStrictEqual } from 'node:util';
import { Embed, ChannelType } from 'discord.js';
import { DiscordClient } from './discord-client.js';
import { embedToPlain, validateEmbeds, embedsOf, embedsToApi } from './discord/embeds.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// A real-shaped index card: the HoS "How to Discord" embed.
const index = {
  title: 'How to Discord',
  description: '**Start here**\n[Rules](https://discord.com/channels/1/2/3) · [Roles](https://discord.com/channels/1/2/4)',
  color: 0xc9a24b,
  footer: { text: 'House of Solance' },
};

async function run() {
  // --- mapping: a real discord.js Embed
  const real = new (Embed as any)(index as any);
  const plain = embedToPlain(real);
  ok('title kept', plain.title === 'How to Discord');
  ok('markdown links kept', plain.description === index.description);
  ok('color is a hex string', plain.color === '#c9a24b');
  ok('footer is {text}', JSON.stringify(plain.footer) === '{"text":"House of Solance"}');
  ok('empty keys omitted', !('fields' in plain) && !('author' in plain) && !('image_url' in plain) && !('url' in plain));
  ok('embedsOf maps a message', embedsOf({ embeds: [real] }).length === 1 && embedsOf({}).length === 0);

  // --- round trip: read -> validate -> API shape -> read again
  ok('a read embed validates', validateEmbeds([plain]) === null);
  const api = embedsToApi([plain])[0];
  ok('API color is the integer', api.color === 0xc9a24b);
  const again = embedToPlain(new (Embed as any)(api));
  ok('embed survives the round trip', JSON.stringify(again) === JSON.stringify(plain));

  const rich = {
    title: 't', url: 'https://x.test/a', description: 'd', color: '#00ff00',
    fields: [{ name: 'n', value: 'v', inline: true }],
    author: { name: 'a', url: 'https://x.test/b' }, image_url: 'https://x.test/i.png', thumbnail_url: 'https://x.test/t.png',
    timestamp: '2026-10-21T12:00:00.000Z', footer: { text: 'f' },
  };
  ok('a rich embed round-trips', isDeepStrictEqual(embedToPlain(new (Embed as any)(embedsToApi([rich])[0])), rich));

  // --- icons and Discord's proxy copies survive read -> edit -> send
  const served = {
    title: 't', footer: { text: 'f', icon_url: 'https://x.test/f.png', proxy_icon_url: 'https://media.test/f.png' },
    author: { name: 'a', icon_url: 'https://x.test/a.png', proxy_icon_url: 'https://media.test/a.png' },
    image: { url: 'https://x.test/i.png', proxy_url: 'https://media.test/i.png' },
    thumbnail: { url: 'https://x.test/t.png', proxy_url: 'https://media.test/t.png' },
  };
  const readIcons = embedToPlain(served);
  ok('footer icon and proxy kept', readIcons.footer?.icon_url === 'https://x.test/f.png' && readIcons.footer?.proxy_icon_url === 'https://media.test/f.png');
  ok('author icon and proxy kept', readIcons.author?.icon_url === 'https://x.test/a.png' && readIcons.author?.proxy_icon_url === 'https://media.test/a.png');
  ok('image and thumbnail proxies kept', readIcons.image_proxy_url === 'https://media.test/i.png' && readIcons.thumbnail_proxy_url === 'https://media.test/t.png');
  ok('a read embed with icons validates', validateEmbeds([readIcons]) === null);
  const sentIcons = embedsToApi([readIcons])[0];
  ok('icons are sent, proxies are not', sentIcons.footer.icon_url === 'https://x.test/f.png' && sentIcons.author.icon_url === 'https://x.test/a.png' && !('proxy_icon_url' in sentIcons.footer) && !('proxy_url' in sentIcons.image));
  // A live discord.js Embed (camelCase getters) must give the same icons and proxies.
  const live = new (Embed as any)({
    title: 't',
    footer: { text: 'f', icon_url: 'https://x.test/f.png', proxy_icon_url: 'https://media.test/f.png' },
    author: { name: 'a', icon_url: 'https://x.test/a.png', proxy_icon_url: 'https://media.test/a.png' },
    image: { url: 'https://x.test/i.png', proxy_url: 'https://media.test/i.png' },
    thumbnail: { url: 'https://x.test/t.png', proxy_url: 'https://media.test/t.png' },
  });
  ok('a real Embed keeps icons and proxies', isDeepStrictEqual(embedToPlain(live), readIcons));
  ok('a real Embed message reads through embedsOf', isDeepStrictEqual(embedsOf({ embeds: [live] })[0], readIcons));
  ok('a bad icon address is rejected', /footer\.icon_url/.test(validateEmbeds([{ footer: { text: 'f', icon_url: 'nope' } }]) ?? ''));
  ok('a string inline flag is rejected', /inline/.test(validateEmbeds([{ fields: [{ name: 'n', value: 'v', inline: 'false' as any }] }]) ?? ''));

  // --- validation
  const v = (e: any) => validateEmbeds(e);
  ok('rejects a non-array', /array/.test(v({}) ?? ''));
  ok('[] is fine (removes embeds)', v([]) === null);
  ok('11 embeds rejected', /At most 10/.test(v(Array.from({ length: 11 }, () => ({ title: 'x' }))) ?? ''));
  ok('title 257 rejected', /title.*256/.test(v([{ title: 'x'.repeat(257) }]) ?? ''));
  ok('title 256 accepted', v([{ title: 'x'.repeat(256) }]) === null);
  ok('description 4097 rejected', /description.*4096/.test(v([{ description: 'x'.repeat(4097) }]) ?? ''));
  ok('26 fields rejected', /26 fields/.test(v([{ fields: Array.from({ length: 26 }, () => ({ name: 'n', value: 'v' })) }]) ?? ''));
  ok('field name 257 rejected', /name.*256/.test(v([{ fields: [{ name: 'x'.repeat(257), value: 'v' }] }]) ?? ''));
  ok('field value 1025 rejected', /value.*1024/.test(v([{ fields: [{ name: 'n', value: 'x'.repeat(1025) }] }]) ?? ''));
  ok('footer 2049 rejected', /footer.*2048/.test(v([{ footer: { text: 'x'.repeat(2049) } }]) ?? ''));
  ok('author name 257 rejected', /author.*256/.test(v([{ author: { name: 'x'.repeat(257) } }]) ?? ''));
  ok('total over 6000 rejected (across embeds)', /6000/.test(v([{ description: 'x'.repeat(4000) }, { description: 'x'.repeat(2100) }]) ?? ''));
  ok('bad color string rejected', /color/.test(v([{ color: 'gold' }]) ?? ''));
  ok('color out of range rejected', /color/.test(v([{ color: 0x1000000 }]) ?? ''));
  ok('integer color accepted', v([{ title: 't', color: 255 }]) === null);
  ok('javascript: url rejected', /http/.test(v([{ url: 'javascript:alert(1)' }]) ?? ''));
  ok('image url must be http(s)', /image_url/.test(v([{ image_url: 'file:///etc/passwd' }]) ?? ''));
  ok('author url must be http(s)', /author\.url/.test(v([{ author: { name: 'a', url: 'ftp://x' } }]) ?? ''));
  ok('an empty embed {} is rejected', /embeds\[0\] is empty/.test(v([{}]) ?? ''));
  ok('an embed of only empty strings is rejected', /is empty/.test(v([{ title: '', description: '' }]) ?? ''));
  ok('an embed with only an empty footer text is rejected', /is empty/.test(v([{ footer: { text: '' } }]) ?? ''));
  ok('an embed with only a colour is rejected', /is empty/.test(v([{ color: 255 }]) ?? ''));
  ok('an embed with only an image is accepted', v([{ image_url: 'https://x.test/i.png' }]) === null);
  ok('the second embed being empty names its index', /embeds\[1\] is empty/.test(v([{ title: 'a' }, {}]) ?? ''));
  ok('an empty field name is rejected', /fields\[0\].*non-empty/.test(v([{ title: 't', fields: [{ name: '', value: 'v' }] }]) ?? ''));
  ok('an empty field value is rejected', /fields\[0\].*non-empty/.test(v([{ title: 't', fields: [{ name: 'n', value: '' }] }]) ?? ''));
  ok('a blank field value is rejected', /non-empty/.test(v([{ title: 't', fields: [{ name: 'n', value: '  ' }] }]) ?? ''));
  ok('bad timestamp rejected', /timestamp/.test(v([{ timestamp: 'soon' }]) ?? ''));

  // --- send and edit paths
  const sent: any[] = [];
  const channel = {
    type: ChannelType.GuildText,
    send: async (o: any) => { sent.push(o); return { id: 's1', guildId: null }; },
  };
  const dc: any = new DiscordClient('owner-1');
  dc.client = { channels: { fetch: async () => channel } };

  await dc.sendMessage('c1', undefined, undefined, undefined, undefined, { ownerDirected: true, embeds: [plain] });
  ok('send with embeds only: no content, API embeds', sent[0].content === undefined && sent[0].embeds?.[0]?.color === 0xc9a24b);
  ok('owner-directed send keeps mention behaviour with embeds', sent[0].allowedMentions === undefined);
  await dc.sendMessage('c1', 'hi', undefined, undefined, undefined, { ownerDirected: true });
  ok('send without embeds adds no embeds key', sent[1].embeds === undefined);

  const edits: any[] = [];
  const msg = { author: { id: 'bot-1' }, edit: async (o: any) => { edits.push(o); } };
  const ec = { type: ChannelType.GuildText, messages: { fetch: async () => msg } };
  const ed: any = new DiscordClient('owner-1');
  ed.client = { channels: { fetch: async () => ec } };
  ed.botUserId = 'bot-1';

  ok('edit with embeds only succeeds', await ed.editMessage('c1', 'm1', undefined, [plain]) === true);
  ok('embeds-only edit leaves content alone', !('content' in edits[0]) && edits[0].embeds[0].title === 'How to Discord');
  ok('text-only edit leaves embeds alone', (await ed.editMessage('c1', 'm1', 'new')) === true && edits[1].content === 'new' && !('embeds' in edits[1]));
  await ed.editMessage('c1', 'm1', undefined, []);
  ok('[] removes the embeds', Array.isArray(edits[2].embeds) && edits[2].embeds.length === 0);
  ed.botUserId = 'someone-else';
  ok('only the bot own messages', (await ed.editMessage('c1', 'm1', undefined, [plain])) === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run();
