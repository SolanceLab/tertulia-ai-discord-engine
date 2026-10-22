// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * audit-log-copy.ts — keep our own copy of the home server's audit log (22 Oct 2026).
 *
 * Discord keeps audit log entries for 45 days. Every `audit_copy_hours` (house config; 0 = off, the
 * public default) the bot asks Sanctum for the newest entry it holds, reads the newer entries from
 * Discord oldest to newest, and posts them to Sanctum in batches of 100. Posting is idempotent
 * (Sanctum ignores ids it already has), so a repeated or interrupted run is safe.
 *
 * Pure helpers: `snowflakeToIso`, `actionName`, `mapAuditPage`, `chunk`. Glue with every outside call
 * injected (so tests use fakes): `runAuditCopy`, `startAuditCopy`.
 */

/** Wait after start before the first copy. */
export const FIRST_RUN_DELAY_MS = 2 * 60_000;
/** The owner hears about a failure at most this often. */
export const FAILURE_DM_INTERVAL_MS = 24 * 3600_000;
/** Sanctum takes at most this many entries per call. */
export const INGEST_BATCH = 100;
/** Pages per run (100 entries each); 45 days of a busy server fits well inside. */
const HTTP_TIMEOUT_MS = 20_000;
const DISCORD_EPOCH = 1420070400000n;
export const MAX_PAGES_PER_RUN = 200;

/** Discord audit log action types by number. */
export const ACTION_NAMES: Record<number, string> = {
  1: 'GUILD_UPDATE', 10: 'CHANNEL_CREATE', 11: 'CHANNEL_UPDATE', 12: 'CHANNEL_DELETE',
  13: 'CHANNEL_OVERWRITE_CREATE', 14: 'CHANNEL_OVERWRITE_UPDATE', 15: 'CHANNEL_OVERWRITE_DELETE',
  20: 'MEMBER_KICK', 21: 'MEMBER_PRUNE', 22: 'MEMBER_BAN_ADD', 23: 'MEMBER_BAN_REMOVE', 24: 'MEMBER_UPDATE',
  25: 'MEMBER_ROLE_UPDATE', 26: 'MEMBER_MOVE', 27: 'MEMBER_DISCONNECT', 28: 'BOT_ADD',
  30: 'ROLE_CREATE', 31: 'ROLE_UPDATE', 32: 'ROLE_DELETE',
  40: 'INVITE_CREATE', 41: 'INVITE_UPDATE', 42: 'INVITE_DELETE',
  50: 'WEBHOOK_CREATE', 51: 'WEBHOOK_UPDATE', 52: 'WEBHOOK_DELETE',
  60: 'EMOJI_CREATE', 61: 'EMOJI_UPDATE', 62: 'EMOJI_DELETE',
  72: 'MESSAGE_DELETE', 73: 'MESSAGE_BULK_DELETE', 74: 'MESSAGE_PIN', 75: 'MESSAGE_UNPIN',
  80: 'INTEGRATION_CREATE', 81: 'INTEGRATION_UPDATE', 82: 'INTEGRATION_DELETE',
  83: 'STAGE_INSTANCE_CREATE', 84: 'STAGE_INSTANCE_UPDATE', 85: 'STAGE_INSTANCE_DELETE',
  90: 'STICKER_CREATE', 91: 'STICKER_UPDATE', 92: 'STICKER_DELETE',
  100: 'GUILD_SCHEDULED_EVENT_CREATE', 101: 'GUILD_SCHEDULED_EVENT_UPDATE', 102: 'GUILD_SCHEDULED_EVENT_DELETE',
  110: 'THREAD_CREATE', 111: 'THREAD_UPDATE', 112: 'THREAD_DELETE',
  121: 'APPLICATION_COMMAND_PERMISSION_UPDATE',
  130: 'SOUNDBOARD_SOUND_CREATE', 131: 'SOUNDBOARD_SOUND_UPDATE', 132: 'SOUNDBOARD_SOUND_DELETE',
  140: 'AUTO_MODERATION_RULE_CREATE', 141: 'AUTO_MODERATION_RULE_UPDATE', 142: 'AUTO_MODERATION_RULE_DELETE',
  143: 'AUTO_MODERATION_BLOCK_MESSAGE', 144: 'AUTO_MODERATION_FLAG_TO_CHANNEL', 145: 'AUTO_MODERATION_USER_COMMUNICATION_DISABLED',
  150: 'CREATOR_MONETIZATION_REQUEST_CREATED', 151: 'CREATOR_MONETIZATION_TERMS_ACCEPTED',
  163: 'ONBOARDING_PROMPT_CREATE', 164: 'ONBOARDING_PROMPT_UPDATE', 165: 'ONBOARDING_PROMPT_DELETE',
  166: 'ONBOARDING_CREATE', 167: 'ONBOARDING_UPDATE',
  190: 'HOME_SETTINGS_CREATE', 191: 'HOME_SETTINGS_UPDATE',
};

export function actionName(type: number): string {
  return ACTION_NAMES[type] ?? `ACTION_${type}`;
}

/** The moment a Discord id (snowflake) was made, as an ISO string. */
export function snowflakeToIso(id: string): string {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH)).toISOString();
}

/** What Sanctum stores for one entry. */
export interface AuditRow {
  id: string;
  action_type: number;
  action_name: string;
  user_id: string | null;
  user_name: string | null;
  target_id: string | null;
  target_name: string | null;
  reason: string | null;
  changes: unknown[] | null;
  options: Record<string, unknown> | null;
  created_at: string;
}

/** Names Discord does not send with the page: the server's channel and role caches. */
export interface NameMaps { channels: Map<string, string>; roles: Map<string, string> }

const isId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,25}$/.test(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function userLabel(u: any): string | null {
  return nonEmpty(u?.global_name) ?? nonEmpty(u?.username);
}

/** A name found in the entry's own changes (a created or deleted thing carries it there). */
function nameFromChanges(changes: any[] | undefined): string | null {
  const c = changes?.find((x) => x?.key === 'name');
  return nonEmpty(c?.new_value) ?? nonEmpty(c?.old_value);
}

/**
 * One page from Discord (`GET /guilds/{id}/audit-logs`) to rows, oldest first.
 * Names come from the response's users, integrations, threads and webhooks, then the channel and role caches,
 * then the entry's own `name` change. An entry with a bad id is skipped.
 */
export function mapAuditPage(page: any, maps: NameMaps): AuditRow[] {
  const byId = (list: any[] | undefined, label: (x: any) => string | null) => {
    const m = new Map<string, string>();
    for (const x of list ?? []) { const l = label(x); if (isId(x?.id) && l) m.set(x.id, l); }
    return m;
  };
  const users = byId(page?.users, userLabel);
  const integrations = byId(page?.integrations, (x) => nonEmpty(x?.name));
  const threads = byId(page?.threads, (x) => nonEmpty(x?.name));
  const webhooks = byId(page?.webhooks, (x) => nonEmpty(x?.name));
  const rows: AuditRow[] = [];
  for (const e of page?.audit_log_entries ?? []) {
    if (!isId(e?.id) || !Number.isInteger(e?.action_type)) continue;
    const targetId = isId(e.target_id) ? e.target_id : null;
    const targetName = targetId
      ? users.get(targetId) ?? threads.get(targetId) ?? webhooks.get(targetId) ?? integrations.get(targetId)
        ?? maps.channels.get(targetId) ?? maps.roles.get(targetId) ?? nameFromChanges(e.changes)
      : null;
    const userId = isId(e.user_id) ? e.user_id : null;
    rows.push({
      id: e.id,
      action_type: e.action_type,
      action_name: actionName(e.action_type),
      user_id: userId,
      user_name: userId ? users.get(userId) ?? null : null,
      target_id: targetId,
      target_name: targetName ?? null,
      reason: nonEmpty(e.reason),
      changes: Array.isArray(e.changes) && e.changes.length ? e.changes : null,
      options: e.options && typeof e.options === 'object' ? e.options : null,
      created_at: snowflakeToIso(e.id),
    });
  }
  return rows.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function auditFailureNotice(reason: string): string {
  return `Couldn't copy the audit log (${reason}); Discord keeps 45 days, so the next run will catch up`;
}

export interface AuditCopyDeps {
  guildId: string;
  sanctumUrl: string;
  sanctumKey: string;
  /** One raw Discord page: entries newer than `after`. */
  fetchPage: (after: string) => Promise<unknown>;
  names: () => NameMaps;
  fetchImpl?: typeof fetch;
  log: (message: string, data?: Record<string, unknown>) => void;
  /** DM the owner; resolves false when it could not be sent. */
  dmOwner: (text: string) => Promise<unknown>;
  now?: () => number;
}

/** Mutable state kept between runs: when the owner was last told about a failure. */
export interface AuditCopyState { lastFailureDmAt: number }

async function sanctum(deps: AuditCopyDeps, path: string, init?: RequestInit): Promise<any> {
  const f = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const r = await f(`${deps.sanctumUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deps.sanctumKey}` },
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`Sanctum ${path.split('?')[0]} status ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/** One copy run. Returns how many entries Sanctum stored; throws on any failure. */
export async function runAuditCopy(deps: AuditCopyDeps): Promise<number> {
  const latest = await sanctum(deps, `/discord-audit/latest?guild_id=${encodeURIComponent(deps.guildId)}`);
  let cursor = isId(latest?.latest_id) ? latest.latest_id : '0';
  let stored = 0;
  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const rows = mapAuditPage(await deps.fetchPage(cursor), deps.names());
    if (!rows.length) break;
    for (const batch of chunk(rows, INGEST_BATCH)) {
      const res = await sanctum(deps, '/ingest/discord-audit', {
        method: 'POST',
        body: JSON.stringify({ guild_id: deps.guildId, entries: batch }),
      });
      if (typeof res?.stored !== 'number') throw new Error('Sanctum answered without a stored count');
      stored += res.stored;
    }
    cursor = rows[rows.length - 1].id;
  }
  return stored;
}

/** A run that never throws: logs one line, and tells the owner about a failure at most once per 24 h. */
export async function runAuditCopyOnce(deps: AuditCopyDeps, state: AuditCopyState): Promise<void> {
  const now = (deps.now ?? Date.now)();
  try {
    const stored = await runAuditCopy(deps);
    deps.log(`audit log copy: stored ${stored}`, { stored });
  } catch (err: any) {
    const reason = String(err?.message ?? err).slice(0, 200);
    deps.log(`audit log copy failed: ${reason}`, { error: reason });
    if (now - state.lastFailureDmAt >= FAILURE_DM_INTERVAL_MS) {
      state.lastFailureDmAt = now;
      await Promise.resolve(deps.dmOwner(auditFailureNotice(reason))).catch(() => {});
    }
  }
}

/**
 * Start the timer: first run 2 minutes from now, then every `hours`. Returns a stop function.
 * `hours` <= 0 starts nothing (the public default).
 */
export function startAuditCopy(
  deps: AuditCopyDeps & { hours: number; isReady?: () => boolean },
  delayMs: number = FIRST_RUN_DELAY_MS,
): () => void {
  if (!(deps.hours > 0)) return () => {};
  const state: AuditCopyState = { lastFailureDmAt: -Infinity };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (ms: number) => {
    timer = setTimeout(async () => {
      if (stopped) return;
      if (deps.isReady && !deps.isReady()) deps.log('audit log copy: Discord not ready, skipping this run');
      else await runAuditCopyOnce(deps, state);
      if (!stopped) schedule(deps.hours * 3600_000);
    }, ms);
  };
  schedule(delayMs);
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
