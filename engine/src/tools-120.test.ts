// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Tertúlia 1.2.0 tools: list_servers, unpin_message, list_pins, remove_reaction, read_audit_log,
 * edit_thread, thread_member. Mapping, guards and validation, against fake discord.js objects.
 *
 * Run: npx tsx src/tools-120.test.ts
 */
import './test-env.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogEvent, ChannelType } from 'discord.js';
import {
  unpinMessage, readAuditLog, setThreadMember, removeOwnReaction, describeServers, fetchPinnedMessages, editThread,
} from './discord/admin.js';
import { mapMessagesForApi } from './discord/message-api.js';
import { ToolRefusal } from './role-admin.js';
import { buildToolDefinitions } from './mcp/shared/definitions.js';
import { z } from 'zod';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}
async function refused(p: Promise<unknown>, part?: string): Promise<boolean> {
  try { await p; return false; } catch (e) { return e instanceof ToolRefusal && (!part || e.message.includes(part)); }
}

const HOME = '700000000000000001';
const OTHER = '700000000000000999';
const BOT = 'bot-1';

// ---- list_servers
{
  const guild = (id: string, name: string, extra: any = {}) => ({
    id, name, memberCount: 12, iconURL: () => `https://cdn/${id}.png`, description: 'about', ownerId: 'own-1',
    createdAt: new Date('2025-01-02T03:04:05Z'), features: ['COMMUNITY'],
    members: { me: { roles: { cache: new Map([[id, { id, name: '@everyone' }], ['r1', { id: 'r1', name: 'Tertulia' }]]) } } },
    ...extra,
  });
  // roles.cache.filter/map on a Map-like: give it the Collection methods the code uses
  const withColl = (g: any) => {
    const m: Map<string, any> = g.members.me.roles.cache;
    (m as any).filter = (fn: (r: any) => boolean) => { const o: any = new Map([...m].filter(([, r]) => fn(r))); o.map = (f: any) => [...o.values()].map(f); return o; };
    return g;
  };
  const home = withColl(guild(HOME, 'Home')), other = withColl(guild(OTHER, 'Other'));
  const client: any = {
    guilds: { cache: new Map([[HOME, home], [OTHER, other]]), fetch: async (id: string) => { if (id === HOME) return home; if (id === OTHER) return other; throw new Error('Unknown Guild'); } },
    user: { id: BOT },
  };
  const all: any = await describeServers(client);
  ok('list_servers lists id, name, member_count, icon_url, is_home', all.servers.length === 2
    && all.servers[0].id === HOME && all.servers[0].member_count === 12 && all.servers[0].icon_url === `https://cdn/${HOME}.png` && all.servers[0].is_home === true && all.servers[1].is_home === false);
  const one: any = await describeServers(client, OTHER);
  ok('list_servers one server: description, owner, created_at, features, bot roles (without @everyone)',
    one.server.description === 'about' && one.server.owner_id === 'own-1' && one.server.created_at === '2025-01-02T03:04:05.000Z'
    && one.server.features[0] === 'COMMUNITY' && one.server.bot_roles.length === 1 && one.server.bot_roles[0].name === 'Tertulia' && one.server.is_home === false);
  ok('list_servers refuses a server the bot is not in', await refused(describeServers(client, '123'), 'not in a server'));
}

// ---- pins, reactions
function msgChannel(messages: Map<string, any>, extra: any = {}) {
  const log: string[] = [];
  const channel: any = {
    type: ChannelType.GuildText, guildId: HOME,
    messages: {
      fetch: async (id: string) => { const m = messages.get(id); if (!m) throw new Error('Unknown Message'); return m; },
      fetchPins: async (o: any) => { log.push('pins:' + o.limit); return { items: [...messages.values()].map((message) => ({ message })), hasMore: false }; },
    },
    ...extra,
  };
  const client: any = { user: { id: BOT }, channels: { fetch: async (id: string) => (id === 'c' ? channel : null) } };
  return { client, log };
}
{
  const log: string[] = [];
  const pinned = { id: 'm1', pinned: true, unpin: async () => { log.push('unpin'); } };
  const loose = { id: 'm2', pinned: false, unpin: async () => { log.push('unpin2'); } };
  const { client } = msgChannel(new Map([['m1', pinned], ['m2', loose]]));
  ok('unpin_message unpins a pinned message', await unpinMessage(client, 'c', 'm1') === true && log.join() === 'unpin');
  ok('unpin_message refuses a message that is not pinned', await refused(unpinMessage(client, 'c', 'm2'), 'not pinned') && !log.includes('unpin2'));
  ok('unpin_message refuses a channel that holds no messages', await refused(unpinMessage(client, 'nope', 'm1'), 'not found'));
}
{
  const msgs = new Map([['m1', { id: 'm1' }], ['m2', { id: 'm2' }]]);
  const { client, log } = msgChannel(msgs);
  const out = await fetchPinnedMessages(client, 'c', 500);
  ok('list_pins returns the pinned messages, limit capped at 50', out.length === 2 && log[0] === 'pins:50');
  await fetchPinnedMessages(client, 'c', 0);
  ok('list_pins limit has a floor of 1', log[1] === 'pins:1');
}
{
  // the mapping list_pins shares with read_messages, embeds included
  const msg: any = {
    id: 'm1', content: 'hello', createdAt: new Date('2026-10-21T10:00:00Z'),
    author: { id: 'u1', tag: 'ann#0' }, guild: { id: HOME },
    attachments: { map: (f: any) => [{ name: 'a.png', url: 'https://x/a.png', contentType: 'image/png', width: 1, height: 2 }].map(f) },
    embeds: [{ title: 'Card', description: 'Body', fields: [{ name: 'k', value: 'v', inline: false }], data: {} }],
    reference: null,
  };
  const dc: any = { resolveDisplayNames: async () => new Map([['u1', 'Ann']]) };
  const [m]: any = await mapMessagesForApi(dc, [msg]);
  ok('pins use the read_messages shape: author name, attachments, embeds', m.id === 'm1' && m.author === 'Ann' && m.authorId === 'u1'
    && m.attachments[0].name === 'a.png' && m.embeds?.[0]?.title === 'Card' && m.embeds[0].fields[0].name === 'k' && m.timestamp === '2026-10-21T10:00:00.000Z');
}
{
  const removed: string[] = [];
  const mk = (emoji: any, me: boolean) => ({ emoji, me, users: { remove: async (id: string) => { removed.push(id); } } });
  const reactions = [mk({ id: null, name: '👍' }, true), mk({ id: '555', name: 'blob' }, true), mk({ id: null, name: '🔥' }, false)];
  const cache: any = reactions; cache.find = Array.prototype.find.bind(reactions);
  const { client } = msgChannel(new Map([['m1', { id: 'm1', reactions: { cache } }]]));
  ok('remove_reaction removes the bot\'s own unicode reaction', await removeOwnReaction(client, 'c', 'm1', '👍') === true && removed.join() === BOT);
  ok('remove_reaction removes the bot\'s own custom reaction (<:name:id>)', await removeOwnReaction(client, 'c', 'm1', '<:blob:555>') === true && removed.length === 2);
  ok('remove_reaction refuses someone else\'s reaction', await refused(removeOwnReaction(client, 'c', 'm1', '🔥'), 'only the bot') && removed.length === 2);
  ok('remove_reaction refuses an emoji that is not on the message', await refused(removeOwnReaction(client, 'c', 'm1', '🎉'), 'No '));
  ok('remove_reaction requires an emoji', await refused(removeOwnReaction(client, 'c', 'm1', '  '), 'emoji is required'));
}

// ---- audit log
{
  const calls: any[] = [];
  const entry = {
    id: 'e1', action: AuditLogEvent.MemberKick, executorId: 'x1', executor: { tag: 'mod#1' }, targetId: 't1', targetType: 'User',
    reason: 'spam', createdAt: new Date('2026-10-20T00:00:00Z'), changes: [{ key: 'nick', old: 'a', new: 'b'.repeat(300) }],
  };
  const guild = { fetchAuditLogs: async (o: any) => { calls.push(o); return { entries: new Map([['e1', entry]]) }; } };
  const client: any = { guilds: { fetch: async () => guild } };
  const out = await readAuditLog(client, HOME, { action: 'memberkick', userId: 'x1', limit: 500 });
  ok('audit log maps who, what, when, target and reason', out.entries[0].action === 'MemberKick' && out.entries[0].executor_id === 'x1'
    && out.entries[0].executor === 'mod#1' && out.entries[0].target_id === 't1' && out.entries[0].reason === 'spam' && out.entries[0].created_at === '2026-10-20T00:00:00.000Z');
  ok('audit log passes action by name, user and a limit capped at 50', calls[0].type === AuditLogEvent.MemberKick && calls[0].user === 'x1' && calls[0].limit === 50);
  ok('audit log clips long change values', String(out.entries[0].changes[0].new).length < 210);
  await readAuditLog(client, HOME);
  ok('audit log default limit is 25 with no filters', calls[1].limit === 25 && calls[1].type === undefined && calls[1].user === undefined);
  ok('audit log refuses a non-home server and never calls Discord', await refused(readAuditLog(client, OTHER), 'home server only') && calls.length === 2);
  ok('audit log refuses an unknown action name', await refused(readAuditLog(client, HOME, { action: 'Nope' }), 'Unknown audit action') && calls.length === 2);
}

// ---- threads
function threadClient(thread: any) {
  const edits: any[] = [];
  const t: any = {
    id: 'th1', name: 'old', archived: false, locked: false, autoArchiveDuration: 1440, guildId: HOME, ownerId: BOT,
    isThread: () => true, ...thread,
    edit: async (o: any) => { edits.push(o); return { ...t, ...o, archived: o.archived ?? t.archived, locked: o.locked ?? t.locked, name: o.name ?? t.name, autoArchiveDuration: o.autoArchiveDuration ?? t.autoArchiveDuration }; },
  };
  const members: string[] = [];
  t.members = { add: async (u: string) => { members.push('add:' + u); }, remove: async (u: string) => { members.push('remove:' + u); } };
  const client: any = { user: { id: BOT }, channels: { fetch: async (id: string) => (id === 'th1' ? t : id === 'ch' ? { isThread: () => false } : null) } };
  return { client, edits, members };
}
{
  let { client, edits } = threadClient({});
  const r = await editThread(client, 'th1', { name: ' New ', archived: true, locked: true, autoArchiveMinutes: 60 });
  ok('edit_thread in the home server: rename, archive, lock, auto-archive in one call', edits[0].name === 'New' && edits[0].archived === true && edits[0].locked === true
    && edits[0].autoArchiveDuration === 60 && r.name === 'New' && r.archived === true && r.locked === true && r.auto_archive_minutes === 60);
  ok('edit_thread refuses an empty change', await refused(editThread(client, 'th1', {}), 'at least one change'));
  ok('edit_thread refuses a bad name', await refused(editThread(client, 'th1', { name: ' ' }), 'name must be') && await refused(editThread(client, 'th1', { name: 'x'.repeat(101) }), 'name must be'));
  ok('edit_thread refuses a bad auto-archive time', await refused(editThread(client, 'th1', { autoArchiveMinutes: 30 }), 'auto_archive_minutes'));
  ok('edit_thread refuses a channel that is not a thread', await refused(editThread(client, 'ch', { name: 'x' }), 'not a thread'));
  ok('edit_thread nothing was edited by the refusals', edits.length === 1);

  ({ client, edits } = threadClient({ guildId: OTHER, ownerId: BOT }));
  await editThread(client, 'th1', { name: 'mine', archived: true });
  ok('edit_thread renames and archives a thread the bot created in another server', edits.length === 1);
  ok('edit_thread refuses to lock outside the home server, even the bot\'s own thread', await refused(editThread(client, 'th1', { locked: true }), 'home server only') && edits.length === 1);

  ({ client, edits } = threadClient({ guildId: OTHER, ownerId: 'someone' }));
  ok('edit_thread refuses someone else\'s thread outside the home server', await refused(editThread(client, 'th1', { name: 'x' }), 'only threads it created') && edits.length === 0);

  ({ client, edits } = threadClient({ ownerId: 'someone' }));
  await editThread(client, 'th1', { archived: true });
  ok('edit_thread archives any thread in the home server', edits.length === 1);
}
{
  let { client, members } = threadClient({});
  ok('thread_member adds in the home server', await setThreadMember(client, 'th1', 'u9', 'add') === true && members.join() === 'add:u9');
  await setThreadMember(client, 'th1', 'u9', 'remove');
  ok('thread_member removes in the home server', members[1] === 'remove:u9');
  ok('thread_member refuses an action that is not add or remove', await refused(setThreadMember(client, 'th1', 'u9', 'kick'), 'add or remove') && members.length === 2);
  ({ client, members } = threadClient({ guildId: OTHER }));
  ok('thread_member refuses outside the home server', await refused(setThreadMember(client, 'th1', 'u9', 'add'), 'home server only') && members.length === 0);
}

// ---- no home server configured: the home-only tools refuse
{
  const dir = mkdtempSync(join(tmpdir(), 'tools120-'));
  const cfg = join(dir, 'house.json');
  writeFileSync(cfg, JSON.stringify({ plugs: { model: 'sanctum', settings: 'solance-api', memory: 'sanctum' } }));
  const script = join(dir, 'probe.ts');
  writeFileSync(script, `
    import ${JSON.stringify(join(process.cwd(), 'src/discord/admin.ts'))};
    import { assertHomeServerOnly } from ${JSON.stringify(join(process.cwd(), 'src/role-admin.ts'))};
    try { assertHomeServerOnly('123', 'reading the audit log'); console.log('ALLOWED'); }
    catch (e: any) { console.log('REFUSED:' + e.message); }
  `);
  const r = spawnSync('npx', ['tsx', script], { encoding: 'utf8', env: { ...process.env, HOUSE_CONFIG_PATH: cfg }, cwd: process.cwd() });
  ok('with no home server configured, home-only tools refuse with a clear message', /REFUSED:.*no home server is configured/.test(r.stdout));
}

// ---- definitions: the nothing-to-change check and the frozen order
{
  const defs = buildToolDefinitions(z);
  const edit = defs.find((d) => d.name === 'discord_edit_thread')!;
  ok('edit_thread definition refuses an empty change before any call', typeof edit.check?.({ thread_id: 't' }) === 'string' && edit.check?.({ thread_id: 't', locked: false }) === null);
  const tm = defs.find((d) => d.name === 'discord_thread_member')!;
  ok('thread_member action accepts only add or remove', tm.shape.action.safeParse('add').success && !tm.shape.action.safeParse('ban').success);
  ok('the audit log tool tells callers never to repost entries publicly', /never repost/i.test(defs.find((d) => d.name === 'discord_read_audit_log')!.description));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
