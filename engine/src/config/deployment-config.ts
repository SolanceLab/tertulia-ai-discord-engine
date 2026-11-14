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
 * `plugs` choose the model, settings and memory implementations: `direct`/`local`/`off` are the public ones, `custom`
 * hands the choice to the hooks file (TERTULIA_HOOKS_PATH). Config keys the hooks file wants go under `custom`.
 * Earlier file and variable names still load; legacy-names.ts owns them.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIdentity, GENERIC_IDENTITY, type Identity } from './identity-defaults.js';
import { parseServers, type ServerMap } from '../presence/servers.js';
import { type Step, normalizeStep } from '../presence/steps.js';
import { normalizeLegacy, configFileCandidates, noteConfigFile, REMOVED_PLUG_VALUES, readEnv, normalizeContextLog } from './legacy-names.js';
import { DEFAULT_TIMEZONE, resolveTimezone } from './timezone.js';

export type ModelPlug = 'custom' | 'direct';
export type SettingsPlug = 'custom' | 'local';
export type MemoryPlug = 'custom' | 'off';
export interface Plugs {
  model: ModelPlug; settings: SettingsPlug; memory: MemoryPlug;
  /** Plug values from the removed hosted implementations found in the file (createSeams refuses to start on any). */
  removed?: string[];
}

/** Public defaults: direct model calls, a local settings file, no memory. */
export const GENERIC_PLUGS: Plugs = { model: 'direct', settings: 'local', memory: 'off' };

export interface DeploymentConfig {
  plugs: Plugs;
  homeServerId: string;
  /** Guilds where the owner's awareness may be spoken (not just shape tone) when she is the addressee. Generic: none (only private scope says). */
  awareness_say_guilds: string[];
  /** Category ids where a member who creates a channel keeps it as their own (the new channel is locked to them; see owned-channels.ts). Generic: none = off. */
  owned_channel_categories: string[];
  /** IANA time zone for quiet hours, the away return time and message times. Generic default: UTC. */
  timezone: string;
  /** Hours between copies of the home server's audit log into the hooks file's auditSink (see audit-log-copy.ts). 0 = off (generic default). */
  audit_copy_hours: number;
  /** Per-channel seed: a step (an old posture word is read as one). Channels with no live key take it. */
  channelPosture: Record<string, Step>;
  /** Per-server seed (step 2 of resolveServer): how the bot treats each server before the settings document says otherwise. Generic: none. */
  servers: ServerMap;
  ownerOnlyStickerIds: string[];
  quietHoursStickers: Record<'1' | '2' | '3', string | null>;
  presenceErrorChannelId: string | null;
  /** The hooks file's own settings, handed to its provider functions untouched. */
  custom: Record<string, unknown>;
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
  timezone: DEFAULT_TIMEZONE,
  audit_copy_hours: 0,
  channelPosture: {},
  servers: {},
  ownerOnlyStickerIds: [],
  quietHoursStickers: { '1': null, '2': null, '3': null },
  presenceErrorChannelId: null,
  custom: {},
  labels: {},
  identity: GENERIC_IDENTITY,
  contextLogDefault: 'off',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The plugs a file names. A value from the removed hosted implementations is not used: it is listed in `removed`,
 * and createSeams stops the engine with a message naming `custom` and the hooks file. A file with no `plugs` that
 * still names a hosted service URL (an install from before the plugs existed) is treated the same way.
 */
function parsePlugs(raw: any): Plugs {
  const hasPlugs = isObject(raw?.plugs);
  const p: Record<string, unknown> = hasPlugs ? raw.plugs : {};
  const removed: string[] = [];
  const pick = <T extends string>(kind: string, allowed: readonly T[], fallback: T): T => {
    const v = p[kind];
    if (typeof v === 'string' && REMOVED_PLUG_VALUES.includes(v)) { removed.push(`plugs.${kind}: "${v}"`); return fallback; }
    return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  };
  const plugs: Plugs = {
    model: pick('model', ['custom', 'direct'], GENERIC_PLUGS.model),
    settings: pick('settings', ['custom', 'local'], GENERIC_PLUGS.settings),
    memory: pick('memory', ['custom', 'off'], GENERIC_PLUGS.memory),
  };
  if (!hasPlugs && (raw?.modelServiceUrl || raw?.settingsApiUrl)) removed.push('no plugs, with a hosted service URL (modelServiceUrl / settingsApiUrl)');
  if (removed.length) plugs.removed = removed;
  return plugs;
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
    timezone: resolveTimezone(raw?.timezone),
    audit_copy_hours: typeof raw?.audit_copy_hours === 'number' && Number.isFinite(raw.audit_copy_hours) && raw.audit_copy_hours > 0 ? raw.audit_copy_hours : 0,
    channelPosture: posture,
    servers: parseServers(raw?.servers),
    ownerOnlyStickerIds: Array.isArray(raw?.ownerOnlyStickerIds) ? raw.ownerOnlyStickerIds.filter((x: unknown) => typeof x === 'string') : [],
    quietHoursStickers: { '1': str(cs['1']), '2': str(cs['2']), '3': str(cs['3']) },
    presenceErrorChannelId: str(raw?.presenceErrorChannelId),
    custom: isObject(raw?.custom) ? raw.custom : {},
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
