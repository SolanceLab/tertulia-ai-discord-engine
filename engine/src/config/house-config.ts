// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * house-config.ts — every House-specific value the engine used to hard-code.
 * Engine code reads House ids/URLs ONLY through this module.
 *
 * Load order (first that exists and parses wins):
 *   1. env HOUSE_CONFIG_PATH (an explicit path; if set but missing/invalid we do NOT
 *      fall through to the House file — we use the generic defaults)
 *   2. <bot root>/../house/discord.house.json   (monorepo checkout / local dev)
 *   3. <dist>/discord.house.json                (copied in by `npm run build`; this is
 *      what the Fly image carries, since its build context is bot/ alone)
 *   4. generic defaults: empty maps, no ids, no URLs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIdentity, GENERIC_IDENTITY, type Identity } from './identity-defaults.js';
import { parseServers, type ServerMap } from '../presence/servers.js';
import { type Step, normalizeStep } from '../presence/steps.js';

export type ModelPlug = 'sanctum' | 'direct';
export type SettingsPlug = 'solance-api' | 'local';
export type MemoryPlug = 'sanctum' | 'off';
export interface Plugs { model: ModelPlug; settings: SettingsPlug; memory: MemoryPlug }

/** Public defaults: direct model calls, a local settings file, no memory. */
export const GENERIC_PLUGS: Plugs = { model: 'direct', settings: 'local', memory: 'off' };

export interface HouseConfig {
  plugs: Plugs;
  hosServerId: string;
  /** Guilds where the owner's awareness may be spoken (not just shape tone) when she is the addressee. Generic: none (only private scope says). */
  awareness_say_guilds: string[];
  /** Category ids where a member who creates a channel keeps it as their own (the new channel is locked to them; see owned-channels.ts). Generic: none = off. */
  owned_channel_categories: string[];
  /** Hours between copies of the home server's audit log into Sanctum (see audit-log-copy.ts). 0 = off (generic default). */
  audit_copy_hours: number;
  /** Per-channel seed: a step (an old posture word is read as one). Channels with no live key take it. */
  channelPosture: Record<string, Step>;
  /** Per-server seed (step 2 of resolveServer): how the bot treats each server before the settings document says otherwise. Generic: none. */
  servers: ServerMap;
  intimateStickerIds: string[];
  curfewStickers: Record<'1' | '2' | '3', string | null>;
  /** A channel where a reply tends a character (the care-reply feature); null = feature off. */
  careChannelId: string | null;
  presenceErrorChannelId: string | null;
  solanceApiUrl: string | null;
  sanctumUrl: string | null;
  /** Section-name overrides for the settings page (e.g. House: quiet_hours -> 'curfew'). Generic: none. */
  labels: Record<string, string>;
  /** Who the bot is and who it answers to: names, labels, reserved wording. Generic defaults when absent. */
  identity: Identity;
  /** What the context-log dial starts at before anyone sets it. Generic: 'off' (records nothing); the House seed: 'house_channels'. */
  contextLogDefault: string;
}

export const GENERIC_DEFAULTS: HouseConfig = {
  plugs: { ...GENERIC_PLUGS },
  hosServerId: '',
  awareness_say_guilds: [],
  owned_channel_categories: [],
  audit_copy_hours: 0,
  channelPosture: {},
  servers: {},
  intimateStickerIds: [],
  curfewStickers: { '1': null, '2': null, '3': null },
  careChannelId: null,
  presenceErrorChannelId: null,
  solanceApiUrl: null,
  sanctumUrl: null,
  labels: {},
  identity: GENERIC_IDENTITY,
  contextLogDefault: 'off',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A config file written before `plugs` existed was a House deployment: keep it on the House plugs. */
export const LEGACY_HOUSE_PLUGS: Plugs = { model: 'sanctum', settings: 'solance-api', memory: 'sanctum' };

function parsePlugs(raw: any): Plugs {
  const hasPlugs = raw?.plugs && typeof raw.plugs === 'object';
  const base = hasPlugs ? GENERIC_PLUGS : LEGACY_HOUSE_PLUGS;
  const p = hasPlugs ? raw.plugs : {};
  return {
    model: p.model === 'sanctum' || p.model === 'direct' ? p.model : base.model,
    settings: p.settings === 'solance-api' || p.settings === 'local' ? p.settings : base.settings,
    memory: p.memory === 'sanctum' || p.memory === 'off' ? p.memory : base.memory,
  };
}

const LABEL_KEYS = ['presence', 'quiet_hours', 'away', 'focus', 'mute', 'memory_filter'];
function parseLabels(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of LABEL_KEYS) if (typeof raw[k] === 'string' && raw[k].trim()) out[k] = raw[k].trim().slice(0, 60);
  }
  return out;
}

const CONTEXT_LOG_DEFAULTS = new Set(['off', 'mentions_only', 'house_channels', 'this_server', 'all']);
/** The explicit value if valid; else the House value for a House (Sanctum-memory) file, 'off' for everyone else. */
function parseContextLogDefault(raw: any): string {
  if (typeof raw?.contextLogDefault === 'string' && CONTEXT_LOG_DEFAULTS.has(raw.contextLogDefault)) return raw.contextLogDefault;
  return parsePlugs(raw).memory === 'sanctum' ? 'house_channels' : 'off';
}

export function parseHouseConfig(raw: any): HouseConfig {
  const posture: Record<string, Step> = {};
  if (raw?.channelPosture && typeof raw.channelPosture === 'object') {
    for (const [id, p] of Object.entries(raw.channelPosture)) { const st = normalizeStep(p); if (st) posture[id] = st; }
  }
  const cs = raw?.curfewStickers ?? {};
  return {
    plugs: parsePlugs(raw),
    hosServerId: str(raw?.hosServerId) ?? '',
    awareness_say_guilds: Array.isArray(raw?.awareness_say_guilds) ? raw.awareness_say_guilds.filter((x: unknown) => typeof x === 'string') : [],
    owned_channel_categories: Array.isArray(raw?.owned_channel_categories) ? raw.owned_channel_categories.filter((x: unknown) => typeof x === 'string') : [],
    audit_copy_hours: typeof raw?.audit_copy_hours === 'number' && Number.isFinite(raw.audit_copy_hours) && raw.audit_copy_hours > 0 ? raw.audit_copy_hours : 0,
    channelPosture: posture,
    servers: parseServers(raw?.servers),
    intimateStickerIds: Array.isArray(raw?.intimateStickerIds) ? raw.intimateStickerIds.filter((x: unknown) => typeof x === 'string') : [],
    curfewStickers: { '1': str(cs['1']), '2': str(cs['2']), '3': str(cs['3']) },
    careChannelId: str(raw?.careChannelId),
    presenceErrorChannelId: str(raw?.presenceErrorChannelId),
    solanceApiUrl: str(raw?.solanceApiUrl),
    sanctumUrl: str(raw?.sanctumUrl),
    labels: parseLabels(raw?.labels),
    identity: parseIdentity(raw?.identity),
    contextLogDefault: parseContextLogDefault(raw),
  };
}

function tryLoad(path: string): HouseConfig | null {
  try {
    if (!existsSync(path)) return null;
    return parseHouseConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function loadHouseConfig(env: NodeJS.ProcessEnv = process.env): HouseConfig {
  const explicit = env.HOUSE_CONFIG_PATH;
  if (explicit) return tryLoad(explicit) ?? GENERIC_DEFAULTS;
  const here = dirname(fileURLToPath(import.meta.url)); // <bot>/src/config or <bot>/dist/config
  const botRoot = join(here, '..', '..');
  return tryLoad(join(botRoot, '..', 'house', 'discord.house.json'))
    ?? tryLoad(join(here, '..', 'discord.house.json'))
    ?? GENERIC_DEFAULTS;
}

export const houseConfig: HouseConfig = loadHouseConfig();

/** solance-api base: env SOLANCE_API_URL, else the House config value (no trailing-slash handling: used as-is). */
export function resolveSolanceApiUrl(env: NodeJS.ProcessEnv = process.env, cfg: HouseConfig = houseConfig): string {
  return env.SOLANCE_API_URL || cfg.solanceApiUrl || '';
}

/** Sanctum base: env SANCTUM_URL, else the House config value. */
export function resolveSanctumUrl(env: NodeJS.ProcessEnv = process.env, cfg: HouseConfig = houseConfig): string {
  return env.SANCTUM_URL || cfg.sanctumUrl || '';
}
