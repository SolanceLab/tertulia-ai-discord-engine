// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * servers.ts — per-server settings (spec specs/2026-10-15-discord-servers-section.md).
 *
 * One pure function, resolveServer(guildId, cfg, houseSeed), answers "how does the bot behave in
 * this server?" for every caller. Resolution, field by field:
 *   1. the live `servers[guildId]` entry (the settings document);
 *   2. the House seed `servers[guildId]` (house/discord.house.json; the public build has none);
 *   3. the default for any other server: SILENT, curfew on, scene flag off, away off.
 * A server nobody has set up is therefore silent. DMs are not servers: callers never resolve one.
 *
 * How much the bot talks in a server is its `step` (specs/2026-10-17-discord-one-ladder.md): null means
 * "same as the House dial". The old `mode` is read only as a fallback when an entry has no step
 * (guest -> reply_only, silent -> silent, home -> inherit); it decides nothing else.
 */
import { type Step, stepFromLevel, isStep } from './steps.js';

export type ServerMode = 'home' | 'guest' | 'silent';
export type AwayRule = 'channel' | 'owner_dm' | 'off';
/** 'house_channels' is the legacy name for 'this_server' and is normalised to it. */
export type ServerContextLog = 'off' | 'mentions_only' | 'this_server' | 'all';

export interface ServerRules { curfew: boolean; flag: boolean; away: AwayRule; copy_to_owner: boolean }

/** A fully resolved server. */
export interface ResolvedServer {
  /** How much he talks in this server; null = same as the House dial. */
  step: Step | null;
  /** null = use the global level */
  context_log: ServerContextLog | null;
  /** Whether the bot adds this server's own stickers; null = follow the global `stickers_enabled`. */
  stickers: boolean | null;
  rules: ServerRules;
}

/** What a settings document or the seed may hold: any field can be missing. */
export interface ServerEntry {
  /** null = same as the House dial. */
  step?: Step | null;
  /** Legacy: read as a step only when `step` is absent. */
  mode?: ServerMode;
  /** Legacy: read as a step only when neither `step` nor a guest/silent mode is present. */
  presence_level?: number | null;
  context_log?: ServerContextLog | null;
  /** true/false = this server's own stickers on/off; absent or null = the global `stickers_enabled`. */
  stickers?: boolean | null;
  rules?: Partial<ServerRules>;
}
export type ServerMap = Record<string, ServerEntry>;

export const SERVER_MODES: readonly ServerMode[] = ['home', 'guest', 'silent'];
export const SERVER_CONTEXT_LOG_VALUES: readonly ServerContextLog[] = ['off', 'mentions_only', 'this_server', 'all'];
export const AWAY_RULES: readonly AwayRule[] = ['channel', 'owner_dm', 'off'];

/** Step 3: any server nobody has set up. */
export const DEFAULT_SERVER: ResolvedServer = {
  step: 'silent',
  context_log: null,
  stickers: null,
  rules: { curfew: true, flag: false, away: 'off', copy_to_owner: false },
};

export const GUILD_ID_RE = /^\d{15,25}$/;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export function normalizeServerContextLog(v: unknown): ServerContextLog | undefined {
  if (v === 'house_channels') return 'this_server';
  return typeof v === 'string' && (SERVER_CONTEXT_LOG_VALUES as readonly string[]).includes(v) ? (v as ServerContextLog) : undefined;
}

/** One entry: unknown keys dropped, a bad value means that field is missing (never a throw). */
export function parseServerEntry(raw: unknown): ServerEntry {
  const out: ServerEntry = {};
  if (!isObj(raw)) return out;
  if (raw.step === null) out.step = null;
  else if (isStep(raw.step)) out.step = raw.step;
  if ((SERVER_MODES as readonly unknown[]).includes(raw.mode)) out.mode = raw.mode as ServerMode;
  if (raw.presence_level === null) out.presence_level = null;
  else if (Number.isInteger(raw.presence_level) && raw.presence_level >= 0 && raw.presence_level <= 4) out.presence_level = raw.presence_level;
  if (raw.context_log === null) out.context_log = null;
  else {
    const c = normalizeServerContextLog(raw.context_log);
    if (c) out.context_log = c;
  }
  if (typeof raw.stickers === 'boolean' || raw.stickers === null) out.stickers = raw.stickers;
  if (isObj(raw.rules)) {
    const rules: Partial<ServerRules> = {};
    if (typeof raw.rules.curfew === 'boolean') rules.curfew = raw.rules.curfew;
    if (typeof raw.rules.flag === 'boolean') rules.flag = raw.rules.flag;
    if (typeof raw.rules.copy_to_owner === 'boolean') rules.copy_to_owner = raw.rules.copy_to_owner;
    if ((AWAY_RULES as readonly unknown[]).includes(raw.rules.away)) rules.away = raw.rules.away as AwayRule;
    if (Object.keys(rules).length) out.rules = rules;
  }
  return out;
}

/** The whole `servers` map: keys must look like Discord ids, everything else is dropped. */
export function parseServers(raw: unknown): ServerMap {
  const out: ServerMap = {};
  if (!isObj(raw)) return out;
  for (const [id, entry] of Object.entries(raw)) {
    if (!GUILD_ID_RE.test(id)) continue;
    out[id] = parseServerEntry(entry);
  }
  return out;
}

/** The step an entry states outright, or by an old guest/silent mode; undefined = says nothing. */
export function entryStep(e: ServerEntry): Step | null | undefined {
  if (e.step !== undefined) return e.step;
  if (e.mode === 'guest') return 'reply_only';
  if (e.mode === 'silent') return 'silent';
  return undefined;
}

/**
 * The step an entry stands for. Beyond entryStep, two old fields speak only when nothing stronger has
 * (`weakOk`): a per-server dial maps like the House dial, and a Home mode means "same as the House" (null).
 * When the House seed already gave the server a step, a live old-style `mode: home` or dial must not undo
 * it (it would open the unmapped House rooms the seed keeps to reply_only).
 */
function overlay(base: ResolvedServer, e: ServerEntry | undefined, weakOk: boolean): ResolvedServer {
  if (!e) return base;
  let step = entryStep(e);
  if (step === undefined && weakOk) step = stepFromLevel(e.presence_level) ?? (e.mode === 'home' ? null : undefined);
  return {
    step: step !== undefined ? step : base.step,
    context_log: e.context_log !== undefined ? e.context_log : base.context_log,
    stickers: e.stickers !== undefined ? e.stickers : base.stickers,
    rules: { ...base.rules, ...(e.rules ?? {}) },
  };
}

export function resolveServer(
  guildId: string | null | undefined,
  cfg: { servers?: ServerMap } | null | undefined,
  houseSeed: ServerMap | null | undefined,
): ResolvedServer {
  const def: ResolvedServer = { ...DEFAULT_SERVER, rules: { ...DEFAULT_SERVER.rules } };
  if (!guildId) return def;
  const seedEntry = houseSeed?.[guildId];
  const seeded = overlay(def, seedEntry, true);
  const seedGaveStep = !!seedEntry && (entryStep(seedEntry) !== undefined || seeded.step !== def.step);
  return overlay(seeded, cfg?.servers?.[guildId], !seedGaveStep);
}
