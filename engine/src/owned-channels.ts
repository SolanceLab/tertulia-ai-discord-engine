// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * owned-channels.ts — keep a channel its creator's own (22 Oct 2026).
 *
 * Some categories let members create channels (they hold Manage Channels there). So that each
 * channel stays its creator's, the new channel is locked to them: the creator gets a member
 * overwrite allowing Manage Channels (only that), and the owner mask (Manage Channels, Manage Roles,
 * Manage Webhooks) is cleared from every other role and member overwrite that exists on the channel.
 * Roles that hold those permissions server-wide (staff, bots) are not touched: only overwrites that
 * exist on the channel are edited. The categories come from the house config key
 * `owned_channel_categories`; empty = off.
 *
 * `decideOwnedChannel` is the decision (pure). `lockChannel`, `sweepOwnedChannels` and
 * `findAuditWithRetry` are the glue with every Discord call injected, so they are tested with a fake
 * guild. discord-client.ts supplies the real calls.
 */

/** How long after the audit entry the channel may have been created and still count as the same act. */
export const AUDIT_WINDOW_MS = 30_000;
/** How far back the catch-up sweep looks in the audit log for a channel's creator. */
export const SWEEP_LOOKBACK_MS = 45 * 24 * 3600_000;
/** Waits between audit-log lookups, inside the 30 s window. */
export const AUDIT_BACKOFF_MS = [1000, 2000, 4000, 8000] as const;

/** Discord permission bits (bigint, as discord.js gives them). */
export const MANAGE_CHANNELS = 1n << 4n;
export const MANAGE_ROLES = 1n << 28n;
export const MANAGE_WEBHOOKS = 1n << 29n;
/** What "owning" a channel means: all three are cleared from everyone but the creator. */
export const OWNER_BITS = MANAGE_CHANNELS | MANAGE_ROLES | MANAGE_WEBHOOKS;
/** discord.js permission names for the mask, in bit order. */
export const OWNER_FLAGS = [
  { bit: MANAGE_CHANNELS, flag: 'ManageChannels' },
  { bit: MANAGE_ROLES, flag: 'ManageRoles' },
  { bit: MANAGE_WEBHOOKS, flag: 'ManageWebhooks' },
] as const;

/** One permission overwrite on the channel. */
export interface OverwriteLike {
  id: string;
  type: 'role' | 'member';
  allow: bigint;
  deny: bigint;
}

/** The audit log's CHANNEL_CREATE entry for the channel. */
export interface AuditEntryLike {
  targetId: string | null;
  executorId: string | null;
  createdTimestamp: number;
}

export interface OwnedChannelInput {
  channelId: string;
  /** The category the channel sits in; null when it has none. */
  parentId: string | null;
  overwrites: readonly OverwriteLike[];
  /** House config `owned_channel_categories`. */
  categoryIds: readonly string[];
  /** The CHANNEL_CREATE audit entry whose target is this channel, or null when there is none. */
  audit: AuditEntryLike | null;
  /** Who made the channel; null when it could not be looked up. */
  creator: { isBot: boolean; isAdmin: boolean } | null;
  nowMs: number;
  /** How old the audit entry may be (default AUDIT_WINDOW_MS; the sweep passes SWEEP_LOOKBACK_MS). */
  maxAgeMs?: number;
}

/** One change to apply: grant = the creator's Manage Channels; strip = clear these permissions from an overwrite. */
export type OverwriteEdit =
  | { id: string; type: 'role' | 'member'; op: 'grant' }
  | { id: string; type: 'role' | 'member'; op: 'strip'; clear: string[] };

export type NoneReason = 'not_listed' | 'no_audit_entry' | 'creator_unknown' | 'creator_bot' | 'creator_admin' | 'already_locked';
export type OwnedChannelDecision =
  | { action: 'lock'; creatorId: string; edits: OverwriteEdit[] }
  | { action: 'none'; reason: NoneReason };

export function decideOwnedChannel(i: OwnedChannelInput): OwnedChannelDecision {
  if (!i.parentId || !i.categoryIds.includes(i.parentId)) return { action: 'none', reason: 'not_listed' };
  const a = i.audit;
  const maxAge = i.maxAgeMs ?? AUDIT_WINDOW_MS;
  const fresh = !!a && a.targetId === i.channelId && !!a.executorId && Math.abs(i.nowMs - a.createdTimestamp) <= maxAge;
  if (!a || !fresh || !a.executorId) return { action: 'none', reason: 'no_audit_entry' };
  if (!i.creator) return { action: 'none', reason: 'creator_unknown' };
  if (i.creator.isBot) return { action: 'none', reason: 'creator_bot' };
  if (i.creator.isAdmin) return { action: 'none', reason: 'creator_admin' };

  const edits: OverwriteEdit[] = [];
  const own = i.overwrites.find((o) => o.type === 'member' && o.id === a.executorId);
  if (!own || (own.allow & MANAGE_CHANNELS) === 0n) edits.push({ id: a.executorId, type: 'member', op: 'grant' });
  for (const o of i.overwrites) {
    if (o.type === 'member' && o.id === a.executorId) continue;
    const clear = OWNER_FLAGS.filter((f) => (o.allow & f.bit) !== 0n).map((f) => f.flag as string);
    if (clear.length) edits.push({ id: o.id, type: o.type, op: 'strip', clear });
  }
  return edits.length ? { action: 'lock', creatorId: a.executorId, edits } : { action: 'none', reason: 'already_locked' };
}

/** True when an overwrite other than `exceptId`'s allows any of the owner mask. */
export function othersHoldOwnerBits(overwrites: readonly OverwriteLike[], exceptId?: string): boolean {
  return overwrites.some((o) => o.id !== exceptId && (o.allow & OWNER_BITS) !== 0n);
}

/**
 * Sweep pre-check when the creator is not known yet: a role overwrite holding the mask, or more than one
 * member overwrite holding it, means the channel is not locked to one person. One member overwrite alone is
 * the shape of a locked channel.
 */
export function looksUnlocked(overwrites: readonly OverwriteLike[]): boolean {
  const holders = overwrites.filter((o) => (o.allow & OWNER_BITS) !== 0n);
  return holders.some((o) => o.type === 'role') || holders.filter((o) => o.type === 'member').length > 1;
}

/** Plain words for why a channel could not be locked (the owner's DM fills the sentence). */
export function failureReason(reason: NoneReason | 'edit_failed', detail?: string): string {
  switch (reason) {
    case 'no_audit_entry': return 'no audit log entry showed who made it';
    case 'creator_unknown': return 'could not look up who made it';
    case 'edit_failed': return detail ? `permission edit failed: ${detail}` : 'a permission edit failed';
    default: return reason;
  }
}

/** Looks the audit entry up now, then again after each wait (1, 2, 4, 8 s); stops at the first hit. */
export async function findAuditWithRetry(
  find: () => Promise<AuditEntryLike | null>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  waits: readonly number[] = AUDIT_BACKOFF_MS,
): Promise<AuditEntryLike | null> {
  let entry = await find();
  for (const ms of waits) {
    if (entry) break;
    await sleep(ms);
    entry = await find();
  }
  return entry;
}

// ── glue (every Discord call injected) ──

export interface ChannelLike {
  id: string;
  name: string;
  parentId: string | null;
  overwrites(): OverwriteLike[];
  apply(e: OverwriteEdit): Promise<void>;
}

export interface LockDeps {
  categoryIds: readonly string[];
  /** The audit entry for this channel, or null. */
  audit(): Promise<AuditEntryLike | null>;
  creator(userId: string): Promise<{ isBot: boolean; isAdmin: boolean; name?: string } | null>;
  nowMs(): number;
  maxAgeMs?: number;
  /** The owner learns of a lock. */
  onLocked(info: { channel: ChannelLike; creatorName: string; creatorId: string }): void;
  /** The owner learns a channel in a listed category could NOT be locked. */
  onFailed(info: { channel: ChannelLike; reason: string }): void;
  log(message: string, data?: Record<string, unknown>): void;
}

export type LockOutcome =
  | { status: 'locked'; creatorId: string }
  | { status: 'skipped'; reason: NoneReason }
  | { status: 'failed'; reason: string };

/** Decides and applies the lock for one channel; reports success, or any failure out loud. */
export async function lockChannel(channel: ChannelLike, d: LockDeps): Promise<LockOutcome> {
  if (!channel.parentId || !d.categoryIds.includes(channel.parentId)) return { status: 'skipped', reason: 'not_listed' };
  let audit: AuditEntryLike | null = null;
  try { audit = await d.audit(); }
  catch (err: any) { d.log('owned-channel: audit log read failed', { channelId: channel.id, error: err?.message }); }
  let creator: { isBot: boolean; isAdmin: boolean; name?: string } | null = null;
  let creatorFetchFailed = false;
  if (audit?.executorId) {
    try { creator = await d.creator(audit.executorId); } catch (err: any) { creatorFetchFailed = true; d.log('owned-channel: creator lookup failed', { channelId: channel.id, error: err?.message }); }
  }
  const decision = decideOwnedChannel({
    channelId: channel.id, parentId: channel.parentId, overwrites: channel.overwrites(), categoryIds: d.categoryIds,
    audit, creator, nowMs: d.nowMs(), maxAgeMs: d.maxAgeMs,
  });
  if (decision.action === 'none') {
    d.log('owned-channel: left as is', { channelId: channel.id, reason: decision.reason });
    if (decision.reason === 'no_audit_entry' || decision.reason === 'creator_unknown') {
      d.onFailed({ channel, reason: failureReason(decision.reason, creatorFetchFailed ? 'lookup error' : undefined) });
      return { status: 'failed', reason: decision.reason };
    }
    return { status: 'skipped', reason: decision.reason };
  }
  const failures: string[] = [];
  for (const e of decision.edits) {
    try { await channel.apply(e); }
    catch (err: any) { failures.push(`${e.op} ${e.type} ${e.id}: ${err?.message ?? 'error'}`); }
  }
  if (failures.length) {
    d.log('owned-channel: some edits failed', { channelId: channel.id, failures });
    d.onFailed({ channel, reason: failureReason('edit_failed', `${failures.length} of ${decision.edits.length} edits`) });
    return { status: 'failed', reason: 'edit_failed' };
  }
  d.log('owned-channel: locked to its maker', { channelId: channel.id, creatorId: decision.creatorId, edits: decision.edits.length });
  d.onLocked({ channel, creatorName: creator?.name ?? decision.creatorId, creatorId: decision.creatorId });
  return { status: 'locked', creatorId: decision.creatorId };
}

export interface SweepDeps extends Omit<LockDeps, 'audit' | 'onFailed'> {
  /** Every channel (not thread) in the listed categories. */
  channels(): ChannelLike[];
  /** CHANNEL_CREATE audit entries by target id, as far back as SWEEP_LOOKBACK_MS. */
  auditByTarget(): Promise<Map<string, AuditEntryLike>>;
  /** One line to the owner: channels that could not be locked, with the reason. */
  onSummary(failed: { channel: ChannelLike; reason: string }[]): void;
}

/** Catch-up on every listed category's channels. Safe to repeat: locked channels do nothing and say nothing. */
export async function sweepOwnedChannels(d: SweepDeps): Promise<{ locked: number; failed: number }> {
  let byTarget: Map<string, AuditEntryLike>;
  try { byTarget = await d.auditByTarget(); }
  catch (err: any) {
    d.log('owned-channel sweep: audit log read failed', { error: err?.message });
    byTarget = new Map();
  }
  const failed: { channel: ChannelLike; reason: string }[] = [];
  let locked = 0;
  for (const channel of d.channels()) {
    const entry = byTarget.get(channel.id) ?? null;
    // Nothing to strip and nobody else holding the mask: not a candidate, no audit needed.
    if (!entry && !looksUnlocked(channel.overwrites())) continue;
    if (entry && !othersHoldOwnerBits(channel.overwrites(), entry.executorId ?? undefined)
      && channel.overwrites().some((o) => o.id === entry.executorId && (o.allow & MANAGE_CHANNELS) !== 0n)) continue;
    const out = await lockChannel(channel, {
      ...d, maxAgeMs: SWEEP_LOOKBACK_MS, audit: async () => entry,
      onFailed: ({ channel: c, reason }) => failed.push({ channel: c, reason }),
    });
    if (out.status === 'locked') locked++;
  }
  if (failed.length) d.onSummary(failed);
  return { locked, failed: failed.length };
}
