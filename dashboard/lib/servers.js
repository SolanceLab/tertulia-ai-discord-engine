// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Per-server settings helpers shared by the Servers section: what a server looks like once the
// host's defaults and the owner's saved choices are laid together, and the smallest patch that
// turns one into the other. Pure functions, no React.

/** The one ladder for how much the bot talks: the big dial, a server and a channel all take one of these. */
const LEGACY_STEPS = { off: 'silent', reactive: 'reply_only', gentle: 'reserved', moderate: 'reserved', high: 'reserved', full: 'reserved' }
const LEVEL_STEPS = ['reply_only', 'reserved', 'balanced', 'sociable', 'chatty']
export const STEPS = ['silent', 'reply_only', 'reserved', 'balanced', 'sociable', 'chatty']

/** A stored channel value as a step: a step as is, an old posture word mapped; null for anything else. */
export function normStep(v) {
  if (STEPS.includes(v)) return v
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_STEPS, v) ? LEGACY_STEPS[v] : null
}
/** The old 0-4 dial as a step (0 still answers mentions, so it is reply_only); null for anything else. */
export function stepFromLevel(n) {
  return Number.isInteger(n) && n >= 0 && n <= 4 ? LEVEL_STEPS[n] : null
}
/** The big dial: `step` if the host sends one, else the old presence_level mapped, else balanced. */
export function houseStepOf(config) {
  return normStep(config && config.step) || stepFromLevel(config && config.presence_level) || 'balanced'
}
export const SERVER_MEMORY_VALUES = ['off', 'mentions_only', 'this_server', 'all']
export const AWAY_RULES = ['channel', 'owner_dm', 'off']

/** A server nobody has set up: silent, curfew on, scene flag off, away off. step null = same as the House dial. */
export const SERVER_DEFAULTS = {
  step: 'silent',
  context_log: null,
  stickers: null,
  rules: { curfew: true, flag: false, away: 'off', copy_to_owner: false },
}

const normMemory = (v) => (v === 'house_channels' ? 'this_server' : v)

/** A host's defaults may still speak the old way (mode / presence_level); read them as a step. */
function defaultStep(d) {
  if (d && d.step !== undefined) return d.step
  if (d && d.mode === 'guest') return 'reply_only'
  if (d && d.mode === 'silent') return 'silent'
  if (d && d.mode === 'home') {
    const fromLevel = stepFromLevel(d.presence_level)
    return fromLevel !== undefined && fromLevel !== null ? fromLevel : null
  }
  return undefined
}

/** The step a saved entry stands for: its own (null = same as House), else an old guest/silent mode, else an old dial; undefined = says nothing. */
function liveStep(l, seeded) {
  if (l.step !== undefined) return l.step
  if (l.mode === 'guest') return 'reply_only'
  if (l.mode === 'silent') return 'silent'
  // An old Home mode or dial speaks only when the host's default is not already a chosen step.
  if (seeded) return undefined
  const fromLevel = stepFromLevel(l.presence_level)
  if (fromLevel) return fromLevel
  return l.mode === 'home' ? null : undefined
}

/** defaults (what the host says before any choice) + live (what was saved), field by field. */
export function effectiveServer(defaults, live) {
  const d = { ...SERVER_DEFAULTS, ...(defaults || {}), rules: { ...SERVER_DEFAULTS.rules, ...((defaults && defaults.rules) || {}) } }
  const l = live || {}
  const given = defaultStep(defaults)
  // Track whether the host explicitly chose a step; an explicit 'silent' is a choice, not the fallback.
  const base = given !== undefined ? given : SERVER_DEFAULTS.step
  const fromLive = liveStep(l, given !== undefined)
  return {
    step: fromLive !== undefined ? fromLive : base,
    context_log: normMemory(l.context_log !== undefined ? l.context_log : d.context_log),
    stickers: l.stickers !== undefined ? l.stickers : (d.stickers !== undefined ? d.stickers : null),
    rules: { ...d.rules, ...(l.rules || {}) },
  }
}

/** The partial patch that takes `before` to `after`, or null when nothing differs. */
export function diffServer(before, after) {
  const patch = {}
  if (after.step !== before.step) patch.step = after.step
  if (after.context_log !== before.context_log) patch.context_log = after.context_log
  if (after.stickers !== before.stickers) patch.stickers = after.stickers
  const rules = {}
  for (const k of ['curfew', 'flag', 'away', 'copy_to_owner']) if (after.rules[k] !== before.rules[k]) rules[k] = after.rules[k]
  if (Object.keys(rules).length) patch.rules = rules
  return Object.keys(patch).length ? patch : null
}

const typeText = (t) => String(t ?? 'text').toLowerCase()
/** Channels people write in. Voice, stage and category rows carry no posture. */
export function isMessageChannel(c) {
  const t = typeText(c.type)
  return t !== 'voice' && t !== 'stage' && t !== 'category'
}

/** Group a flat channel list by Discord category: groups by category position, uncategorized last, channels by position. */
export function groupChannels(channels, uncategorizedName = 'No category') {
  const groups = new Map()
  for (const c of channels || []) {
    if (!c || !isMessageChannel(c)) continue
    const key = c.category ?? ''
    if (!groups.has(key)) groups.set(key, { name: c.category ?? uncategorizedName, uncategorized: c.category == null, position: c.category_position ?? Number.MAX_SAFE_INTEGER, channels: [] })
    groups.get(key).channels.push(c)
  }
  const out = [...groups.values()]
  for (const g of out) g.channels.sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
  out.sort((a, b) => (a.uncategorized - b.uncategorized) || (a.position - b.position) || a.name.localeCompare(b.name))
  return out
}

/** Hours from `now` to the next 07:00 local time. */
export function hoursUntilMorning(now = new Date()) {
  const t = new Date(now)
  t.setHours(7, 0, 0, 0)
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1)
  return Math.round(((t.getTime() - now.getTime()) / 3_600_000) * 100) / 100
}
