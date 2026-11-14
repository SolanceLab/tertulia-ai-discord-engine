// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// The dashboard's one place for earlier names. The page is a separate bundle from the engine, so it cannot
// import the engine's alias module; this is its twin (engine/src/config/legacy-names.ts), and the same rules hold:
// the new name wins, a host that only knows the earlier names keeps working, and one warning per name says what to use.
// shortcut: kept until the next major version; delete this file then.

const warned = new Set()
function warnOnce(oldName, newName) {
  const key = `${oldName}>${newName}`
  if (warned.has(key)) return
  warned.add(key)
  if (typeof console !== 'undefined') console.warn(`[Legacy] "${oldName}" is an earlier name; use "${newName}" instead. The earlier name still works for now.`)
}

/** Test helper: forget the warnings already given. */
export function resetLegacyWarnings() { warned.clear() }

// earlier key -> new key, for config documents a host returns and patches it receives.
const RULE_KEYS = { curfew: 'quiet_hours', flag: 'focus' }
const KEYS = { curfew: 'quiet_hours', scene: 'focus', scene_sighting: 'focus_sighting', scene_sightings: 'focus_sightings' }
const invert = (m) => Object.fromEntries(Object.entries(m).map(([a, b]) => [b, a]))

/** The context-log dial value: the earlier name of 'this_server'. */
export const normalizeMemoryValue = (v) => (v === 'house_channels' ? 'this_server' : v)

// directWins: reading a host's document (toNew), a key already spelled in the target table is the new name and beats
// its earlier alias; writing to a legacy host (toOld), the renamed key is the new name and beats a key already in the host's spelling.
function renameKeys(value, keys, ruleKeys, directWins, parent = '') {
  if (Array.isArray(value)) return value.map((v) => renameKeys(v, keys, ruleKeys, directWins, parent))
  if (!value || typeof value !== 'object') return value
  const table = parent === 'rules' ? ruleKeys : keys
  const targets = new Set(Object.values(table))
  const out = {}
  const convert = (k, v) => (k === 'context_log' && typeof v === 'string' && table === keys && keys === KEYS ? normalizeMemoryValue(v) : renameKeys(v, keys, ruleKeys, directWins, k))
  for (const [k, v] of Object.entries(value)) {
    const to = table[k]
    if (to !== undefined && to !== k) {
      // k is renamed to `to`. When the host's own spelling of `to` is also here and directWins, that one stays.
      if (to in value) {
        if (directWins && JSON.stringify(value[to]) !== JSON.stringify(v)) warnOnce(k, to)
        if (directWins) continue
      }
      out[to] = convert(k, v)
    } else if (!directWins && targets.has(k) && Object.keys(table).some((x) => table[x] === k && x in value)) {
      continue // writing: the renamed new name wins over a key already in the host's spelling
    } else {
      out[k] = convert(k, v)
    }
  }
  return out
}

/** A document from a host that still speaks the earlier keys, in the new keys. */
export const toNew = (doc) => renameKeys(doc, KEYS, RULE_KEYS, true)
/** A patch in the new keys, in the earlier keys a legacy host expects. */
export const toOld = (doc) => renameKeys(doc, invert(KEYS), invert(RULE_KEYS), false)

/** Dashboard label keys a host may still set. */
const LABEL_KEYS = {
  house_channels_option: 'this_server_option',
  curfew_description: 'quiet_hours_description',
  server_rule_curfew: 'server_rule_quiet_hours',
  server_rule_flag: 'server_rule_focus',
}

/** Host label overrides with earlier keys moved to the new ones (the new key wins when both are set). */
export function modernLabels(labels) {
  if (!labels || typeof labels !== 'object') return labels
  const out = { ...labels }
  for (const [oldK, newK] of Object.entries(LABEL_KEYS)) {
    if (!(oldK in out)) continue
    warnOnce(`labels.${oldK}`, `labels.${newK}`)
    if (!(newK in out)) out[newK] = out[oldK]
    delete out[oldK]
  }
  return out
}

/**
 * An adapter written against the earlier host contract (getCurfew / setCurfew, a config with scene and
 * rules.curfew / rules.flag) wrapped to the current one. An adapter that already offers getQuietHours is returned as is.
 */
export function modernAdapter(adapter) {
  if (!adapter || typeof adapter.getQuietHours === 'function' || typeof adapter.getCurfew !== 'function') return adapter
  warnOnce('adapter.getCurfew / setCurfew', 'adapter.getQuietHours / setQuietHours')
  const wrapped = Object.create(adapter)
  wrapped.getQuietHours = async () => {
    const r = await adapter.getCurfew()
    return { ...r, quiet_hours: r.curfew }
  }
  if (typeof adapter.setCurfew === 'function') {
    wrapped.setQuietHours = async (c) => {
      const r = await adapter.setCurfew(c)
      return { ...r, quiet_hours: r.curfew }
    }
  }
  if (typeof adapter.getDiscordConfig === 'function') {
    wrapped.getDiscordConfig = async (...a) => toNew(await adapter.getDiscordConfig(...a))
  }
  if (typeof adapter.setDiscordConfig === 'function') {
    wrapped.setDiscordConfig = async (patch, ...a) => toNew(await adapter.setDiscordConfig(toOld(patch), ...a))
  }
  if (typeof adapter.setAwayOverride === 'function') {
    wrapped.setAwayOverride = async (...a) => toNew(await adapter.setAwayOverride(...a))
  }
  if (typeof adapter.getDiscordServers === 'function') {
    wrapped.getDiscordServers = async (...a) => toNew(await adapter.getDiscordServers(...a))
  }
  return wrapped
}

/** The words the engine's quiet-hours nudge prompt used in rows stored before the rename (context-log recovery). */
export const EARLIER_NUDGE_NOUN = 'curfew'
