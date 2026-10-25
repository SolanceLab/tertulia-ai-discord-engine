// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/reply-as.test.ts */
import './test-env.js';
import { readFileSync } from 'node:fs';
import { parseIdentity } from './config/identity-defaults.js';
import {
  replyCommand, jumpLink, wasDowngradedToPrivate, REPLY_ALLOWED_MENTIONS, handleReplyCommand, REPLY_DRAFT_TTL_MS,
  quoteSnippet, REPLY_DISCARD_PREFIX, formatPublicReply, replyCommandFor, ReplyMemory, REPLY_POST_PREFIX, handleReplyButton, capToPreview, REPLY_EXPIRED, isReplyOwner,
} from './reply-as.js';
import { AsideMemory, StudyAsideQueue, handleAsideCommand } from './aside.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const OWEN = '100000000000000001';
const G = '700000000000000001', C = '700000000000000002', M = '700000000000000003';
let clock = 1_000_000;

// ── command body ──
const body: any = replyCommand('Reply as Bram');
ok('body: message context menu, user install, guild + bot DM + private channel',
  body.type === 3 && JSON.stringify(body.integration_types) === '[1]' && JSON.stringify(body.contexts) === '[0,1,2]' && body.name === 'Reply as Bram');
ok('body: a message command carries no description and no options', !('description' in body) && !('options' in body));
ok('name: default is Reply as <bot name>', replyCommandFor(parseIdentity({ bot_name: 'Bram' })).name === 'Reply as Bram');
ok('name: the deployment can set its own', replyCommandFor(parseIdentity({ bot_name: 'Bram', reply_command: 'Answer for Bram' })).name === 'Answer for Bram');
{
  const warn = console.warn; console.warn = () => {};
  ok('name: an over-long name falls back to the default', replyCommandFor(parseIdentity({ bot_name: 'Bram', reply_command: 'x'.repeat(40) })).name === 'Reply as Bram');
  ok('name: a long bot name is cut to 32', replyCommandFor(parseIdentity({ bot_name: 'B'.repeat(50) })).name.length <= 32);
  console.warn = warn;
}
ok('name: no bot name given still names the bot generically', replyCommandFor(parseIdentity(undefined)).name === 'Reply as the bot');

// ── owner ──
ok('owner: the owner passes', isReplyOwner(OWEN, OWEN));
ok('owner: anyone else fails', !isReplyOwner('999', OWEN));
ok('owner: no owner configured refuses everyone', !isReplyOwner('999', null) && !isReplyOwner(undefined, undefined));

// ── quote + link ──
ok('snippet: short text is kept whole', quoteSnippet('hello there') === 'hello there');
{
  const long = 'word '.repeat(40);
  const q = quoteSnippet(long);
  ok('snippet: long text is cut at about 80 on a word boundary with an ellipsis', q.endsWith('…') && q.length <= 81 && !/\sw?…$/.test(q) && q.slice(0, -1).split(' ').every((w) => w === 'word'));
}
ok('snippet: one long word is cut hard', quoteSnippet('a'.repeat(200)) === `${'a'.repeat(80)}…`);
ok('snippet: markdown is escaped', quoteSnippet('**bold** _it_ ~~x~~ `c` > q # h [l](u)') === '\\*\\*bold\\*\\* \\_it\\_ \\~\\~x\\~\\~ \\`c\\` \\> q \\# h \\[l\\]\\(u\\)');
ok('snippet: newlines collapse to spaces', quoteSnippet('a\n\nb\tc') === 'a b c');
ok('snippet: mention, role and channel tags never carry an id', !/\d{5}/.test(quoteSnippet('hi <@123456789012345678> <@!123456789012345678> <@&123456789012345678> <#123456789012345678> <:wave:123456789012345678>')));
ok('snippet: @everyone is defanged', !/@everyone/.test(quoteSnippet('@everyone @here look')));
ok('link: guild form', jumpLink(G, C, M) === `https://discord.com/channels/${G}/${C}/${M}`);
ok('link: DM form uses @me', jumpLink(null, C, M) === `https://discord.com/channels/@me/${C}/${M}`);
ok('link: a non-id is refused', jumpLink(G, 'x', M) === null && jumpLink('bad', C, M) === null);
{
  const t = formatPublicReply({ authorName: 'Aya *Z*', content: 'what do you think about the plan?', guildId: G, channelId: C, messageId: M, reply: 'I like it.' });
  ok('format: quote line, link, blank line, reply', t === `> **Aya \\*Z\\***: what do you think about the plan?\nhttps://discord.com/channels/${G}/${C}/${M}\n\nI like it.`);
  ok('format: fits Discord\'s 2000', formatPublicReply({ authorName: 'A', content: 'b', guildId: G, channelId: C, messageId: M, reply: 'r'.repeat(5000) }).length <= 2000);
  const dm = formatPublicReply({ authorName: 'A', content: 'b', guildId: null, channelId: C, messageId: M, reply: 'r' });
  ok('format: a DM message links with @me', dm.includes('/channels/@me/'));
}
ok('mentions: parse is empty', Array.isArray(REPLY_ALLOWED_MENTIONS.parse) && REPLY_ALLOWED_MENTIONS.parse.length === 0);

// ── command + buttons ──
function command(opts: { user?: string; name?: string; content?: string | null; target?: boolean; followUp?: (o: any) => Promise<unknown> } = {}) {
  const calls: any[] = [];
  const it: any = {
    commandName: opts.name ?? 'Reply as Bram',
    user: { id: opts.user ?? OWEN },
    channelId: C, guildId: G,
    targetId: M,
    targetMessage: opts.target === false ? null : { id: M, content: opts.content === undefined ? 'are you coming tonight?' : opts.content, channelId: C, author: { id: '5', username: 'aya', globalName: 'Aya' }, member: null },
    isMessageContextMenuCommand: () => true,
    reply: async (o: any) => { calls.push(['reply', o]); },
    deferReply: async (o: any) => { calls.push(['defer', o]); },
    editReply: async (o: any) => { calls.push(['edit', o]); },
    followUp: opts.followUp ?? (async (o: any) => { calls.push(['followUp', o]); return { flags: 0 }; }),
  };
  return { it, calls };
}
function deps(memory: ReplyMemory, text: string | null, seen: any[] = []) {
  return {
    commandName: 'Reply as Bram', ownerUserId: OWEN, memory,
    generate: async (a: string, c: string, g: string | null) => { seen.push({ a, c, g }); return { text }; },
    newId: () => 'd1', log: () => {},
  };
}
function button(customId: string, user = OWEN) {
  const calls: any[] = [];
  return {
    calls,
    it: {
      customId, user: { id: user }, message: { content: 'draft text' },
      reply: async (o: any) => { calls.push(['reply', o]); },
      deferUpdate: async () => { calls.push(['deferUpdate']); },
      editReply: async (o: any) => { calls.push(['edit', o]); },
    },
  };
}
const bdeps = (memory: ReplyMemory, guard: (t: string) => string | null = () => null) => ({ ownerUserId: OWEN, memory, publicGuard: guard, log: () => {} });

async function run() {
  // owner-only
  {
    const mem = new ReplyMemory(() => clock);
    const { it, calls } = command({ user: '999' });
    const seen: any[] = [];
    ok('command: handled', await handleReplyCommand(it, deps(mem, 'hi', seen)));
    ok('command: anyone else gets a short private refusal and no model call', calls.length === 1 && calls[0][0] === 'reply' && calls[0][1].flags === 64 && calls[0][1].content === 'Not available.' && seen.length === 0);
  }
  {
    const { it } = command({ name: 'aside' });
    ok('command: another command is not handled', (await handleReplyCommand(it, deps(new ReplyMemory(), 'x'))) === false);
  }
  // happy path: draft first, post second
  {
    const mem = new ReplyMemory(() => clock);
    const seen: any[] = [];
    const { it, calls } = command();
    await handleReplyCommand(it, deps(mem, 'Yes, I will be there.', seen));
    ok('draft: deferred privately, context is only that message and its author', calls[0][0] === 'defer' && calls[0][1].flags === 64 && seen[0].a === 'Aya' && seen[0].c === 'are you coming tonight?' && seen[0].g === G);
    const edit = calls.find((c) => c[0] === 'edit')[1];
    ok('draft: shows the formatted post, the outside-apps hint, and Post / Discard', edit.content.includes('> **Aya**: are you coming tonight?') && edit.content.includes('Yes, I will be there.') && /outside apps/.test(edit.content) && edit.components[0].components.length === 2);
    ok('draft: nothing public yet', !calls.some((c) => c[0] === 'followUp'));
    const b = button(`${REPLY_POST_PREFIX}d1`);
    await handleReplyButton(b.it, bdeps(mem));
    const fu = calls.find((c) => c[0] === 'followUp')[1];
    ok('post: a PUBLIC follow-up with empty allowed mentions', fu.content.startsWith('> **Aya**') && fu.content.endsWith('Yes, I will be there.') && fu.allowedMentions.parse.length === 0 && !('flags' in fu));
    ok('post: the draft is marked posted and its buttons removed', /Posted in the channel/.test(b.calls.find((c) => c[0] === 'edit')[1].content) && b.calls.find((c) => c[0] === 'edit')[1].components.length === 0);
    const b2 = button(`${REPLY_POST_PREFIX}d1`);
    await handleReplyButton(b2.it, bdeps(mem));
    ok('post: a second tap posts nothing and says it expired', calls.filter((c) => c[0] === 'followUp').length === 1 && b2.calls.find((c) => c[0] === 'edit')[1].content.includes(REPLY_EXPIRED));
  }
  // downgraded
  {
    const mem = new ReplyMemory(() => clock);
    const { it } = command({ followUp: async () => ({ flags: 64 }) });
    await handleReplyCommand(it, deps(mem, 'ok'));
    const b = button(`${REPLY_POST_PREFIX}d1`);
    await handleReplyButton(b.it, bdeps(mem));
    ok('downgrade: told privately that only she can see it', /only you can see it/.test(b.calls.find((c) => c[0] === 'edit')[1].content));
    ok('downgrade: flag shapes', wasDowngradedToPrivate({ flags: 64 }) && wasDowngradedToPrivate({ flags: { has: (f: any) => f === 64 } }) && !wasDowngradedToPrivate({ flags: 0 }) && !wasDowngradedToPrivate({}));
  }
  // failed post keeps the draft
  {
    const mem = new ReplyMemory(() => clock);
    let n = 0;
    const { it } = command({ followUp: async () => { if (n++ === 0) throw new Error('boom'); return { flags: 0 }; } });
    await handleReplyCommand(it, deps(mem, 'ok'));
    const b = button(`${REPLY_POST_PREFIX}d1`);
    await handleReplyButton(b.it, bdeps(mem));
    ok('failure: ambiguous, says to check the channel, buttons removed', /could not confirm/.test(b.calls.find((c) => c[0] === 'edit')[1].content) && b.calls.find((c) => c[0] === 'edit')[1].components.length === 0);
    const b2 = button(`${REPLY_POST_PREFIX}d1`);
    await handleReplyButton(b2.it, bdeps(mem));
    ok('failure: no retry, the draft is spent', n === 1 && b2.calls.find((c) => c[0] === 'edit')[1].content.includes(REPLY_EXPIRED));
  }
    // generation throws after defer: the interaction gets an error edit
  {
    const mem = new ReplyMemory(() => clock);
    const { it, calls } = command();
    const d = { ...deps(mem, 'ok'), generate: async () => { throw new Error('model down'); } };
    await handleReplyCommand(it, d);
    ok('throw after defer: edited with an error, no buttons', /Something went wrong/.test(calls.find((c) => c[0] === 'edit')[1].content));
  }
  // posted reply registers its generation context
  {
    const mem = new ReplyMemory(() => clock);
    const reg: any[] = [];
    const { it } = command({ followUp: async () => ({ id: 'm99', flags: 0 }) });
    await handleReplyCommand(it, { ...deps(mem, 'ok'), generate: async () => ({ text: 'ok', ctx: { k: 1 } }), registerPosted: (id: string, c: unknown) => reg.push([id, c]) });
    await handleReplyButton(button(`${REPLY_POST_PREFIX}d1`).it, bdeps(mem));
    ok('audit: posted message id registered with its ctx', reg.length === 1 && reg[0][0] === 'm99' && (reg[0][1] as any).k === 1);
  }
  // discard, guard, expiry, owner on buttons
  {
    const mem = new ReplyMemory(() => clock);
    const { it, calls } = command();
    await handleReplyCommand(it, deps(mem, 'ok'));
    const b = button(`${REPLY_DISCARD_PREFIX}d1`);
    await handleReplyButton(b.it, bdeps(mem));
    ok('discard: nothing posted', /Nothing was posted/.test(b.calls.find((c) => c[0] === 'edit')[1].content) && !calls.some((c) => c[0] === 'followUp'));
  }
  {
    const mem = new ReplyMemory(() => clock);
    const { it, calls } = command();
    await handleReplyCommand(it, deps(mem, 'hello @everyone'));
    const b = button(`${REPLY_POST_PREFIX}d1`);
    const { massPingReason } = await import('./aside.js');
    await handleReplyButton(b.it, bdeps(mem, massPingReason));
    ok('guard: the public-register guard refuses a mass ping and nothing is posted', /Not posted/.test(b.calls.find((c) => c[0] === 'edit')[1].content) && !calls.some((c) => c[0] === 'followUp'));
  }
  {
    const mem = new ReplyMemory(() => clock);
    const { it } = command();
    await handleReplyCommand(it, deps(mem, 'ok'));
    clock += REPLY_DRAFT_TTL_MS + 1;
    const b = button(`${REPLY_POST_PREFIX}d1`);
    await handleReplyButton(b.it, bdeps(mem));
    ok('expiry: after 15 minutes Post says right-click the message again', b.calls.find((c) => c[0] === 'edit')[1].content.includes('right-click the message again'));
  }
  {
    const mem = new ReplyMemory(() => clock);
    const b = button(`${REPLY_POST_PREFIX}d1`, '999');
    await handleReplyButton(b.it, bdeps(mem));
    ok('buttons: anyone else is refused', b.calls[0][0] === 'reply' && b.calls[0][1].content === 'Not available.');
    const other = button('aside-post:x');
    ok('buttons: another feature\'s button is not handled', (await handleReplyButton(other.it, bdeps(mem))) === false);
  }
  // edge cases
  {
    const { it, calls } = command({ content: '   ' });
    await handleReplyCommand(it, deps(new ReplyMemory(), 'x'));
    ok('empty message: private notice, no model call', calls[0][0] === 'reply' && /no text/.test(calls[0][1].content));
    const nothing = command();
    await handleReplyCommand(nothing.it, deps(new ReplyMemory(), null));
    ok('no answer: told to try again, no buttons', /Nothing came back/.test(nothing.calls.find((c) => c[0] === 'edit')[1].content) && nothing.calls.find((c) => c[0] === 'edit')[1].components.length === 0);
  }

  // preview == post: a long reply never publishes text the owner did not see
  {
    const mem = new ReplyMemory(() => clock);
    const { it, calls } = command();
    await handleReplyCommand(it, deps(mem, 'x'.repeat(1990)));
    const shown = calls.find((c) => c[0] === 'edit')[1].content as string;
    const b = button(`${REPLY_POST_PREFIX}d1`);
    await handleReplyButton(b.it, bdeps(mem));
    const posted = calls.find((c) => c[0] === 'followUp')[1].content as string;
    ok('long reply: the posted text is fully visible in the preview', shown.includes(posted) && posted.length <= 1800 && posted.endsWith('…'));
    ok('capToPreview: short text is untouched, long text is cut to 1800', capToPreview('hi') === 'hi' && capToPreview('y'.repeat(2000)).length === 1800);
  }
  // untrusted message text stays out of the system prompt
  {
    const src = readFileSync(new URL('./presence-engine.ts', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('async replyToMessage('), src.indexOf('async respond('));
    const sys = fn.slice(fn.indexOf('const system ='), fn.indexOf('const userContent'));
    ok('replyToMessage: system prompt holds no author name or message content', !/authorName|\$\{content\}/.test(sys));
    ok('replyToMessage: author and message travel as user content', /const userContent = `Message from \$\{authorName\}:\\n\$\{content\}/.test(fn));
  }

  // ── registration script ──
  const script = readFileSync(new URL('../scripts/register-aside.mjs', import.meta.url), 'utf8');
  ok('register script: --reply builds replyCommand with the identity\'s reply name',
    /args\.includes\('--reply'\)/.test(script) && /replyCommand\(name\)/.test(script) && /identity\.reply_command/.test(script) && /method: 'POST'/.test(script) && !/method: 'PUT'/.test(script));

  // The draft's 15 minutes run from the right-click, not from when the reply was ready.
  {
    let t = 1_000_000;
    const mem = new ReplyMemory(() => t);
    mem.put('late', { text: 'x', reply: 'x', followUp: async () => ({}) } as any, t - 14 * 60_000);
    t += 2 * 60_000;
    ok('a draft expires 15 minutes after the right-click, even if writing took a while', mem.take('late') === null);
  }
  {
    const { defaultReplyName, isValidReplyName } = await import('./config/identity-defaults.js');
    const name = defaultReplyName('Café 🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙🌙');
    ok('the default name is cut by characters, never inside an emoji', [...name].length <= 32 && !/[\uD800-\uDBFF]$/.test(name) && isValidReplyName(name));
  }
  {
    const { displayNameOf } = await import('./reply-as.js');
    const msg = { id: 'm', author: { id: 'u', username: 'fern', globalName: 'shosho' }, member: null };
    ok('the server nickname from the click wins where the bot is not a member', displayNameOf(msg, { nick: 'Rook Vale' }) === 'Rook Vale');
    ok('a member without a nickname falls back to the global name', displayNameOf(msg, { nick: null }) === 'shosho');
    ok('a cached member display name still wins', displayNameOf({ ...msg, member: { displayName: 'Cached Nick' } }, { nick: 'Other' }) === 'Cached Nick');
  }
  // /followup continues a Reply as (the aside history is shared)
  {
    const hist = new AsideMemory(() => clock);
    const mem = new ReplyMemory(() => clock);
    const d = { ...deps(mem, 'Yes, I will be there.'), history: hist };
    const { it } = command();
    await handleReplyCommand(it, d);
    const turns = hist.turns(C);
    ok('history: the draft is recorded with the author name and the draft as the bot turn',
      turns.length === 1 && turns[0].question.includes('Aya') && turns[0].note === 'Yes, I will be there.' && !turns[0].posted);
    ok("history: the other person's words never enter the owner's slot (guest text stays out of /followup)",
      !turns[0].question.includes('are you coming tonight?'));
    ok('history: other channels are unaffected', hist.turns('700000000000000099').length === 0);
    ok('history: entries hold text only (no functions, no tokens)', JSON.stringify(turns[0]) === JSON.stringify({ ...turns[0] }) && Object.values(turns[0]).every((v) => typeof v !== 'function'));
    await handleReplyButton(button(`${REPLY_POST_PREFIX}d1`).it, bdeps(mem));
    ok('history: Post marks the entry posted', hist.turns(C)[0].posted === true);

    // /followup to the model path (aside) sees it
    const seen: any[] = [];
    const fc: any = { commandName: 'bram', user: { id: OWEN }, channelId: C, guildId: G, options: { getString: (n: string) => (n === 'message' ? 'and add a thanks' : null) },
      reply: async () => {}, deferReply: async () => {}, editReply: async () => {}, followUp: async () => ({}) };
    await handleAsideCommand(fc, {
      commandName: 'bram', ownerUserId: OWEN, memory: hist, readChannel: async () => ({ channelName: 'room', window: [] }),
      aside: async (_n: string, _w: unknown[], _q: string, history: any[]) => { seen.push(history); return { note: 'ok', proposal: null }; },
      newId: () => 'x', log: () => {},
    } as any);
    ok('followup (model): history carries the Reply as draft', seen[0]?.length === 1 && seen[0][0].note === 'Yes, I will be there.');

    // /followup to the Study queue has non-empty history
    const q = new StudyAsideQueue(() => clock);
    const fc2: any = { ...fc, commandName: 'followup' };
    await handleAsideCommand(fc2, {
      commandName: 'bram', followupName: 'followup', ownerUserId: OWEN, memory: hist, readChannel: async () => ({ channelName: 'room', window: [] }),
      aside: async () => ({ note: 'x', proposal: null }), newId: () => 'q1', log: () => {}, studyQueue: q, now: () => clock,
    } as any);
    const item = q.pending()[0];
    ok('followup (study): queue item history is non-empty and holds the draft', Boolean(item) && item.history.length >= 1 && item.history[0].note === 'Yes, I will be there.');
  }
  {
    const hist = new AsideMemory(() => clock);
    const before = clock;
    await handleReplyCommand(command().it, { ...deps(new ReplyMemory(() => clock), 'ok'), history: hist });
    clock += 31 * 60_000;
    ok('history: same TTL as the aside history', hist.turns(C).length === 0);
    clock = before;
  }
  {
    const t = formatPublicReply({ authorName: 'A', content: 'x', channelId: C, messageId: M, reply: 'hi <@123456789012345678>' });
    ok('formatPublicReply: a tagged user in the reply becomes a plain word (a channel post would ping)', t.endsWith('hi @someone'));
  }
  // Post goes out as a plain channel message; history matches what was posted; identical drafts are told apart
  {
    const mem = new ReplyMemory(() => clock);
    const { it, calls } = command();
    await handleReplyCommand(it, deps(mem, 'plain please'));
    const sentTo: any[] = [];
    const b = button(`${REPLY_POST_PREFIX}d1`);
    await handleReplyButton(b.it, { ...bdeps(mem), post: async (ch: string, t: string, r?: string) => { sentTo.push([ch, t, r as string]); return { id: 'p1', flags: 0 }; } });
    ok('post (plain): sent as a channel message, no command follow-up', sentTo.length === 1 && sentTo[0][0] === C && sentTo[0][1].endsWith('plain please') && !calls.some((c) => c[0] === 'followUp'));
    ok('post (plain): attached to the clicked message as a native reply', sentTo[0][2] === M);
    ok('post (plain): the card says posted', /Posted in the channel/.test(b.calls.find((c) => c[0] === 'edit')[1].content));
  }
  {
    const mem = new ReplyMemory(() => clock);
    const { it, calls } = command();
    await handleReplyCommand(it, deps(mem, 'fallback'));
    await handleReplyButton(button(`${REPLY_POST_PREFIX}d1`).it, { ...bdeps(mem), post: async () => 'no-access' as const });
    ok('post (plain): where the bot cannot send, it falls back to the command follow-up', calls.filter((c) => c[0] === 'followUp').length === 1);
  }
  {
    const mem = new ReplyMemory(() => clock);
    const { it, calls } = command();
    await handleReplyCommand(it, deps(mem, 'retry me'));
    const b = button(`${REPLY_POST_PREFIX}d1`);
    await handleReplyButton(b.it, { ...bdeps(mem), post: async () => null });
    ok('post (plain): a send that failed posts nothing and keeps the draft', !calls.some((c) => c[0] === 'followUp') && mem.take('d1') !== null && /nothing was sent/.test(b.calls.find((c) => c[0] === 'edit')[1].content));
  }
  {
    const hist = new AsideMemory(() => clock);
    const mem = new ReplyMemory(() => clock);
    await handleReplyCommand(command().it, { ...deps(mem, 'z'.repeat(3000)), history: hist });
    const note = hist.turns(C)[0].note;
    const posted = mem.take('d1')!.text;
    ok('history: a long reply is recorded as posted (cut), not the full model text', note.length < 1800 && note.endsWith('…') && posted.endsWith(note) && hist.turns(C)[0].proposal === note);
  }
  {
    const hist = new AsideMemory(() => clock);
    const mem = new ReplyMemory(() => clock);
    let n = 0;
    const d = { ...deps(mem, 'same words'), history: hist, newId: () => `id${++n}` };
    await handleReplyCommand(command().it, d);
    await handleReplyCommand(command().it, d);
    await handleReplyButton(button(`${REPLY_POST_PREFIX}id1`).it, bdeps(mem));
    const t = hist.turns(C);
    ok('history: posting the older of two identical drafts marks that one, not the newer', t.length === 2 && t[0].posted === true && !t[1].posted);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();
