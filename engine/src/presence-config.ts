// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * presence-config.ts — live presence config poller.
 * Mirrors curfew-watch.ts: injectable clock, keep-last-known on fetch failure,
 * hardcoded DEFAULTS until the first successful fetch. The poll interval is
 * CONFIG STALENESS ONLY — bot reactions stay event-driven/instant.
 */
import { logger } from './logger.js';
import { SolanceApiSettingsStore, type SettingsStore } from './seams/settings-store.js';
import { identity } from './config/identity.js';
import { houseConfig } from './config/house-config.js';
import { parseServers, type ServerMap } from './presence/servers.js';
import { type Step, normalizeStep, stepFromLevel, isStep } from './presence/steps.js';

// §0.E — split from a flat list into owner/bot families so the classifier (Task 2)
// can tell which family a hit belongs to (away fires on the owner family; soft-presence
// on either). name_triggers is ALWAYS exposed in this shape by parseNameTriggers,
// regardless of what's actually stored (flat legacy array, nested, or garbage).
export interface NameTriggers {
  owner: string[];
  bot: string[];
}

export interface DiscordConfig {
  /** The big dial (specs/2026-10-17-discord-one-ladder.md): `step` if stored, else the old presence_level mapped. */
  step: Step;
  presence_level: number;      // legacy 0..4 dial, read only when `step` is absent
  sweep_minutes: number;
  posture: Record<string, string>;
  extra_instructions: string;
  name_triggers: NameTriggers;
  stickers_enabled: boolean;
  /** The sticker a curfew nudge may carry at each level (a guild sticker id); null = text only. The House seed fills these in; elsewhere none. */
  curfew_stickers: Record<'1' | '2' | '3', string | null>;
  away: {
    announce: boolean;
    override: { active: boolean; reason: string; until: string | null; set_at: string | null };
  };
  // Phase 3 (§9, Owner 2026-07-12 23:59 — sub-decision 1) — the Context Log
  // scope dial: 'off' | 'mentions_only' | 'house_channels' | 'all'. Kept a
  // plain string here (not a union) so a value this file doesn't yet know
  // about degrades to the safe default via parseContextLog, never a crash.
  context_log: string;
  // The ignore list (Owner, 2026-08-29) — specific people the bot never answers.
  // Their messages STAY VISIBLE as conversation context (never stripped from a
  // window) — this only gates the five reply-producing paths in
  // discord-client.ts (see isIgnoredAuthor). Live-editable via the same poller
  // as everything else here — no deploy needed to add/remove someone.
  ignored_user_ids: string[];
  // Scene flag (spec specs/2026-09-28-scene-flag.md) — raised by a wing in a
  // scene with the owner; while effectively active the bot catches her first HoS
  // message of that raise, once (scene-catch.ts). Every field is SERVER-stamped
  // by solance-api; this side only validates. Bad/missing → SCENE_DEFAULT
  // (inactive), never a partial flag.
  scene: SceneFlag;
  // Study summons (Owner, 2 Oct; specs/2026-10-01-discord-study-summons-and-guild-recall.md §B):
  // while a window is live in a channel, a Study session is the voice there and Sanctum steps aside.
  study: StudyWindow;
  // Per-server settings (specs/2026-10-15-discord-servers-section.md): the LIVE half of
  // resolveServer(). Only what the owner has set; the House seed and the silent default fill the rest.
  servers: ServerMap;
}

export interface SceneFlag {
  active: boolean;
  raised_at: string | null;   // ISO-8601 UTC
  raised_by: string | null;   // short wing name
  until: string | null;       // ISO-8601 UTC — safety cap only
  lowered_at: string | null;  // ISO-8601 UTC
}

export const SCENE_DEFAULT: SceneFlag = {
  active: false,
  raised_at: null,
  raised_by: null,
  until: null,
  lowered_at: null,
};

const SCENE_KEYS = ['active', 'raised_at', 'raised_by', 'until', 'lowered_at'] as const;
const RAISED_BY_RE = /^[a-z0-9 _-]{1,40}$/;
// Full ISO-8601 UTC with an explicit Z, as solance-api stamps it. A bare date
// ("2026-09-28") or an offset form is refused: Date.parse would accept it and
// read it in a timezone nobody chose.
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function isIsoUtc(v: any): v is string {
  return typeof v === 'string' && ISO_UTC_RE.test(v) && Number.isFinite(Date.parse(v));
}
function isIsoUtcOrNull(v: any): boolean {
  return v === null || isIsoUtc(v);
}
function isRaisedBy(v: any): v is string {
  return typeof v === 'string' && RAISED_BY_RE.test(v.toLowerCase());
}

/**
 * parseScene — strict and all-or-nothing (Codex review, 2026-09-28). All five
 * contract keys must be present and no others. Timestamps are full ISO-8601
 * UTC with Z, or null. When active: raised_at, until and raised_by must be
 * present, lowered_at must be null, and until must be after raised_at.
 * Anything else degrades the WHOLE flag to the inactive default: a
 * half-trusted flag is worse than none.
 */
export interface StudyWindow {
  active: boolean;
  channel_id: string | null;
  guild_id: string | null;
  minutes: number | null;
  opened_at: string | null;
  expires_at: string | null;
  nonce: string | null;
  claimed_at: string | null;
  ready_at: string | null;
  closed_at: string | null;
}

export const STUDY_DEFAULT: StudyWindow = {
  active: false, channel_id: null, guild_id: null, minutes: null, opened_at: null,
  expires_at: null, nonce: null, claimed_at: null, ready_at: null, closed_at: null,
};

const SNOWFLAKE = /^\d{15,25}$/;

/** Malformed in ANY way → inactive: a broken record must never silence Sanctum by accident. */
export function parseStudy(raw: any): StudyWindow {
  const inactive = (): StudyWindow => ({ ...STUDY_DEFAULT });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return inactive();
  const { active, channel_id, guild_id, minutes, opened_at, expires_at, nonce, claimed_at, ready_at, closed_at } = raw;
  // A closed (or otherwise inactive) record keeps its identity, so a window the bot opened
  // locally can be recognised as the one that was closed.
  if (active !== true) {
    return { ...inactive(), nonce: typeof nonce === 'string' && nonce ? nonce : null, opened_at: isIsoUtc(opened_at) ? opened_at : null };
  }
  if (typeof channel_id !== 'string' || !SNOWFLAKE.test(channel_id)) return inactive();
  if (guild_id !== null && (typeof guild_id !== 'string' || !SNOWFLAKE.test(guild_id))) return inactive();
  if (!Number.isInteger(minutes) || minutes < 1) return inactive();
  if (!isIsoUtc(opened_at) || !isIsoUtc(expires_at) || !isIsoUtcOrNull(claimed_at) || !isIsoUtcOrNull(ready_at ?? null) || closed_at !== null) return inactive();
  if (typeof nonce !== 'string' || !nonce) return inactive();
  return { active: true, channel_id, guild_id, minutes, opened_at, expires_at, nonce, claimed_at, ready_at: ready_at ?? null, closed_at: null };
}

/**
 * True while a live Study window holds this channel. Requires ready_at: the Study's listener has
 * proved it is running. A summons whose Study never starts never silences Sanctum (Codex, 2 Oct).
 */
export function studyHolds(study: StudyWindow | null | undefined, channelId: string, nowMs: number): boolean {
  return !!study && study.active && study.channel_id === channelId && !!study.ready_at
    && !!study.expires_at && Date.parse(study.expires_at) > nowMs;
}

export function parseScene(raw: any): SceneFlag {
  const inactive = (): SceneFlag => ({ ...SCENE_DEFAULT });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return inactive();
  const keys = Object.keys(raw);
  if (keys.length !== SCENE_KEYS.length) return inactive();
  for (const k of SCENE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) return inactive();
  }
  const { active, raised_at, raised_by, until, lowered_at } = raw;
  if (typeof active !== 'boolean') return inactive();
  if (!isIsoUtcOrNull(raised_at) || !isIsoUtcOrNull(until) || !isIsoUtcOrNull(lowered_at)) return inactive();
  if (raised_by !== null && !isRaisedBy(raised_by)) return inactive();
  if (active) {
    if (!isIsoUtc(raised_at) || !isIsoUtc(until) || !isRaisedBy(raised_by)) return inactive();
    if (lowered_at !== null) return inactive();
    if (!(Date.parse(until) > Date.parse(raised_at))) return inactive();
  }
  return { active, raised_at, raised_by, until, lowered_at };
}

const DEFAULT_NAME_TRIGGERS: NameTriggers = { owner: [...identity.default_triggers.owner], bot: [...identity.default_triggers.bot] };

export const DEFAULTS: DiscordConfig = {
  step: 'balanced',
  presence_level: 2,
  sweep_minutes: 30,
  posture: {},
  extra_instructions: '',
  name_triggers: DEFAULT_NAME_TRIGGERS,
  stickers_enabled: true,
  curfew_stickers: { ...houseConfig.curfewStickers },
  away: { announce: true, override: { active: false, reason: '', until: null, set_at: null } },
  // A deployment with no House layer records nothing until its owner turns the dial on; the House seed keeps 'house_channels'.
  context_log: houseConfig.contextLogDefault,
  ignored_user_ids: [],
  scene: SCENE_DEFAULT,
  study: STUDY_DEFAULT,
  servers: {},
};

// §9 sub-decision 1 — the four valid dial positions; anything else falls
// back to the default (house_channels) rather than breaking the collector.
// 'this_server' is the per-server name for the same dial position (kept valid globally too).
const CONTEXT_LOG_VALUES = new Set(['off', 'mentions_only', 'house_channels', 'this_server', 'all']);
function parseContextLog(raw: any): string {
  return typeof raw === 'string' && CONTEXT_LOG_VALUES.has(raw) ? raw : DEFAULTS.context_log;
}

// A trigger belongs to the owner family only if it's recognized as one of the owner's names.
// Everything else — the bot family AND any unrecognized custom trigger (e.g.
// "fable") — defaults to the bot family. NEVER dropped (reviewer finding).
const OWNER_FAMILY = new Set(identity.owner_family);

function normalizeTriggerList(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: any) => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 20);
}

/**
 * parseNameTriggers — §0.E coercion. Accepts:
 *  - the nested {owner, bot} shape (or the keys a deployment stores them under,
 *    identity.trigger_keys) → validated, missing family defaults to [].
 *  - the legacy flat array (e.g. ['name','nick','longname']) → split by family map;
 *    an unrecognized custom trigger is KEPT, defaulting to the bot family.
 *  - anything else (missing/malformed) → DEFAULTS.
 * Always returns a fully-formed {owner: string[], bot: string[]}.
 */
export function parseNameTriggers(raw: any): NameTriggers {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const keys = [identity.trigger_keys, { owner: 'owner', bot: 'bot' }];
    for (const k of keys) {
      if (k.owner in raw || k.bot in raw) {
        return { owner: normalizeTriggerList(raw[k.owner]), bot: normalizeTriggerList(raw[k.bot]) };
      }
    }
  }
  if (Array.isArray(raw)) {
    const owner: string[] = [];
    const bot: string[] = [];
    for (const item of raw) {
      const s = String(item).toLowerCase().trim();
      if (!s) continue;
      if (OWNER_FAMILY.has(s)) owner.push(s);
      else bot.push(s); // bot family + any unrecognized custom trigger
    }
    return { owner: owner.slice(0, 20), bot: bot.slice(0, 20) };
  }
  return { owner: [...DEFAULT_NAME_TRIGGERS.owner], bot: [...DEFAULT_NAME_TRIGGERS.bot] };
}

// Ignore list (Owner, 2026-08-29) — accept only an array; keep only entries that
// are strings matching a Discord snowflake shape; drop anything else silently
// rather than rejecting the whole config; de-duplicate. Same degrade-not-throw
// law as every other field here: a malformed value falls back to [].
const SNOWFLAKE_RE = /^\d{15,21}$/;
function parseIgnoredUserIds(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item === 'string' && SNOWFLAKE_RE.test(item)) seen.add(item);
  }
  return [...seen];
}

/**
 * isIgnoredAuthor — the ONE gate every ignore-list enforcement site calls.
 * Lives here (not presence-engine.ts) because it is a pure function of the
 * config shape this file owns, both discord-client.ts and presence-engine.ts
 * already import from this module, and it needs neither discord.js types nor
 * the judge/respond machinery — putting it there would be an import for one
 * function. `authorId` is `string | null | undefined` because messageCreate's
 * synchronous hot path sometimes has nothing resolved yet; an unresolved
 * author is never treated as ignored.
 */
export function isIgnoredAuthor(authorId: string | null | undefined, ignored: string[]): boolean {
  return Boolean(authorId) && ignored.includes(authorId as string);
}

const FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_TTL_MS = 120_000; // 120s — staleness window, not latency

// Validate + clamp EVERY field to a safe value. A malformed row must never break
// the sweep timer or the prompt — an unparseable field falls back to its default.
// An unrecognized posture value would make the step lookup undefined and crash the ambient sweep,
// so we drop any key whose value isn't known.
// Stored values are kept as written (a step, or an old posture word that normalizeStep reads); anything
// else is dropped.
function parsePosture(raw: any): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && normalizeStep(v)) clean[k] = v;
  }
  return clean;
}

/** Per-level curfew sticker ids: a stored id (or null for text only) wins; a level the document does not mention keeps the House seed's. */
export function parseCurfewStickers(raw: any): Record<'1' | '2' | '3', string | null> {
  const out = { ...DEFAULTS.curfew_stickers };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of ['1', '2', '3'] as const) {
    if (raw[k] === null) out[k] = null;
    else if (typeof raw[k] === 'string' && SNOWFLAKE.test(raw[k])) out[k] = raw[k];
  }
  return out;
}

export function parseConfig(raw: any): DiscordConfig {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const int = (v: any, min: number, max: number, def: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : def;
  };
  const num = (v: any, min: number, max: number, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : def;
  };
  const presence_level = int(r.presence_level, 0, 4, DEFAULTS.presence_level);
  return {
    // `step` wins; else the old dial maps (0 -> reply_only .. 4 -> chatty); a missing dial is the default's.
    step: isStep(r.step) ? r.step : (stepFromLevel(int(r.presence_level, 0, 4, -1)) ?? DEFAULTS.step),
    presence_level,
    sweep_minutes: num(r.sweep_minutes, 5, 240, DEFAULTS.sweep_minutes),
    posture: parsePosture(r.posture),
    extra_instructions: typeof r.extra_instructions === 'string' ? r.extra_instructions.slice(0, 4000) : '',
    name_triggers: parseNameTriggers(r.name_triggers),
    stickers_enabled: typeof r.stickers_enabled === 'boolean' ? r.stickers_enabled : true,
    curfew_stickers: parseCurfewStickers(r.curfew_stickers),
    away: (r.away && typeof r.away === 'object' && !Array.isArray(r.away))
      ? { announce: r.away.announce !== false, override: { ...DEFAULTS.away.override, ...(r.away.override || {}) } }
      : DEFAULTS.away,
    context_log: parseContextLog(r.context_log),
    ignored_user_ids: parseIgnoredUserIds(r.ignored_user_ids),
    scene: parseScene(r.scene),
    study: parseStudy(r.study),
    servers: parseServers(r.servers),
  };
}

export class PresenceConfig {
  private lastKnown: DiscordConfig | null = null;
  private lastAttemptMs = 0;   // set on BOTH success and failure (see get() throttle)
  private hasAttempted = false;
  private readonly now: () => number;
  private readonly ttlMs: number;

  private readonly store: SettingsStore;

  constructor(apiBase: string, token: string, opts: { now?: () => number; ttlMs?: number; store?: SettingsStore } = {}) {
    this.store = opts.store ?? new SolanceApiSettingsStore(apiBase, token);
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * getCached — §0.C hot-path safety. Returns the last-known config SYNCHRONOUSLY
   * and NEVER fetches (the 120s poller owns all network). Before any successful
   * fetch, returns DEFAULTS. Callers on the messageCreate hot path use this, never get().
   */
  getCached(): DiscordConfig {
    return this.lastKnown ?? DEFAULTS;
  }

  // The window the bot itself just opened (from the PUT response) — seen at once, without waiting
  // up to 120s for the poller. The newer of this and the polled record wins (by opened_at).
  private localStudy: StudyWindow | null = null;

  noteStudy(study: StudyWindow): void {
    this.localStudy = study;
  }

  getStudy(): StudyWindow {
    const polled = this.getCached().study ?? STUDY_DEFAULT;
    const local = this.localStudy;
    if (!local) return polled;
    // Same window: the polled copy carries the Mac's extends and close.
    if (polled.nonce && polled.nonce === local.nonce) return polled;
    // A different, newer window in the poll wins; otherwise mine is the newest truth.
    if (polled.opened_at && local.opened_at && Date.parse(polled.opened_at) > Date.parse(local.opened_at)) return polled;
    return local;
  }

  async get(): Promise<DiscordConfig> {
    // Throttle on the last ATTEMPT (success OR failure), not the last success —
    // otherwise, during a config-endpoint outage, every consumer (curfew, each
    // swept channel, replies, the heartbeat) would re-fetch past the TTL and
    // each block up to FETCH_TIMEOUT_MS: a request-storm/stall. Backoff = TTL.
    if (this.hasAttempted && this.now() - this.lastAttemptMs < this.ttlMs) return this.lastKnown ?? DEFAULTS;
    await this.refresh();
    return this.lastKnown ?? DEFAULTS;
  }

  /**
   * fetchFresh — one live read that bypasses the TTL throttle AND the cache.
   * Resolves to the parsed config (and updates lastKnown), or null on ANY
   * failure — never the cached/DEFAULTS value, so a caller that must act only
   * on current truth (the scene catch's recheck before sending) can tell
   * "fresh" from "unknown". Does not touch the get() throttle bookkeeping.
   */
  async fetchFresh(): Promise<DiscordConfig | null> {
    try {
      const cfg = await this.fetchOnce();
      this.lastKnown = cfg;
      return cfg;
    } catch (err: any) {
      logger.info('PresenceConfig', 'fresh config fetch failed', { error: err?.message });
      return null;
    }
  }

  private async fetchOnce(): Promise<DiscordConfig> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.store.getPresenceConfig(controller.signal);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body: any = await res.json();
      return parseConfig(body?.discord); // clamps every field; bad values → defaults
    } finally {
      clearTimeout(t);
    }
  }

  async refresh(): Promise<void> {
    try {
      this.lastKnown = await this.fetchOnce();
    } catch (err: any) {
      logger.info('PresenceConfig', 'config fetch failed — keeping last-known', { error: err?.message, everFetched: !!this.lastKnown });
      // lastKnown untouched; get() falls back to DEFAULTS if never fetched.
    } finally {
      this.lastAttemptMs = this.now();  // record the attempt either way → backoff on failure
      this.hasAttempted = true;
    }
  }
}
