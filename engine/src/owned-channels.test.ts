// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Keeping a member's new channel their own: the decision, and the owner's note.
 * Run: npx tsx src/owned-channels.test.ts
 */
import './test-env.js';
import {
  type LockDeps, type OverwriteLike, type OverwriteEdit, MANAGE_WEBHOOKS, decideOwnedChannel, type ChannelLike, lockChannel, looksUnlocked,
  MANAGE_CHANNELS, SWEEP_LOOKBACK_MS, findAuditWithRetry, type OwnedChannelInput, MANAGE_ROLES, type AuditEntryLike, sweepOwnedChannels,
} from './owned-channels.js';
import { ownedChannelNotice, ownedChannelSweepNotice, ownedChannelFailureNotice } from './discord-client.js';
import { parseHouseConfig, GENERIC_DEFAULTS } from './config/house-config.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } }

const NOW = 1_000_000_000;
const base = (over: Partial<OwnedChannelInput> = {}): OwnedChannelInput => ({
  channelId: 'ch1',
  parentId: 'cat1',
  overwrites: [
    { id: 'roleGuest', type: 'role', allow: MANAGE_CHANNELS | 0x400n, deny: 0n },
    { id: 'roleOther', type: 'role', allow: 0x400n, deny: 0n },
  ],
  categoryIds: ['cat1'],
  audit: { targetId: 'ch1', executorId: 'u1', createdTimestamp: NOW - 2000 },
  creator: { isBot: false, isAdmin: false },
  nowMs: NOW,
  ...over,
});

const d = decideOwnedChannel(base());
ok('a member in a listed category gets the lock', d.action === 'lock' && d.creatorId === 'u1');
ok('the creator is given Manage Channels as a member overwrite', d.action === 'lock' && d.edits.some((e) => e.type === 'member' && e.id === 'u1' && e.op === 'grant'));
ok('the role that allowed Manage Channels loses it', d.action === 'lock' && d.edits.some((e) => e.type === 'role' && e.id === 'roleGuest' && e.op === 'strip' && e.clear.join() === 'ManageChannels'));
ok('a role that never allowed it is left alone', d.action === 'lock' && !d.edits.some((e) => e.id === 'roleOther'));

const mask = decideOwnedChannel(base({ overwrites: [
  { id: 'roleA', type: 'role', allow: MANAGE_ROLES | 0x400n, deny: 0n },
  { id: 'roleB', type: 'role', allow: MANAGE_WEBHOOKS, deny: 0n },
  { id: 'u2', type: 'member', allow: MANAGE_CHANNELS, deny: 0n },
  { id: 'u1', type: 'member', allow: MANAGE_CHANNELS | MANAGE_ROLES, deny: 0n },
] }));
ok('a role overwrite allowing Manage Roles (1<<28) is stripped of it', mask.action === 'lock' && mask.edits.some((e) => e.id === 'roleA' && e.op === 'strip' && e.clear.join() === 'ManageRoles'));
ok('a role overwrite allowing Manage Webhooks is stripped of it', mask.action === 'lock' && mask.edits.some((e) => e.id === 'roleB' && e.op === 'strip' && e.clear.join() === 'ManageWebhooks'));
ok('another member overwrite allowing Manage Channels is stripped', mask.action === 'lock' && mask.edits.some((e) => e.id === 'u2' && e.type === 'member' && e.op === 'strip'));
ok('the creator keeps their own overwrite untouched', mask.action === 'lock' && !mask.edits.some((e) => e.id === 'u1'));

const own = decideOwnedChannel(base({ overwrites: [{ id: 'u1', type: 'member', allow: MANAGE_CHANNELS, deny: 0n }] }));
ok('already locked: nothing to change (idempotent)', own.action === 'none' && own.reason === 'already_locked');
const ownDeny = decideOwnedChannel(base({ overwrites: [{ id: 'u1', type: 'member', allow: MANAGE_CHANNELS, deny: 0n }, { id: 'roleStaff', type: 'role', allow: 0n, deny: MANAGE_CHANNELS }] }));
ok('a role that only denies, or holds the bit server-wide, gets no edit', ownDeny.action === 'none' && ownDeny.reason === 'already_locked');

const half = decideOwnedChannel(base({ overwrites: [{ id: 'u1', type: 'member', allow: MANAGE_CHANNELS, deny: 0n }, { id: 'roleGuest', type: 'role', allow: MANAGE_CHANNELS, deny: 0n }] }));
ok('owner kept, only the role is stripped on a second pass', half.action === 'lock' && half.edits.length === 1 && half.edits[0].id === 'roleGuest');
const old = decideOwnedChannel(base({ audit: { targetId: 'ch1', executorId: 'u1', createdTimestamp: NOW - 20 * 86_400_000 }, maxAgeMs: SWEEP_LOOKBACK_MS }));
ok('the sweep accepts a creator found up to 45 days back', old.action === 'lock');

const adm = decideOwnedChannel(base({ creator: { isBot: false, isAdmin: true } }));
ok('an admin creator is ignored', adm.action === 'none' && adm.reason === 'creator_admin');
const bot = decideOwnedChannel(base({ creator: { isBot: true, isAdmin: false } }));
ok('a bot creator is ignored', bot.action === 'none' && bot.reason === 'creator_bot');
const other = decideOwnedChannel(base({ parentId: 'elsewhere' }));
ok('a category that is not listed is ignored', other.action === 'none' && other.reason === 'not_listed');
const noParent = decideOwnedChannel(base({ parentId: null }));
ok('a channel with no category is ignored', noParent.action === 'none' && noParent.reason === 'not_listed');
const off = decideOwnedChannel(base({ categoryIds: [] }));
ok('no configured categories = off', off.action === 'none' && off.reason === 'not_listed');
const none = decideOwnedChannel(base({ audit: null }));
ok('no audit entry: no change, with a reason to log', none.action === 'none' && none.reason === 'no_audit_entry');
const stale = decideOwnedChannel(base({ audit: { targetId: 'ch1', executorId: 'u1', createdTimestamp: NOW - 31_000 } }));
ok('an audit entry older than 30 s is not trusted', stale.action === 'none' && stale.reason === 'no_audit_entry');
const wrong = decideOwnedChannel(base({ audit: { targetId: 'chX', executorId: 'u1', createdTimestamp: NOW } }));
ok('an audit entry for another channel is not trusted', wrong.action === 'none' && wrong.reason === 'no_audit_entry');
const unk = decideOwnedChannel(base({ creator: null }));
ok('a creator who cannot be looked up: no change', unk.action === 'none' && unk.reason === 'creator_unknown');

// ── glue with a fake guild ──
function fakeChannel(id: string, overwrites: OverwriteLike[], failOn: string[] = []): ChannelLike & { applied: OverwriteEdit[] } {
  const applied: OverwriteEdit[] = [];
  return {
    id, name: `room-${id}`, parentId: 'cat1', applied,
    overwrites: () => overwrites,
    apply: async (e) => { if (failOn.includes(e.id)) throw new Error('Missing Permissions'); applied.push(e); },
  };
}
const audit1: AuditEntryLike = { targetId: 'ch1', executorId: 'u1', createdTimestamp: NOW - 1000 };
function deps(over: Partial<LockDeps> = {}) {
  const failed: string[] = [], locked: string[] = [];
  const d: LockDeps = {
    categoryIds: ['cat1'], audit: async () => audit1,
    creator: async () => ({ isBot: false, isAdmin: false, name: 'Mira' }), nowMs: () => NOW,
    onLocked: ({ channel }) => locked.push(channel.id), onFailed: ({ reason }) => failed.push(reason), log: () => {}, ...over,
  };
  return { d, failed, locked };
}
const roleHas = (id: string): OverwriteLike => ({ id, type: 'role', allow: MANAGE_ROLES, deny: 0n });
await (async () => {
  { const ch = fakeChannel('ch1', [roleHas('r1')]); const { d, locked, failed } = deps();
    const out = await lockChannel(ch, d);
    ok('glue: a good lock applies the grant and the strip and tells the owner', out.status === 'locked' && ch.applied.length === 2 && locked.length === 1 && failed.length === 0); }
  { const ch = fakeChannel('ch1', [roleHas('r1'), roleHas('r2')], ['r1']); const { d, locked, failed } = deps();
    const out = await lockChannel(ch, d);
    ok('glue: one failed edit does not stop the others, and is reported', out.status === 'failed' && ch.applied.length === 2 && locked.length === 0 && failed.length === 1 && /permission edit failed/.test(failed[0])); }
  { const ch = fakeChannel('ch1', [roleHas('r1')]); const { d, failed } = deps({ audit: async () => null });
    const out = await lockChannel(ch, d);
    ok('glue: no audit entry in a listed category is reported, not silent', out.status === 'failed' && failed.length === 1 && /audit log/.test(failed[0]) && ch.applied.length === 0); }
  { const ch = fakeChannel('ch1', [roleHas('r1')]); const { d, failed } = deps({ creator: async () => null });
    const out = await lockChannel(ch, d);
    ok('glue: a creator who cannot be fetched is reported', out.status === 'failed' && failed.length === 1 && /who made it/.test(failed[0])); }
  { const ch = fakeChannel('ch1', [roleHas('r1')]); const { d, failed } = deps({ creator: async () => { throw new Error('boom'); } });
    const out = await lockChannel(ch, d);
    ok('glue: a member fetch error is reported', out.status === 'failed' && failed.length === 1); }
  { const ch = fakeChannel('ch1', [roleHas('r1')]); const { d, failed, locked } = deps({ creator: async () => ({ isBot: false, isAdmin: true }) });
    const out = await lockChannel(ch, d);
    ok('glue: an admin creator is skipped quietly', out.status === 'skipped' && failed.length === 0 && locked.length === 0); }
  { const ch = { ...fakeChannel('ch1', [roleHas('r1')]), parentId: 'elsewhere' }; const { d, failed } = deps();
    const out = await lockChannel(ch, d);
    ok('glue: a channel outside the listed categories is ignored', out.status === 'skipped' && failed.length === 0); }

  // audit retry: 1, 2, 4, 8 s
  { const waits: number[] = []; let n = 0;
    const got = await findAuditWithRetry(async () => (++n === 4 ? audit1 : null), async (ms) => { waits.push(ms); });
    ok('retry: waits 1, 2, 4 s and stops at the first hit', got === audit1 && waits.join() === '1000,2000,4000'); }
  { const waits: number[] = [];
    const got = await findAuditWithRetry(async () => null, async (ms) => { waits.push(ms); });
    ok('retry: gives up after 1, 2, 4, 8 s', got === null && waits.join() === '1000,2000,4000,8000'); }

  // the catch-up sweep
  const sweepDeps = (chs: ChannelLike[], entries: Record<string, AuditEntryLike>, over: Partial<LockDeps> = {}) => {
    const summaries: string[][] = [];
    const base = deps(over);
    return { summaries, locked: base.locked, d: {
      ...base.d, channels: () => chs, auditByTarget: async () => new Map(Object.entries(entries)),
      onSummary: (f: { channel: ChannelLike; reason: string }[]) => summaries.push(f.map((x) => x.channel.id)),
    } };
  };
  { const a = fakeChannel('c1', [roleHas('r1')]);
    const b = fakeChannel('c2', [{ id: 'u2', type: 'member', allow: MANAGE_CHANNELS, deny: 0n }]);
    const c = fakeChannel('c3', [roleHas('r1')]);
    const x = sweepDeps([a, b, c], { c1: { targetId: 'c1', executorId: 'u1', createdTimestamp: NOW - 5 * 86_400_000 }, c2: { targetId: 'c2', executorId: 'u2', createdTimestamp: NOW - 5 * 86_400_000 } });
    const res = await sweepOwnedChannels(x.d);
    ok('sweep: an old unlocked channel is locked from the audit log', a.applied.length === 2 && res.locked === 1);
    ok('sweep: an already locked channel is untouched and silent', b.applied.length === 0 && !x.locked.includes('c2'));
    ok('sweep: a channel with no creator found goes in ONE summary', c.applied.length === 0 && x.summaries.length === 1 && x.summaries[0].join() === 'c3' && res.failed === 1);
    const again = await sweepOwnedChannels(x.d);
    ok('sweep: repeating it changes nothing more (a locked channel stays quiet)', again.locked === 1 || again.locked === 0); }
  { const x = sweepDeps([fakeChannel('c1', [{ id: 'u1', type: 'member', allow: MANAGE_CHANNELS, deny: 0n }])], {});
    const res = await sweepOwnedChannels(x.d);
    ok('sweep: a lone member holder with no audit entry reads as locked: no DM', res.failed === 0 && x.summaries.length === 0); }
  ok('looksUnlocked: a role holding the mask, or two members', looksUnlocked([roleHas('r')]) && looksUnlocked([{ id: 'a', type: 'member', allow: MANAGE_CHANNELS, deny: 0n }, { id: 'b', type: 'member', allow: MANAGE_ROLES, deny: 0n }]) && !looksUnlocked([]));
})();

const nf = ownedChannelFailureNotice('x', 'Member Wings', 'no audit log entry showed who made it');
ok('the failure note names channel, real category and reason', nf === '`#x` in `Member Wings` could NOT be locked (no audit log entry showed who made it)');
const ns = ownedChannelSweepNotice([{ channel: 'a', reason: 'r' }, { channel: 'b', reason: 'r' }]);
ok('the sweep note is one line listing the channels', !ns.includes('\n') && ns.startsWith('2 channels could NOT be locked:') && ns.includes('`#a`') && ns.includes('`#b`'));

const n = ownedChannelNotice('Mira', 'mira-wing', 'Member Wings');
ok('the note names creator, channel and category in inline code', n === '`Mira` opened `#mira-wing` in `Member Wings`; it is locked to them.');
ok('names cannot carry markup or mentions', !ownedChannelNotice('a`b<@&1>', 'x\n[y](z)', 'c').includes('<@') && !ownedChannelNotice('a', 'x\n y', 'c').includes('\n'));

ok('the key is off by default', GENERIC_DEFAULTS.owned_channel_categories.length === 0 && parseHouseConfig({}).owned_channel_categories.length === 0);
ok('the key reads an id list and drops non-strings', parseHouseConfig({ owned_channel_categories: ['1', 2, '3'] }).owned_channel_categories.join() === '1,3');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
