// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * legacy-names.ts — the ONE place that knows the engine's earlier names.
 *
 * The engine renamed its deployment-specific words (quiet hours, focus mode, agent window, home server,
 * a deployment config, a model service, a settings API). Installs written against the earlier names keep
 * working: every reader of an env var, a config file, a config key, a stored setting, a plug value, an
 * HTTP route or a dashboard host method asks this module first.
 *
 * Rules, the same for every kind of name:
 *   - the new name wins;
 *   - only the old name is set -> it is used, and one warning per process names the new one;
 *   - both are set and differ -> the new one is used, and the warning says so.
 *
 * Legacy spellings live here and in tests, nowhere else (neutral-prompts.test.ts scans for them).
 * shortcut: the old names are kept until the next major version; delete this file's tables then.
 */
// No imports: identity, the logger and the config loader all depend on this file, so it warns through console.warn.

const warned = new Set<string>();

/** One warning per old name per process. `detail` is appended when both names were set. */
export function warnLegacy(oldName: string, newName: string, detail = ''): void {
  const key = `${oldName}>${newName}>${detail}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[Legacy] "${oldName}" is an earlier name; use "${newName}" instead${detail ? ` (${detail})` : ''}. The earlier name still works for now.`);
}

/** Tests: forget which warnings were already given. */
export function resetLegacyWarnings(): void {
  warned.clear();
}

/** How many distinct warnings were given (tests). */
export function legacyWarningCount(): number {
  return warned.size;
}

// ── env vars ────────────────────────────────────────────────────────────────

/** new env name -> earlier env name. */
export const ENV_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  CONFIG_PATH: 'HOUSE_CONFIG_PATH',
  MODEL_SERVICE_URL: 'SANCTUM_URL',
  MODEL_SERVICE_KEY: 'SANCTUM_KEY',
  SETTINGS_API_URL: 'SOLANCE_API_URL',
  SETTINGS_API_TOKEN: 'SOLANCE_TOKEN',
  AGENT_ASIDE_GUEST_TEXT: 'STUDY_ASIDE_GUEST_TEXT',
});

/** The value of an env var by its new name, falling back to its earlier name. Empty strings count as unset. */
export function readEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fresh = env[name] || undefined;
  const old = ENV_ALIASES[name];
  const earlier = old ? env[old] || undefined : undefined;
  if (fresh !== undefined) {
    if (earlier !== undefined && earlier !== fresh) warnLegacy(old, name, `both are set and differ; ${name} is used`);
    return fresh;
  }
  if (earlier !== undefined) { warnLegacy(old, name); return earlier; }
  return undefined;
}

// ── files ───────────────────────────────────────────────────────────────────

/** The deployment config file: new location first, then the earlier one beside it. */
export function configFileCandidates(botRoot: string, distDir: string, join: (...p: string[]) => string): string[] {
  return [
    join(botRoot, '..', 'deployment', 'discord.config.json'),
    join(botRoot, '..', 'house', 'discord.house.json'),
    join(distDir, 'discord.config.json'),
    join(distDir, 'discord.house.json'),
  ];
}

/** Warn once when the config that loaded is the earlier file name. */
export function noteConfigFile(path: string): void {
  if (path.endsWith('discord.house.json')) warnLegacy('discord.house.json', 'discord.config.json');
}

/** Warn once when the hooks module that loaded has the earlier file name. */
export function noteHooksFile(path: string): void {
  if (path.endsWith('house.hooks.js') || path.endsWith('house/hooks.ts')) warnLegacy('house.hooks.js', 'hooks.js');
}

/** True when a deployment-layer path uses the earlier folder or file names. */
export function isLegacyLayerPath(path: string): boolean {
  return /(^|[\\/])house([\\/]|\.hooks\.js$)|discord\.house\.json$/.test(path);
}

/** Where the build looks for the deployment layer's files (new location first). Used by scripts/bundle-deployment-config.mjs. */
export function bundleSources(botRoot: string, join: (...p: string[]) => string): { config: string[]; hooks: string[] } {
  return {
    config: [join(botRoot, '..', 'deployment', 'discord.config.json'), join(botRoot, '..', 'house', 'discord.house.json')],
    hooks: [join(botRoot, '..', 'deployment', 'hooks.ts'), join(botRoot, '..', 'house', 'hooks.ts')],
  };
}

/** The hooks module: new names first. `here` is the compiled or source file of hooks.ts. */
export function hooksFileCandidates(dir: string, fromSource: boolean, join: (...p: string[]) => string): string[] {
  const out = [join(dir, 'hooks.js'), join(dir, 'house.hooks.js')];
  if (fromSource) out.push(join(dir, '..', '..', 'deployment', 'hooks.ts'), join(dir, '..', '..', 'house', 'hooks.ts'));
  return out;
}

// ── keys and values ─────────────────────────────────────────────────────────

/** Earlier key -> new key. Applied at any depth of a config file, a stored settings document or a request body. */
const KEY_RENAMES: Readonly<Record<string, string>> = Object.freeze({
  curfew: 'quiet_hours',
  curfew_events: 'quiet_hours_events',
  curfew_stickers: 'quiet_hours_stickers',
  curfewStickers: 'quietHoursStickers',
  scene: 'focus',
  scene_sighting: 'focus_sighting',
  scene_sightings: 'focus_sightings',
  study: 'agent_window',
  study_command: 'agent_command',
  intimate_tells: 'private_tells',
  intimateStickerIds: 'ownerOnlyStickerIds',
  hosServerId: 'homeServerId',
  solanceApiUrl: 'settingsApiUrl',
  sanctumUrl: 'modelServiceUrl',
});

/** Keys that are only earlier names under a given parent: servers[id].rules.flag. */
const RULES_KEY_RENAMES: Readonly<Record<string, string>> = Object.freeze({ curfew: 'quiet_hours', flag: 'focus' });

/** Identity text keys (sentence templates): `curfew.tone.1` -> `quiet.tone.1`, `scene.2` -> `focus.2`. */
function renameTextKey(k: string): string {
  if (k.startsWith('curfew.')) return `quiet.${k.slice('curfew.'.length)}`;
  if (k.startsWith('scene.')) return `focus.${k.slice('scene.'.length)}`;
  return k;
}

/** Dashboard label keys a host may still set. */
const LABEL_KEY_RENAMES: Readonly<Record<string, string>> = Object.freeze({
  house_channels_option: 'this_server_option',
  curfew_description: 'quiet_hours_description',
  server_rule_curfew: 'server_rule_quiet_hours',
  server_rule_flag: 'server_rule_focus',
});

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Move `from` onto `to` in `obj` (new wins when both exist and differ). Returns true when `from` was present. */
function moveKey(obj: Record<string, any>, from: string, to: string, ctx: string): boolean {
  if (!(from in obj)) return false;
  if (to in obj) {
    if (JSON.stringify(obj[to]) !== JSON.stringify(obj[from])) warnLegacy(`${ctx}${from}`, `${ctx}${to}`, `both are set and differ; ${to} is used`);
    else warnLegacy(`${ctx}${from}`, `${ctx}${to}`);
  } else {
    obj[to] = obj[from];
    warnLegacy(`${ctx}${from}`, `${ctx}${to}`);
  }
  delete obj[from];
  return true;
}

function renameDeep(value: any, ctx: string, parent: string): any {
  if (Array.isArray(value)) return value.map((v) => renameDeep(v, ctx, parent));
  if (!isObj(value)) return value;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) out[k] = parent === 'text' || parent === 'labels' || parent === 'posture' ? v : renameDeep(v, ctx, k);
  const table = parent === 'rules' ? RULES_KEY_RENAMES : KEY_RENAMES;
  if (parent !== 'text' && parent !== 'labels' && parent !== 'posture') {
    for (const [oldK, newK] of Object.entries(table)) moveKey(out, oldK, newK, '');
  }
  if (parent === 'text') {
    for (const k of Object.keys(out)) {
      const n = renameTextKey(k);
      if (n !== k) moveKey(out, k, n, '');
    }
  }
  if (parent === 'labels') {
    for (const [oldK, newK] of Object.entries(LABEL_KEY_RENAMES)) moveKey(out, oldK, newK, '');
  }
  return out;
}

/** Context-log dial values: the earlier name of 'this_server'. */
export function normalizeContextLog<T>(v: T): T | 'this_server' {
  if (v === ('house_channels' as unknown)) { warnLegacy('house_channels', 'this_server'); return 'this_server'; }
  return v;
}

/** Plug values: the earlier names of the hosted implementations are the value 'custom'. */
export function normalizePlugValue<T>(v: T): T | 'custom' {
  if (v === ('sanctum' as unknown)) { warnLegacy('sanctum', 'custom'); return 'custom'; }
  if (v === ('solance-api' as unknown)) { warnLegacy('solance-api', 'custom'); return 'custom'; }
  return v;
}

/** The aside `to:` values: earlier names for the model ('sanctum') and the agent ('study'). */
export function normalizeAsideTo<T>(v: T): T | 'model' | 'agent' {
  if (v === ('sanctum' as unknown)) { warnLegacy('sanctum', 'model'); return 'model'; }
  if (v === ('study' as unknown)) { warnLegacy('study', 'agent'); return 'agent'; }
  return v;
}

/** A stored `source` of an away status: the earlier name of 'quiet_hours'. */
function renameSourceValue(v: any): any {
  if (v === 'curfew') { warnLegacy('source: curfew', 'source: quiet_hours'); return 'quiet_hours'; }
  return v;
}

/**
 * A stored or received settings document / config / request body, with earlier keys and values moved to
 * the new ones. Pure: returns a copy. Safe to call twice (the second call finds nothing to move).
 */
export function normalizeLegacy<T = any>(raw: T): T {
  if (!isObj(raw) && !Array.isArray(raw)) return raw;
  const out = renameDeep(raw, '', '');
  const fix = (o: any, parent: string): void => {
    if (Array.isArray(o)) { o.forEach((x) => fix(x, parent)); return; }
    if (!isObj(o)) return;
    if (typeof o.context_log === 'string') o.context_log = normalizeContextLog(o.context_log);
    if (typeof o.contextLogDefault === 'string') o.contextLogDefault = normalizeContextLog(o.contextLogDefault);
    if (isObj(o.plugs)) for (const k of ['model', 'settings', 'memory']) if (typeof o.plugs[k] === 'string') o.plugs[k] = normalizePlugValue(o.plugs[k]);
    if (Array.isArray(o.aside_choices)) for (const c of o.aside_choices) if (isObj(c) && typeof c.value === 'string') c.value = normalizeAsideTo(c.value);
    if (typeof o.source === 'string') o.source = renameSourceValue(o.source);
    for (const [k, v] of Object.entries(o)) fix(v, k);
  };
  fix(out, '');
  return out;
}

// ── the hosted services' wire format ────────────────────────────────────────
// The hosted model service and settings API are separate programs that still speak the earlier names.
// shortcut: these constants and toLegacyWire() go away with the hosted implementations (the provider
// socket batch moves them out of this repo).

/** Paths of the hosted settings API. */
export const HOSTED_ROUTES = Object.freeze({
  quietHours: '/routine/curfew',
  quietHoursEvent: '/routine/curfew-event',
});

const WIRE_KEYS: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(Object.entries({
  quiet_hours: 'curfew', quiet_hours_events: 'curfew_events', quiet_hours_stickers: 'curfew_stickers',
  focus: 'scene', focus_sighting: 'scene_sighting', focus_sightings: 'scene_sightings', agent_window: 'study',
}).map(([a, b]) => [a, b])));

/** A body for the hosted settings API: new keys turned back into the names it knows. */
export function toLegacyWire<T = any>(body: T): T {
  if (Array.isArray(body)) return body.map(toLegacyWire) as unknown as T;
  if (!isObj(body)) return body;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(body)) out[WIRE_KEYS[k] ?? k] = toLegacyWire(v);
  return out as T;
}

// ── command-line flags ──────────────────────────────────────────────────────

/** scripts/register-aside.mjs: the earlier `--study` flag is `--agent`. */
export function normalizeCliFlag(arg: string): string {
  if (arg === '--study') { warnLegacy('--study', '--agent'); return '--agent'; }
  return arg;
}

// ── HTTP routes ─────────────────────────────────────────────────────────────

/** The agent-window queue routes live under `/api/aside/agent/`; the earlier prefix is rewritten to it. */
export const LEGACY_ASIDE_ROUTE_PREFIX = '/api/aside/study';
export const ASIDE_ROUTE_PREFIX = '/api/aside/agent';

/** A request url with the earlier route prefix moved to the new one (one warning per process). */
export function rewriteLegacyRoute(url: string): string {
  if (!url.startsWith(`${LEGACY_ASIDE_ROUTE_PREFIX}/`)) return url;
  warnLegacy(LEGACY_ASIDE_ROUTE_PREFIX, ASIDE_ROUTE_PREFIX);
  return ASIDE_ROUTE_PREFIX + url.slice(LEGACY_ASIDE_ROUTE_PREFIX.length);
}
