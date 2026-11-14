// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * deployment-config.ts — every deployment-specific value (ids, URLs, names, wording) the engine reads.
 * Engine code reads those values ONLY through this module.
 *
 * Load order (first that exists and parses wins):
 *   1. env CONFIG_PATH (an explicit path; if set but missing/invalid we do NOT
 *      fall through to the next file — we use the generic defaults)
 *   2. <bot root>/../deployment/discord.config.json   (monorepo checkout / local dev)
 *   3. <dist>/discord.config.json                (copied in by `npm run build`; this is
 *      what a container image carries, since its build context is the engine folder alone)
 *   4. generic defaults: empty maps, no ids, no URLs.
 * Earlier file and variable names still load; legacy-names.ts owns them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIdentity, GENERIC_IDENTITY, type Identity } from './identity-defaults.js';
import { parseServers, type ServerMap } from '../presence/servers.js';
import { type Step, normalizeStep } from '../presence/steps.js';
import { normalizeLegacy, configFileCandidates, noteConfigFile, normalizePlugValue, readEnv, normalizeContextLog } from './legacy-names.js';

export type ModelPlug = 'custom' | 'direct';
export type SettingsPlug = 'custom' | 'local';
export type MemoryPlug = 'custom' | 'off';
export interface Plugs { model: ModelPlug; settings: SettingsPlug; memory: MemoryPlug }

/** Public defaults: direct model calls, a local settings file, no memory. */
export const GENERIC_PLUGS: Plugs = { model: 'direct', settings: 'local', memory: 'off' };

export interface DeploymentConfig {
  plugs: Plugs;
  homeServerId: string;
  /** Guilds where the owner's awareness may be spoken (not just shape tone) when she is the addressee. Generic: none (only private scope says). */
  awareness_say_guilds: string[];
  /** Category ids where a member who creates a channel keeps it as their own (the new channel is locked to them; see owned-channels.ts). Generic: none = off. */
  owned_channel_categories: string[];
  /** Hours between copies of the home server's audit log into the model service (see audit-log-copy.ts). 0 = off (generic default). */
  audit_copy_hours: number;
  /** Per-channel seed: a step (an old posture word is read as one). Channels with no live key take it. */
  channelPosture: Record<string, Step>;
  /** Per-server seed (step 2 of resolveServer): how the bot treats each server before the settings document says otherwise. Generic: none. */
  servers: ServerMap;
  ownerOnlyStickerIds: string[];
  quietHoursStickers: Record<'1' | '2' | '3', string | null>;
  /** A channel where a reply tends a character (the care-reply feature); null = feature off. */
  careChannelId: string | null;
  presenceErrorChannelId: string | null;
  settingsApiUrl: string | null;
  modelServiceUrl: string | null;
  /** Section-name overrides for the settings page (e.g. House: quiet_hours -> 'quiet hours'). Generic: none. */
  labels: Record<string, string>;
  /** Who the bot is and who it answers to: names, labels, reserved wording. Generic defaults when absent. */
  identity: Identity;
  /** What the context-log dial starts at before anyone sets it. Generic: 'off' (records nothing); the config seed: 'this_server'. */
  contextLogDefault: string;
}

export const GENERIC_DEFAULTS: DeploymentConfig = {
  plugs: { ...GENERIC_PLUGS },
  homeServerId: '',
  awareness_say_guilds: [],
  owned_channel_categories: [],
  audit_copy_hours: 0,
  channelPosture: {},
  servers: {},
  ownerOnlyStickerIds: [],
  quietHoursStickers: { '1': null, '2': null, '3': null },
  careChannelId: null,
  presenceErrorChannelId: null,
  settingsApiUrl: null,
  modelServiceUrl: null,
  labels: {},
  identity: GENERIC_IDENTITY,
  contextLogDefault: 'off',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** A config file written before `plugs` existed used the hosted services: keep it on them.
 *  shortcut: dropped, with the hosted implementations, when the provider socket lands. */
export const LEGACY_DEFAULT_PLUGS: Plugs = { model: 'custom', settings: 'custom', memory: 'custom' };

function parsePlugs(raw: any): Plugs {
  const hasPlugs = raw?.plugs && typeof raw.plugs === 'object';
  const base = hasPlugs ? GENERIC_PLUGS : LEGACY_DEFAULT_PLUGS;
  const p = hasPlugs ? raw.plugs : {};
  return {
    model: ((m) => (m === 'custom' || m === 'direct' ? m : base.model))(normalizePlugValue(p.model)),
    settings: ((m) => (m === 'custom' || m === 'local' ? m : base.settings))(normalizePlugValue(p.settings)),
    memory: ((m) => (m === 'custom' || m === 'off' ? m : base.memory))(normalizePlugValue(p.memory)),
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

const CONTEXT_LOG_DEFAULTS = new Set(['off', 'mentions_only', 'this_server', 'all']);
/** The explicit value if valid; else 'this_server' for a file that uses the hosted memory service, 'off' for everyone else. */
function parseContextLogDefault(raw: any): string {
  const given = normalizeContextLog(raw?.contextLogDefault);
  if (typeof given === 'string' && CONTEXT_LOG_DEFAULTS.has(given)) return given;
  return parsePlugs(raw).memory === 'custom' ? 'this_server' : 'off';
}

export function parseDeploymentConfig(rawIn: any): DeploymentConfig {
  const raw = normalizeLegacy(rawIn);
  const posture: Record<string, Step> = {};
  if (raw?.channelPosture && typeof raw.channelPosture === 'object') {
    for (const [id, p] of Object.entries(raw.channelPosture)) { const st = normalizeStep(p); if (st) posture[id] = st; }
  }
  const cs = raw?.quietHoursStickers ?? {};
  return {
    plugs: parsePlugs(raw),
    homeServerId: str(raw?.homeServerId) ?? '',
    awareness_say_guilds: Array.isArray(raw?.awareness_say_guilds) ? raw.awareness_say_guilds.filter((x: unknown) => typeof x === 'string') : [],
    owned_channel_categories: Array.isArray(raw?.owned_channel_categories) ? raw.owned_channel_categories.filter((x: unknown) => typeof x === 'string') : [],
    audit_copy_hours: typeof raw?.audit_copy_hours === 'number' && Number.isFinite(raw.audit_copy_hours) && raw.audit_copy_hours > 0 ? raw.audit_copy_hours : 0,
    channelPosture: posture,
    servers: parseServers(raw?.servers),
    ownerOnlyStickerIds: Array.isArray(raw?.ownerOnlyStickerIds) ? raw.ownerOnlyStickerIds.filter((x: unknown) => typeof x === 'string') : [],
    quietHoursStickers: { '1': str(cs['1']), '2': str(cs['2']), '3': str(cs['3']) },
    careChannelId: str(raw?.careChannelId),
    presenceErrorChannelId: str(raw?.presenceErrorChannelId),
    settingsApiUrl: str(raw?.settingsApiUrl),
    modelServiceUrl: str(raw?.modelServiceUrl),
    labels: parseLabels(raw?.labels),
    identity: parseIdentity(raw?.identity),
    contextLogDefault: parseContextLogDefault(raw),
  };
}

function tryLoad(path: string): DeploymentConfig | null {
  try {
    if (!existsSync(path)) return null;
    return parseDeploymentConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

export function loadDeploymentConfig(env: NodeJS.ProcessEnv = process.env): DeploymentConfig {
  const explicit = readEnv('CONFIG_PATH', env);
  if (explicit) return tryLoad(explicit) ?? GENERIC_DEFAULTS;
  const here = dirname(fileURLToPath(import.meta.url)); // <bot>/src/config or <bot>/dist/config
  const botRoot = join(here, '..', '..');
  const found = configFileCandidates(botRoot, join(here, '..'), join)
    .map((path) => [path, tryLoad(path)] as const)
    .find(([, cfg]) => cfg !== null);
  if (found) noteConfigFile(found[0]);
  return found?.[1] ?? GENERIC_DEFAULTS;
}

export const deployConfig: DeploymentConfig = loadDeploymentConfig();

/** The hosted settings API base: env SETTINGS_API_URL, else the config value (no trailing-slash handling: used as-is). */
export function resolveSettingsApiUrl(env: NodeJS.ProcessEnv = process.env, cfg: DeploymentConfig = deployConfig): string {
  return readEnv('SETTINGS_API_URL', env) || cfg.settingsApiUrl || '';
}

/** The hosted model service base: env MODEL_SERVICE_URL, else the config value. */
export function resolveModelServiceUrl(env: NodeJS.ProcessEnv = process.env, cfg: DeploymentConfig = deployConfig): string {
  return readEnv('MODEL_SERVICE_URL', env) || cfg.modelServiceUrl || '';
}
