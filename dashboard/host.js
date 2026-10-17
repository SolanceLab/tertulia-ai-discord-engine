// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// The host contract. The page is a module; the host supplies login, look and the
// connection. A host calls setHost({ adapter, labels, theme, contextLog }) once
// (the manifest's setup(host) does it) before any page renders. See HOST.md.
import { resolveLabels } from './labels.js'

/**
 * @typedef {Object} DiscordAdapter  every method returns a Promise
 * @property {() => Promise<{discord: Object}>} getDiscordConfig
 *   discord = { step, presence_level, sweep_minutes, posture: {channelId: step}, extra_instructions,
 *   name_triggers: string[], stickers_enabled, away: {announce, override}, context_log, ignored_user_ids: string[],
 *   servers: {[id]: {step?, context_log?, rules?}}, scene: {active, raised_at, raised_by, until, lowered_at},
 *   scene_sightings: {raised_at, caught}[] }
 * @property {(patch: Object) => Promise<{discord: Object}>} setDiscordConfig  partial patch, returns the full updated object.
 *   Also accepts {servers: {[id]: {step?, context_log?, rules?: {curfew?, flag?, away?}}}} (a partial per server,
 *   null clears context_log, and step null = same as the main dial) and {scene: {active: true, raised_by, until_hours} | {active: false}}
 * @property {() => Promise<{servers: {id, name, icon?, channel_count, joined_at?, defaults?}[]}>} getDiscordServers
 *   the servers the bot is in. `defaults` (optional) is how a server behaves before the owner has chosen anything
 *   ({step, context_log, rules}); absent, the page assumes silent. Without this method the page hides
 *   the Servers and Focus mode sections and keeps the flat per-channel posture list.
 * @property {(guildId?: string) => Promise<{channels: {id, name, type, category, category_position, position}[]}>} getDiscordChannels
 *   one server's channels (the host keeps its main server when guildId is absent)
 * @property {(ids: string[]) => Promise<{users: {id, name: string|null}[]}>} getDiscordUserInfo
 * @property {(channel: string) => Promise<{blocklist: string[]}>} getChannelBlocklist  called with 'discord'
 * @property {(channel: string, words: string[]) => Promise<{blocklist: string[]}>} setChannelBlocklist  called with 'discord'
 * @property {() => Promise<{curfew: {enabled, start, end}}>} getCurfew
 * @property {(c: {enabled: boolean, start: string, end: string}) => Promise<{curfew: Object}>} setCurfew
 * @property {() => Promise<{away: boolean, source, status, reason, announce, reason_shareable, until, until_label}>} getAwayStatus
 * @property {(o: {active: boolean, reason: string, until: string|null, shareReason: boolean}) => Promise<{discord: Object}>} setAwayOverride
 *   `until` is an ISO instant or null; `shareReason` false keeps the reason private. Returns the updated config like setDiscordConfig.
 * @property {() => Promise<{next: {start: string, end: string, label?: string|null}|null, source: 'calendar'|'host'|null}>} [getAwaySchedule]
 *   optional: the next scheduled away. When absent the page shows no schedule line.
 * @property {() => Promise<{linked: boolean, host: string|null, unreachable?: boolean}>} [getAwayCalendar]
 *   optional, with setAwayCalendar: whether a calendar is linked. Never carries the address.
 * @property {(url: string|null) => Promise<{linked: boolean, host: string|null, unreachable?: boolean}>} [setAwayCalendar]
 *   optional: link (https iCal address) or unlink (null). The page shows the Calendar row only when this exists.
 * @property {(q: {channel: string, limit: number}) => Promise<{messages: Object[]}>} getContextLogs
 */

/**
 * @typedef {Object} DiscordHost
 * @property {DiscordAdapter} adapter
 * @property {Object<string, string|string[]>} [labels]  overrides for DEFAULT_LABELS (labels.js)
 * @property {Object<string, boolean>} [capabilities]  false hides a section the adapter cannot save (sweep_minutes, extra_instructions, name_triggers, stickers_enabled); also read from adapter.capabilities
 * @property {Object} [theme]  free-form; the pages take their look from the host's CSS
 * @property {{selfNames?: string[], transcriptTags?: string[]}} [contextLog]  legacy context-log recovery hints
 */

/** Settings sections a host can switch off. Absent keys default to supported. */
export const CAPABILITY_KEYS = ['sweep_minutes', 'extra_instructions', 'name_triggers', 'stickers_enabled']

function resolveCapabilities(host) {
  const given = { ...(host.adapter && host.adapter.capabilities), ...host.capabilities }
  const out = {}
  for (const k of CAPABILITY_KEYS) out[k] = given[k] !== false
  return out
}

let current = null

/** @param {DiscordHost} host */
export function setHost(host) {
  if (!host || typeof host !== 'object' || !host.adapter) {
    throw new Error('setHost needs { adapter, labels?, theme? } — the Discord module has no connection without an adapter.')
  }
  current = { ...host, labels: resolveLabels(host.labels), capabilities: resolveCapabilities(host), contextLog: host.contextLog || {} }
  return current
}

/** React hook: the host the module was given. Throws if setHost was never called. */
export function useHost() {
  if (!current) {
    throw new Error('Discord module: no host set. Call manifest.setup(host) or setHost({ adapter, labels }) before rendering a page.')
  }
  return current
}

/** React hook: the resolved labels (neutral defaults under the host's overrides). */
export function useLabels() {
  return useHost().labels
}

/** For tests: forget the current host. */
export function resetHost() {
  current = null
}

/** React hook: which optional settings sections this host supports. */
export function useCapabilities() {
  return useHost().capabilities
}
