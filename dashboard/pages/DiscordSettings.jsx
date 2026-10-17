// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useLabels, useHost } from '../host.js'
import { addBlocklistWord, removeBlocklistWord } from '../lib/blocklistChips'
import { normStep, groupChannels, effectiveServer, STEPS, SERVER_MEMORY_VALUES, houseStepOf, diffServer, AWAY_RULES, hoursUntilMorning } from '../lib/servers.js'
import './range.css'

// ── Shared classes (matches Routines.jsx / Skills.jsx / Watch.jsx house style) ──
const btnPrimary = "px-4 py-2 text-xs uppercase tracking-[0.18em] font-light border border-[color:var(--gold-soft)] text-[color:var(--page)] rounded-md transition-colors hover:bg-[color:var(--gold-glow)] disabled:opacity-50 font-[JetBrains_Mono,monospace]"
const inputClass = "w-full bg-[color:var(--ink)] border border-[color:var(--rule-mid)] rounded-md px-3 py-2 text-base text-[color:var(--page)] font-[Söhne,sans-serif] placeholder-[color:var(--page-faint)] focus:outline-none focus:border-[color:var(--gold-soft)] transition-colors"
const btnSecondary = "px-4 py-2 text-xs uppercase tracking-[0.18em] font-light border border-[color:var(--rule-mid)] text-[color:var(--page-dim)] hover:text-[color:var(--page)] hover:border-[color:var(--gold-soft)] rounded-md transition-colors font-[JetBrains_Mono,monospace]"
const labelClasses = "text-[10px] uppercase tracking-[0.18em] font-light text-[color:var(--page-muted)] font-[JetBrains_Mono,monospace]"
const cardClasses = "bg-[color:var(--ink-deep)] border border-[color:var(--rule-mid)] rounded-lg p-4 sm:p-5"

const dialTickBase = "text-[10px] normal-case tracking-normal font-light font-[Söhne,sans-serif]"
const dialTick = (active) => `${dialTickBase} ${active ? 'text-[color:var(--gold-text)]' : 'text-[color:var(--page-muted)]'}`

// One ladder (silent .. chatty) for the big dial, a server and a channel; labels.step_<value> names each
// step and labels.step_<value>_hint says what it means.

const contextLogLabels = (labels) => ['Off', 'Mentions only', labels.house_channels_option, 'All']
const CONTEXT_LOG_VALUES = ['off', 'mentions_only', 'house_channels', 'all']

// ── Range input with an explicit gold fill (see range.css) — the fill is a CSS variable, so it
// stays gold whether or not the window has focus ──
function RangeInput({ min, max, value, onChange }) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={1}
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      className="range-fill w-full min-h-[44px]"
      style={{ '--fill': `${pct}%` }}
    />
  )
}

// ── Shared load-error notice — used instead of silently defaulting when a
// GET fails, so a transient error or expired session can't leave Save
// enabled over hardcoded defaults (controls stay unmounted until retry succeeds) ──
function LoadErrorNotice({ message, onRetry }) {
  return (
    <div>
      <p className="text-sm text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{message}</p>
      <button onClick={onRetry} className={btnSecondary + ' mt-3'}>Retry</button>
    </div>
  )
}

// ── Presence dial ──

function PresenceDialSection({ config, loading, loadError, onRetry, onUpdated }) {
  const { adapter } = useHost()
  const labels = useLabels()
  const [step, setStep] = useState('balanced')
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (config && !initialized) {
      setStep(houseStepOf(config))
      setInitialized(true)
    }
  }, [config, initialized])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const { discord } = await adapter.setDiscordConfig({ step })
      onUpdated(discord)
      setStep(houseStepOf(discord) || step)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Could not save the presence dial. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">Presence dial</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        {labels.presence_description}
      </p>

      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : (
        <>
          <div className="mb-4">
            <RangeInput min={0} max={STEPS.length - 1} value={STEPS.indexOf(step)} onChange={i => setStep(STEPS[i])} />
            <div className="flex justify-between mt-1 gap-1">
              {STEPS.map(st => (
                <span
                  key={st}
                  className={dialTick(st === step)}
                >
                  {labels[`step_${st}`]}
                </span>
              ))}
            </div>
            <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-3" data-step-meaning>
              {labels[`step_${step}_hint`]}
            </p>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save presence'}
            </button>
            {saved && <span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
            {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
          </div>
        </>
      )}
    </section>
  )
}

// ── Context log dial ──
// Mirrors PresenceDialSection's slider-with-labels shape exactly, but over
// four discrete string values instead of five integer presence levels.
// Reads/writes `context_log` through the existing GET/PUT /routine/discord
// (setDiscordConfig) — no new endpoint.

function ContextLogSection({ config, loading, loadError, onRetry, onUpdated }) {
  const { adapter } = useHost()
  const labels = useLabels()
  const [level, setLevel] = useState(2) // house_channels
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (config && !initialized) {
      const idx = CONTEXT_LOG_VALUES.indexOf(config.context_log)
      setLevel(idx >= 0 ? idx : 2)
      setInitialized(true)
    }
  }, [config, initialized])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const { discord } = await adapter.setDiscordConfig({ context_log: CONTEXT_LOG_VALUES[level] })
      onUpdated(discord)
      const idx = CONTEXT_LOG_VALUES.indexOf(discord.context_log)
      setLevel(idx >= 0 ? idx : level)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Could not save the context log setting. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">{labels.context_log_title}</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        {labels.context_log_description}
      </p>
      {config && config.memory && (
        <p className="text-xs font-light text-[color:var(--page-dim)] font-[JetBrains_Mono,monospace] mb-4" data-testid="memory-status">
          {labels.memory_status_label}: {labels['memory_' + config.memory.kind] || config.memory.kind}
          {config.memory.kind !== 'off' && ` — ${config.memory.ready ? labels.memory_connected : labels.memory_unreachable}`}
        </p>
      )}

      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : (
        <>
          <div className="mb-4">
            <RangeInput min={0} max={3} value={level} onChange={setLevel} />
            <div className="flex justify-between mt-1">
              {contextLogLabels(labels).map((lbl, i) => (
                <span
                  key={lbl}
                  className={dialTick(i === level)}
                >
                  {lbl}
                </span>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save context log'}
            </button>
            {saved && <span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
            {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
          </div>
        </>
      )}
    </section>
  )
}

// ── Cadence ──

function CadenceSection({ config, loading, loadError, onRetry, onUpdated }) {
  const { adapter } = useHost()
  const [minutes, setMinutes] = useState(30)
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (config && !initialized) {
      setMinutes(Number.isFinite(config.sweep_minutes) ? config.sweep_minutes : 30)
      setInitialized(true)
    }
  }, [config, initialized])

  const save = async () => {
    const n = Number(minutes)
    if (!Number.isFinite(n) || n < 5 || n > 240) {
      setError('Cadence must be between 5 and 240 minutes.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { discord } = await adapter.setDiscordConfig({ sweep_minutes: n })
      onUpdated(discord)
      setMinutes(Number.isFinite(discord.sweep_minutes) ? discord.sweep_minutes : n)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Could not save the cadence. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">Cadence</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        Minutes between ambient sweeps. Reactions to direct mentions stay instant regardless.
      </p>

      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : (
        <>
          <div className="mb-4 max-w-[160px]">
            <label className={labelClasses + ' block mb-1.5'}>Minutes (5–240)</label>
            <input
              type="number"
              min={5}
              max={240}
              value={minutes}
              onChange={e => setMinutes(e.target.value)}
              className={inputClass}
            />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save cadence'}
            </button>
            {saved && <span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
            {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
          </div>
        </>
      )}
    </section>
  )
}

// Shown beside a Save button whenever the card holds edits the server has
// not received. Add/Enter on the chip cards only changes the page; without
// this, an unsaved chip looks identical to a saved one.
function UnsavedNote({ show }) {
  if (!show) return null
  return (
    <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">
      Unsaved changes — press Save
    </span>
  )
}

// Compares posture the way save() builds it: a channel -> value mapping with
// blank channels dropped, so row order and a remove-then-re-add don't read
// as unsaved.
function postureKey(rows) {
  const map = {}
  for (const r of rows) if (r.channel.trim()) map[r.channel.trim()] = r.value
  return JSON.stringify(Object.keys(map).sort().map(k => [k, map[k]]))
}

// ── Per-channel posture ──
// Rows key on the raw Discord channel id (unchanged — that's still the
// editable value and the thing that gets saved). The channel list (GET
// /discord/channels) is fetched once, best-effort, purely to LABEL each row
// with a readable name — mirrors IgnoreListSection's resolveNames pattern:
// fetched independent of the config load, never awaited by save, silent on
// failure, and an id the list doesn't cover just renders with "unknown"
// beneath it instead of a name.

function PostureSection({ config, loading, loadError, onRetry, onUpdated }) {
  const { adapter } = useHost()
  const labels = useLabels()
  const [rows, setRows] = useState([])
  const [savedRows, setSavedRows] = useState([])
  const [newChannel, setNewChannel] = useState('')
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const [channels, setChannels] = useState([]) // [{id,name,type,category}] — best-effort, empty on failure

  useEffect(() => {
    if (config && !initialized) {
      const posture = config.posture || {}
      const initial = Object.entries(posture).map(([channel, value]) => ({ channel, value: normStep(value) || value }))
      setRows(initial)
      setSavedRows(initial)
      setInitialized(true)
    }
  }, [config, initialized])

  // Fetched once per card mount, independent of the posture config load —
  // a slow or failed channel list must never hold up (or break) the rows
  // above, which stay fully editable/saveable with raw ids alone.
  useEffect(() => {
    let cancelled = false
    adapter.getDiscordChannels()
      .then(({ channels: list }) => { if (!cancelled) setChannels(list || []) })
      .catch(() => {
        // Swallow — every row already renders its raw id as a safe fallback.
      })
    return () => { cancelled = true }
  }, [])

  const channelById = useMemo(() => {
    const map = {}
    for (const c of channels) map[c.id] = c
    return map
  }, [channels])

  const updateRow = (i, patch) => {
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  }

  const removeRow = i => setRows(rows.filter((_, idx) => idx !== i))

  const addRow = () => {
    const typed = newChannel.trim()
    if (!typed) return
    // A pasted raw id always wins as-is. Only when the typed text isn't
    // already an id do we check whether it matches a fetched channel's
    // name — if so, submit THAT channel's id, never the name string.
    const byName = !SNOWFLAKE_RE.test(typed) && channels.find(c => c.name === typed)
    const channelId = byName ? byName.id : typed
    setRows([...rows, { channel: channelId, value: 'reserved' }])
    setNewChannel('')
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const posture = {}
      for (const r of rows) {
        if (r.channel.trim()) posture[r.channel.trim()] = r.value
      }
      const { discord } = await adapter.setDiscordConfig({ posture })
      onUpdated(discord)
      const persisted = Object.entries(discord.posture || {}).map(([channel, value]) => ({ channel, value: normStep(value) || value }))
      setRows(persisted)
      setSavedRows(persisted)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Could not save per-channel posture. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">Per-channel posture</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        {labels.posture_description}
      </p>

      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : (
        <>
          <div className="space-y-2 mb-4">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-2 flex-wrap">
                {/* The NAME is content (cream sans, normal case); the id stays the
                    editable, saved value. Same relationship the hidden-people chips
                    use, so the page reads as one system. A channel the fetched list
                    doesn't cover degrades to a quiet "unknown" — never a spinner,
                    never an error, and the row stays fully editable regardless. */}
                <div className="flex-1 min-w-[140px]">
                  <span className={channelById[row.channel]
                    ? "block text-[12px] text-[color:var(--page)] font-[Söhne,sans-serif] mb-1"
                    : "block text-[10px] uppercase tracking-[0.18em] font-light text-[color:var(--page-faint)] font-[JetBrains_Mono,monospace] mb-1"}>
                    {channelById[row.channel]
                      ? `#${channelById[row.channel].name}`
                      : 'unknown'}
                  </span>
                  <input
                    type="text"
                    value={row.channel}
                    onChange={e => updateRow(i, { channel: e.target.value })}
                    placeholder="channel id"
                    className={inputClass}
                  />
                </div>
                <select
                  value={row.value}
                  onChange={e => updateRow(i, { value: e.target.value })}
                  className={inputClass + ' max-w-[160px]'}
                >
                  {STEPS.map(v => (
                    <option key={v} value={v}>{labels[`step_${v}`]}</option>
                  ))}
                </select>
                <button
                  onClick={() => removeRow(i)}
                  className={labelClasses + ' hover:text-[color:var(--gold-text)] transition-colors min-h-[44px] px-2'}
                >
                  Remove
                </button>
              </div>
            ))}
            {rows.length === 0 && (
              <p className={labelClasses + ' normal-case tracking-[0.05em] text-[color:var(--page-faint)] font-[Cormorant_Garamond,serif] italic text-xs'}>
                No overrides. Every channel follows the presence dial.
              </p>
            )}
          </div>

          <div className="flex gap-2 flex-wrap mb-4">
            <input
              type="text"
              value={newChannel}
              onChange={e => setNewChannel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addRow() }}
              placeholder="Add a channel — type a name or paste an id…"
              list="posture-channel-options"
              className={inputClass + ' flex-1 min-w-[200px]'}
            />
            {/* A suggestion list, NOT a <select>: typing `gentl` offers
                gentlemens-lounge, but a pasted id from a room this list doesn't
                cover must still work, so the field stays free text. addRow()
                maps a matched name back to that channel's ID before saving. */}
            <datalist id="posture-channel-options">
              {channels.map(c => (
                <option key={c.id} value={c.name}>
                  {c.category ? `${c.category} · #${c.name}` : `#${c.name}`}
                </option>
              ))}
            </datalist>
            <button onClick={addRow} className={btnSecondary}>Add</button>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save posture'}
            </button>
            <UnsavedNote show={!saving && postureKey(rows) !== postureKey(savedRows)} />
            {saved &&<span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
            {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
          </div>
        </>
      )}
    </section>
  )
}

// ── Extra instructions ──

function ExtraInstructionsSection({ config, loading, loadError, onRetry, onUpdated }) {
  const { adapter } = useHost()
  const labels = useLabels()
  const [text, setText] = useState('')
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (config && !initialized) {
      setText(config.extra_instructions || '')
      setInitialized(true)
    }
  }, [config, initialized])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const { discord } = await adapter.setDiscordConfig({ extra_instructions: text })
      onUpdated(discord)
      setText(discord.extra_instructions ?? text)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Could not save the extra instructions. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">Extra instructions</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        Standing guidance folded into every prompt, read live — no restart needed.
      </p>

      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : (
        <>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={5}
            maxLength={4000}
            placeholder={labels.extra_instructions_placeholder}
            className="w-full bg-[color:var(--ink)] border border-[color:var(--rule-mid)] rounded-md px-3 py-2 text-base text-[color:var(--page)] font-[JetBrains_Mono,monospace] focus:outline-none focus:border-[color:var(--gold-soft)] resize-y transition-colors"
          />
          <div className="flex items-center gap-3 flex-wrap mt-4">
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save instructions'}
            </button>
            {saved && <span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
            {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
          </div>
        </>
      )}
    </section>
  )
}

// ── Name triggers ──

function NameTriggersSection({ config, loading, loadError, onRetry, onUpdated }) {
  const { adapter } = useHost()
  const [chips, setChips] = useState([])
  const [savedChips, setSavedChips] = useState([])
  const [draft, setDraft] = useState('')
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (config && !initialized) {
      setChips(config.name_triggers || [])
      setSavedChips(config.name_triggers || [])
      setInitialized(true)
    }
  }, [config, initialized])

  const addFromDraft = () => {
    const parts = draft.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    if (parts.length === 0) return
    setChips([...new Set([...chips, ...parts])])
    setDraft('')
  }

  const removeChip = word => setChips(chips.filter(c => c !== word))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const { discord } = await adapter.setDiscordConfig({ name_triggers: chips })
      onUpdated(discord)
      // Re-sync from the server's response, not the pre-save local list — the
      // server may sanitize/truncate (e.g. cap at 20) what actually persisted,
      // and "Saved" must reflect what's real, not what was typed.
      setChips(discord.name_triggers || [])
      setSavedChips(discord.name_triggers || [])
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Could not save name triggers. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">Name triggers</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        Words that count as being addressed directly, wherever the presence dial sits.
      </p>

      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {chips.map(word => (
              <span key={word} className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-[0.1em] border border-[color:var(--rule-mid)] text-[color:var(--page-dim)] rounded-md font-[JetBrains_Mono,monospace]">
                {word}
                <button
                  onClick={() => removeChip(word)}
                  className="text-[color:var(--page-faint)] hover:text-[color:var(--gold-text)] transition-colors"
                >
                  ×
                </button>
              </span>
            ))}
            {chips.length === 0 && (
              <span className={labelClasses + ' normal-case tracking-[0.05em] text-[color:var(--page-faint)] font-[Cormorant_Garamond,serif] italic text-xs'}>
                No triggers set.
              </span>
            )}
          </div>

          <div className="flex gap-2 flex-wrap mb-4">
            <input
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addFromDraft() }}
              placeholder="Add name(s), comma-separated…"
              className={inputClass + ' flex-1 min-w-[200px]'}
            />
            <button onClick={addFromDraft} className={btnSecondary}>Add</button>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save triggers'}
            </button>
            <UnsavedNote show={!saving && JSON.stringify(chips) !== JSON.stringify(savedChips)} />
            {saved &&<span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
            {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
          </div>
        </>
      )}
    </section>
  )
}

// ── Keyword filter (memory blocklist) ──
// Restored from the pre-Phase-1 ChannelInstructions page (src/pages/
// ChannelInstructions.jsx, still live at /house/settings/room and
// /house/settings/telegram) — same Supabase column
// (sanctum_channel_instructions.blocklist) and same Sanctum routes
// (GET/PATCH /sanctum/channel-instructions/discord), reused rather than
// reinvented. Unlike the sections above, this is a SEPARATE Sanctum-backed
// resource (not part of the /routine/discord config object), so it manages
// its own load lifecycle rather than reading the `discord` prop.

function BlocklistSection() {
  const { adapter } = useHost()
  const [words, setWords] = useState([])
  const [savedWords, setSavedWords] = useState([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  const fetchBlocklist = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const { blocklist } = await adapter.getChannelBlocklist('discord')
      setWords(blocklist)
      setSavedWords(blocklist)
    } catch {
      // Never breaks the page — the card degrades to an "unavailable" notice
      // with retry, same as every load-error path elsewhere on this page.
      setLoadError('Keyword filter unavailable. Check your connection or session, then retry.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBlocklist()
  }, [fetchBlocklist])

  const addWord = () => {
    const next = addBlocklistWord(words, draft)
    if (next !== words) setWords(next)
    setDraft('')
  }

  const removeWord = word => setWords(removeBlocklistWord(words, word))

  const dirty = JSON.stringify(words) !== JSON.stringify(savedWords)

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const { blocklist } = await adapter.setChannelBlocklist('discord', words)
      setWords(blocklist)
      setSavedWords(blocklist)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Could not save the keyword filter. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">Keyword filter (memory blocklist)</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        Memories containing these words never enter Discord-facing context.
      </p>

      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={fetchBlocklist} />
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {words.map(word => (
              <span key={word} className="flex items-center gap-1.5 px-2 py-1 text-[11px] uppercase tracking-[0.1em] border border-[color:var(--rule-mid)] text-[color:var(--page-dim)] rounded-md font-[JetBrains_Mono,monospace]">
                {word}
                <button
                  onClick={() => removeWord(word)}
                  className="text-[color:var(--page-faint)] hover:text-[color:var(--gold-text)] transition-colors"
                >
                  ×
                </button>
              </span>
            ))}
            {words.length === 0 && (
              <span className={labelClasses + ' normal-case tracking-[0.05em] text-[color:var(--page-faint)] font-[Cormorant_Garamond,serif] italic text-xs'}>
                No blocked words. All memories pass through.
              </span>
            )}
          </div>

          <div className="flex gap-2 flex-wrap mb-4">
            <input
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addWord() }}
              placeholder="Add a word to block…"
              className={inputClass + ' flex-1 min-w-[200px]'}
            />
            <button onClick={addWord} className={btnSecondary}>Add</button>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving || !dirty} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save filter'}
            </button>
            <UnsavedNote show={!saving && dirty} />
            {saved &&<span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
            {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
          </div>
        </>
      )}
    </section>
  )
}

// ── Ignore list ──
// People on this list can't summon him and he never sees what they write —
// distinct from the keyword filter above (which hides certain MEMORIES from
// Discord context) and from name_triggers/posture (which shape how he
// engages): this removes him from the exchange with these specific people
// entirely, before it forms. His own messages in the room are unaffected.
// Reads/writes `ignored_user_ids` on the same /routine/discord config object
// as the sections above (state/save pattern modeled on NameTriggersSection).
// Name resolution is a separate, best-effort call (POST /discord/user-info)
// that never blocks or errors the card — an id that won't resolve just
// renders raw, with a quiet "unknown" note, never a spinner or error state.

const SNOWFLAKE_RE = /^\d{15,21}$/

function IgnoreListSection({ config, loading, loadError, onRetry, onUpdated }) {
  const { adapter } = useHost()
  const labels = useLabels()
  const [ids, setIds] = useState([])
  const [names, setNames] = useState({}) // id -> { name } | undefined (still resolving/unresolved)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState(null)
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  // Best-effort name lookup. Never throws into the caller — a failed or
  // partial resolution just leaves those ids rendering raw with "unknown".
  const resolveNames = useCallback(async idList => {
    if (!idList || idList.length === 0) return
    try {
      const { users } = await adapter.getDiscordUserInfo(idList)
      setNames(prev => {
        const next = { ...prev }
        for (const u of users || []) next[u.id] = { name: u.name }
        return next
      })
    } catch {
      // Swallow — the chip already renders the raw id as a safe fallback.
    }
  }, [])

  useEffect(() => {
    if (config && !initialized) {
      const initial = config.ignored_user_ids || []
      setIds(initial)
      setInitialized(true)
      resolveNames(initial)
    }
  }, [config, initialized, resolveNames])

  const addFromDraft = () => {
    const parts = draft.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length === 0) return
    const invalid = parts.filter(p => !SNOWFLAKE_RE.test(p))
    if (invalid.length > 0) {
      setDraftError(`Not a Discord id (15-21 digits): ${invalid.join(', ')}`)
      return
    }
    setDraftError(null)
    const additions = parts.filter(p => !ids.includes(p))
    if (additions.length === 0) {
      setDraft('')
      return
    }
    resolveNames(additions)
    // Keep what was typed until the server confirms it, so a failed save
    // doesn't also lose the id. An id the server didn't keep stays in the
    // field with an error: "Saved" must never cover a person who isn't hidden.
    persist([...ids, ...additions]).then(persisted => {
      if (!persisted) return
      const dropped = additions.filter(a => !persisted.includes(a))
      if (dropped.length > 0) {
        setDraft(dropped.join(', '))
        setSaved(false)
        setDraftError(`Not hidden: the server did not keep ${dropped.join(', ')}`)
      } else {
        setDraft('')
      }
    })
  }

  const removeId = id => persist(ids.filter(i => i !== id))

  // Every add and remove saves immediately. It used to be Add (local only)
  // then a separate Save click, and a chip that was never saved looked
  // exactly like a working block: the owner hid someone on 28 Sep, never pressed
  // Save, and the bot kept seeing them. A block must never look armed while
  // it isn't, so there is no unsaved state on this card at all.
  // The chips only ever show a list the server returned, never the list we
  // asked for: nothing changes on screen until the save is confirmed.
  const persist = async next => {
    setSaving(true)
    setError(null)
    try {
      const { discord } = await adapter.setDiscordConfig({ ignored_user_ids: next })
      onUpdated(discord)
      // The server may sanitize/dedupe/cap what actually persisted.
      const persisted = discord.ignored_user_ids || []
      setIds(persisted)
      resolveNames(persisted)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      return persisted
    } catch {
      // A failed request may still have committed (the response can be lost
      // after the write), so re-read the server instead of assuming either way.
      setError('Could not confirm the save. Showing what the server holds now; check it and try again.')
      try {
        const { discord } = await adapter.getDiscordConfig()
        const actual = discord.ignored_user_ids || []
        setIds(actual)
        resolveNames(actual)
      } catch {
        setError('Could not reach the server. This list may be out of date. Reload the page before relying on it.')
      }
      return null
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">{labels.ignore_title}</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        {labels.ignore_description}
      </p>

      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5 mb-4">
            {ids.map(id => {
              const info = names[id]
              const resolved = !!(info && info.name)
              return (
                <span key={id} className="flex items-stretch gap-1.5 pl-2 min-h-[44px] border border-[color:var(--rule-mid)] rounded-md">
                  <span className="flex flex-col justify-center py-1.5 leading-tight">
                    <span className={resolved
                      ? "text-[12px] text-[color:var(--page)] font-[Söhne,sans-serif]"
                      : "text-[11px] tracking-[0.1em] text-[color:var(--page-dim)] font-[JetBrains_Mono,monospace]"}>
                      {resolved ? info.name : id}
                    </span>
                    <span className="text-[9px] tracking-[0.05em] text-[color:var(--page-faint)] font-[JetBrains_Mono,monospace] normal-case">
                      {resolved ? id : 'unknown'}
                    </span>
                  </span>
                  {/* The glyph stays small; the TAP TARGET does not. Two chips sit
                      side by side here and a mis-tap un-hides the wrong person —
                      so the button stretches to the chip's full height and carries
                      its own width (>=32x44) rather than the ~24px the bare glyph
                      would give on a phone. */}
                  <button
                    onClick={() => removeId(id)}
                    disabled={saving}
                    aria-label={`Stop hiding ${resolved ? info.name : id}`}
                    className="self-stretch flex items-center justify-center px-1.5 min-w-[32px] text-[color:var(--page-faint)] hover:text-[color:var(--gold-text)] transition-colors"
                  >
                    ×
                  </button>
                </span>
              )
            })}
            {ids.length === 0 && (
              <span className={labelClasses + ' normal-case tracking-[0.05em] text-[color:var(--page-faint)] font-[Cormorant_Garamond,serif] italic text-xs'}>
                No one is hidden.
              </span>
            )}
          </div>

          <div className="flex gap-2 flex-wrap mb-2">
            <input
              type="text"
              value={draft}
              onChange={e => { setDraft(e.target.value); setDraftError(null) }}
              onKeyDown={e => { if (e.key === 'Enter' && !saving) addFromDraft() }}
              disabled={saving}
              placeholder="Add Discord id(s), comma-separated…"
              className={inputClass + ' flex-1 min-w-[200px]'}
            />
            <button onClick={addFromDraft} disabled={saving} className={btnSecondary}>
              {saving ? 'Saving…' : 'Hide'}
            </button>
          </div>
          {draftError && (
            <p className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif] mb-2">{draftError}</p>
          )}

          <div className="flex items-center gap-3 flex-wrap mt-2 min-h-[20px]">
            <span className="text-[10px] uppercase tracking-[0.18em] font-light text-[color:var(--page-faint)] font-[JetBrains_Mono,monospace]">
              Saves instantly
            </span>
            {saved && <span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
            {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
          </div>
        </>
      )}
    </section>
  )
}

// ── Stickers ──

function StickersSection({ config, loading, loadError, onRetry, onUpdated }) {
  const { adapter } = useHost()
  const labels = useLabels()
  const [enabled, setEnabled] = useState(true)
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (config && !initialized) {
      setEnabled(config.stickers_enabled !== false)
      setInitialized(true)
    }
  }, [config, initialized])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const { discord } = await adapter.setDiscordConfig({ stickers_enabled: enabled })
      onUpdated(discord)
      setEnabled(discord.stickers_enabled !== false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Could not save the sticker setting. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">Stickers</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        {labels.stickers_description}
      </p>

      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : (
        <>
          <label className="flex items-center gap-2 cursor-pointer mb-4 min-h-[44px]">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="w-4 h-4" />
            <span className={`text-sm font-[Söhne,sans-serif] ${enabled ? 'text-[color:var(--page)]' : 'text-[color:var(--page-faint)]'}`}>
              Enabled
            </span>
          </label>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save stickers'}
            </button>
            {saved && <span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
            {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
          </div>
        </>
      )}
    </section>
  )
}

// ── Away ──

function utcIsoToLocalDatetimeValue(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// "Wed 14:00–15:30" in the viewer's own zone (or the host's own label when it gives one).
function formatScheduleSlot(next) {
  if (!next) return ''
  if (next.label) return next.label
  const s = new Date(next.start), e = new Date(next.end)
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return ''
  const day = s.toLocaleDateString(undefined, { weekday: 'short' })
  const t = d => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${t(s)}–${t(e)}`
}

function AwaySection({ config, loading, loadError, onRetry, onUpdated, awayStatus, awayStatusLoading, awayStatusError, onRetryAwayStatus }) {
  const { adapter } = useHost()
  const labels = useLabels()
  const [announce, setAnnounce] = useState(true)
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  // Override controls (same behaviour as the House's Routines page)
  const [active, setActive] = useState(false)
  const [reason, setReason] = useState('')
  const [until, setUntil] = useState('')
  // Stored inverted from the wire field (share_reason true = sayable, the default) so the box
  // asks the question: private y/n. The inversion happens once, here at the edge.
  const [reasonPrivate, setReasonPrivate] = useState(false)
  const [savingOverride, setSavingOverride] = useState(false)
  const [savedOverride, setSavedOverride] = useState(false)
  const [overrideError, setOverrideError] = useState(null)

  // Optional: next scheduled away, and the calendar link
  const [schedule, setSchedule] = useState(null)
  const [calendar, setCalendar] = useState(null)
  const [calendarUrl, setCalendarUrl] = useState('')
  const [calendarBusy, setCalendarBusy] = useState(false)
  const [calendarError, setCalendarError] = useState(null)
  const canCalendar = typeof adapter.setAwayCalendar === 'function'

  const applyOverride = o => {
    const ov = o || {}
    setActive(!!ov.active)
    setReason(ov.reason || '')
    setUntil(ov.until ? utcIsoToLocalDatetimeValue(ov.until) : '')
    setReasonPrivate(ov.share_reason === false)
  }

  useEffect(() => {
    if (config && !initialized) {
      setAnnounce(config.away?.announce !== false)
      applyOverride(config.away?.override)
      setInitialized(true)
    }
  }, [config, initialized])

  const loadSchedule = useCallback(async () => {
    if (typeof adapter.getAwaySchedule !== 'function') return
    try { setSchedule(await adapter.getAwaySchedule()) } catch { setSchedule(null) }
  }, [adapter])
  const loadCalendar = useCallback(async () => {
    if (typeof adapter.getAwayCalendar !== 'function') return
    try { setCalendar(await adapter.getAwayCalendar()) } catch { setCalendar(null) }
  }, [adapter])
  useEffect(() => { loadSchedule(); loadCalendar() }, [loadSchedule, loadCalendar])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const { discord } = await adapter.setDiscordConfig({ away: { announce } })
      onUpdated(discord)
      setAnnounce(discord.away?.announce !== false)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Could not save the away setting. Try again.')
    } finally {
      setSaving(false)
    }
  }

  const saveOverride = async () => {
    setSavingOverride(true)
    setOverrideError(null)
    try {
      const untilIso = until ? new Date(until).toISOString() : null
      const { discord } = await adapter.setAwayOverride({ active, reason: reason.trim(), until: untilIso, shareReason: !reasonPrivate })
      onUpdated(discord)
      applyOverride(discord.away?.override)
      setSavedOverride(true)
      setTimeout(() => setSavedOverride(false), 2000)
    } catch {
      setOverrideError(labels.away_override_error)
    } finally {
      setSavingOverride(false)
    }
  }

  const changeCalendar = async url => {
    setCalendarBusy(true)
    setCalendarError(null)
    try {
      const next = await adapter.setAwayCalendar(url)
      setCalendar(next)
      setCalendarUrl('')
      loadSchedule()
      onUpdated(undefined)
    } catch {
      setCalendarError(labels.away_calendar_error)
    } finally {
      setCalendarBusy(false)
    }
  }

  const slot = formatScheduleSlot(schedule?.next)
  const link = labels.schedule_link && labels.schedule_link.href ? labels.schedule_link : null

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">Away</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        {labels.away_description}
      </p>

      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : (
        <>
          <label className="flex items-center gap-2 cursor-pointer mb-4 min-h-[44px]">
            <input type="checkbox" checked={announce} onChange={e => setAnnounce(e.target.checked)} className="w-4 h-4" />
            <span className={`text-sm font-[Söhne,sans-serif] ${announce ? 'text-[color:var(--page)]' : 'text-[color:var(--page-faint)]'}`}>
              Announce when away
            </span>
          </label>

          <div className="flex items-center gap-3 flex-wrap mb-6">
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save away setting'}
            </button>
            {saved && <span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
            {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
          </div>

          <div className="border-t border-[color:var(--rule-dim)] pt-4 mb-4">
            <label className="flex items-center gap-2 cursor-pointer mb-4 min-h-[44px]">
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="w-4 h-4" />
              <span className={`text-sm font-[Söhne,sans-serif] ${active ? 'text-[color:var(--page)]' : 'text-[color:var(--page-faint)]'}`}>
                {labels.away_active_label}
              </span>
            </label>

            <div className="flex gap-4 mb-4 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <label className={labelClasses + ' block mb-1.5'}>{labels.away_reason_label}</label>
                <input
                  type="text"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  maxLength={1000}
                  placeholder={labels.away_reason_placeholder}
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClasses + ' block mb-1.5'}>{labels.away_until_label}</label>
                <input type="datetime-local" value={until} onChange={e => setUntil(e.target.value)} className={inputClass} />
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
              <input type="checkbox" checked={reasonPrivate} onChange={e => setReasonPrivate(e.target.checked)} className="w-4 h-4" />
              <span className={`text-sm font-[Söhne,sans-serif] ${reasonPrivate ? 'text-[color:var(--page)]' : 'text-[color:var(--page-faint)]'}`}>
                {labels.away_private_label}
              </span>
            </label>
            <p className="text-xs font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mb-4 ml-6">
              {reasonPrivate ? labels.away_private_on : labels.away_private_off}
            </p>

            <div className="flex items-center gap-3 flex-wrap">
              <button onClick={saveOverride} disabled={savingOverride} className={btnPrimary}>
                {savingOverride ? 'Saving…' : labels.away_override_save}
              </button>
              {savedOverride && <span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
              {overrideError && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{overrideError}</span>}
            </div>
          </div>

          {canCalendar && (
            <div className="border-t border-[color:var(--rule-dim)] pt-4 mb-4">
              <span className={labelClasses}>{labels.away_calendar_label}</span>
              {calendar?.linked ? (
                <div className="mt-2 flex items-center gap-3 flex-wrap">
                  <p className="text-sm font-[Söhne,sans-serif] text-[color:var(--page)]">
                    {labels.away_calendar_linked}{calendar.host ? ` (${calendar.host})` : ''}
                  </p>
                  {calendar.unreachable && (
                    <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{labels.away_calendar_unreachable}</span>
                  )}
                  <button onClick={() => changeCalendar(null)} disabled={calendarBusy} className={btnSecondary + ' !px-3 !py-1'}>
                    {labels.away_calendar_unlink}
                  </button>
                </div>
              ) : (
                <div className="mt-2 flex gap-3 flex-wrap items-start">
                  <div className="flex-1 min-w-[200px]">
                    <input
                      type="password"
                      autoComplete="off"
                      value={calendarUrl}
                      onChange={e => setCalendarUrl(e.target.value)}
                      maxLength={2000}
                      placeholder={labels.away_calendar_placeholder}
                      className={inputClass}
                    />
                  </div>
                  <button onClick={() => changeCalendar(calendarUrl.trim())} disabled={calendarBusy || !calendarUrl.trim()} className={btnPrimary}>
                    {labels.away_calendar_link}
                  </button>
                </div>
              )}
              {calendarError && <p className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif] mt-2">{calendarError}</p>}
              <p className="text-xs font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-2">
                {labels.away_calendar_help}
              </p>
            </div>
          )}

          {slot && (
            <p className="text-sm font-[Cormorant_Garamond,serif] text-[color:var(--page-dim)] font-light mb-4">
              {labels.away_schedule_prefix} {slot}
              {link && <> · <a href={link.href} target="_blank" rel="noopener noreferrer" className="underline text-[color:var(--gold-text)]">{link.text}</a></>}
            </p>
          )}

          <div className="border-t border-[color:var(--rule-dim)] pt-3">
            <span className={labelClasses}>Right now</span>
            {awayStatusError ? (
              <div className="mt-1 flex items-center gap-3 flex-wrap">
                <p className="text-sm font-[Cormorant_Garamond,serif] text-[color:var(--gold-text)] font-light">
                  Could not check status.
                </p>
                <button onClick={onRetryAwayStatus} className={btnSecondary + ' !px-3 !py-1'}>Retry</button>
              </div>
            ) : (
              <p className="text-sm font-[Cormorant_Garamond,serif] text-[color:var(--page-dim)] font-light mt-1">
                {awayStatusLoading
                  ? 'Checking…'
                  : awayStatus?.away
                  // Honour the privacy flag HERE too. Without it this preview
                  // shows the reason while the guest reply withholds it — she
                  // ticks "keep private", sees her note still listed as what
                  // guests hear, and concludes the box does nothing. A preview
                  // that contradicts the behaviour is worse than no preview.
                  ? `${awayStatus.status || 'away'}${awayStatus.reason && awayStatus.reason_shareable !== false ? ` — ${awayStatus.reason}` : ''}${awayStatus.reason && awayStatus.reason_shareable === false ? ' (reason kept private)' : ''}${awayStatus.until_label ? ` · back around ${awayStatus.until_label}` : ''}${awayStatus.source === 'calendar' ? ` · ${labels.away_from_calendar}` : ''}`
                  : 'Not away.'}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}

// ── Curfew (mirrored from Routines.jsx) ──

function CurfewSection({ curfew, loading, loadError, onRetry, onUpdated }) {
  const { adapter } = useHost()
  const labels = useLabels()
  const [enabled, setEnabled] = useState(false)
  const [start, setStart] = useState('23:00')
  const [end, setEnd] = useState('06:00')
  const [initialized, setInitialized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (curfew && !initialized) {
      setEnabled(!!curfew.enabled)
      setStart(curfew.start || '23:00')
      setEnd(curfew.end || '06:00')
      setInitialized(true)
    }
  }, [curfew, initialized])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const { curfew: updated } = await adapter.setCurfew({ enabled, start, end })
      onUpdated(updated)
      setEnabled(!!updated.enabled)
      setStart(updated.start || start)
      setEnd(updated.end || end)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch {
      setError('Could not save the curfew. Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">Curfew</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        {labels.curfew_description}
      </p>

      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : (
        <>
          <label className="flex items-center gap-2 cursor-pointer mb-4 min-h-[44px]">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="w-4 h-4" />
            <span className={`text-sm font-[Söhne,sans-serif] ${enabled ? 'text-[color:var(--page)]' : 'text-[color:var(--page-faint)]'}`}>
              Enabled
            </span>
          </label>

          <div className="flex gap-4 mb-4 flex-wrap">
            <div>
              <label className={labelClasses + ' block mb-1.5'}>Start</label>
              <input type="time" value={start} onChange={e => setStart(e.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClasses + ' block mb-1.5'}>End</label>
              <input type="time" value={end} onChange={e => setEnd(e.target.value)} className={inputClass} />
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? 'Saving…' : 'Save curfew'}
            </button>
            {saved && <span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
            {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
          </div>
        </>
      )}
    </section>
  )
}

// ── Current persona (read-only, Phase 1) ──

// ── Persona + change history ──
// Shown only when the host's adapter offers getPersona (the public bot does; the House host does not).
// Editable when the persona is held in the bot's settings; read-only ("set by your core") when it comes
// from a file or a service. The extra instructions are always editable. Every change is listed below
// with who made it, when, and what it replaced, with one-click undo.

const HISTORY_SHORT = 40
const shortText = (t) => {
  const one = String(t ?? '').replace(/\s+/g, ' ').trim()
  return one.length > HISTORY_SHORT ? one.slice(0, HISTORY_SHORT) + '…' : one
}

function PersonaSection() {
  const { adapter } = useHost()
  const labels = useLabels()
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [fields, setFields] = useState({ text: '', name: '', voice: '', instructions: '' })
  const [history, setHistory] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const [undoError, setUndoError] = useState(null)

  const apply = (d) => {
    setData(d)
    setFields({ text: d.persona?.text || '', name: d.persona?.name || '', voice: d.persona?.voice || '', instructions: d.instructions || '' })
  }
  const loadHistory = useCallback(async () => {
    if (typeof adapter.getSettingsHistory !== 'function') return
    try { setHistory((await adapter.getSettingsHistory()).history || []) } catch { setHistory(null) }
  }, [adapter])
  const load = useCallback(async () => {
    setLoadError(null)
    try { apply(await adapter.getPersona()) } catch { setLoadError(labels.persona_load_error) }
    loadHistory()
  }, [adapter, loadHistory, labels.persona_load_error])
  useEffect(() => { load() }, [load])

  const editable = !!data?.editable
  const canSetPersona = typeof adapter.setPersona === 'function'
  const save = async () => {
    // Send only what changed, so an untouched field is never rewritten.
    const patch = {}
    if (editable) for (const k of ['text', 'name', 'voice']) if (fields[k] !== (data.persona?.[k] || '')) patch[k] = fields[k]
    if (fields.instructions !== (data.instructions || '')) patch.instructions = fields.instructions
    if (Object.keys(patch).length === 0) return
    setSaving(true); setError(null)
    try {
      apply(await adapter.setPersona(patch))
      setSaved(true); setTimeout(() => setSaved(false), 2000)
      loadHistory()
    } catch { setError(labels.persona_error) } finally { setSaving(false) }
  }
  const undo = async (id) => {
    setUndoError(null)
    try { await adapter.undoSettingsChange(id); await load() } catch { setUndoError(labels.history_undo_error) }
  }
  const set = (k) => (e) => setFields((f) => ({ ...f, [k]: e.target.value }))
  const heading = "text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]"
  const help = "text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4"
  const area = "w-full bg-[color:var(--ink)] border border-[color:var(--rule-mid)] rounded-md px-3 py-2 text-base text-[color:var(--page)] font-[JetBrains_Mono,monospace] focus:outline-none focus:border-[color:var(--gold-soft)] resize-y transition-colors"

  return (
    <>
      <section className={cardClasses}>
        <h3 className={heading}>{labels.persona_title}</h3>
        <p className={help}>{labels.persona_description}</p>
        {loadError ? (
          <LoadErrorNotice message={loadError} onRetry={load} />
        ) : !data ? (
          <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
        ) : (
          <div className="space-y-4">
            {editable ? (
              <>
                <div>
                  <label className={labelClasses}>{labels.persona_name_label}</label>
                  <input value={fields.name} onChange={set('name')} maxLength={80} className={inputClass + ' mt-1'} />
                </div>
                <div>
                  <label className={labelClasses}>{labels.persona_text_label}</label>
                  <textarea value={fields.text} onChange={set('text')} rows={6} maxLength={8000} className={area + ' mt-1'} />
                </div>
                <div>
                  <label className={labelClasses}>{labels.persona_voice_label}</label>
                  <textarea value={fields.voice} onChange={set('voice')} rows={3} maxLength={2000} className={area + ' mt-1'} />
                </div>
              </>
            ) : (
              <div>
                <p className="text-sm text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{labels.persona_core_note}</p>
                <textarea value={data.text_in_use || ''} readOnly rows={6} className={area + ' mt-2 opacity-80'} />
              </div>
            )}
            <div>
              <label className={labelClasses}>{labels.persona_instructions_label}</label>
              <p className="text-xs text-[color:var(--page-dim)] font-[Söhne,sans-serif] mt-1">{labels.persona_instructions_help}</p>
              <textarea value={fields.instructions} onChange={set('instructions')} rows={4} maxLength={4000} placeholder={labels.extra_instructions_placeholder} className={area + ' mt-1'} />
            </div>
            {canSetPersona && (
              <div className="flex items-center gap-3 flex-wrap">
                <button onClick={save} disabled={saving} className={btnPrimary}>{saving ? 'Saving…' : labels.persona_save}</button>
                {saved && <span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">{labels.persona_saved}</span>}
                {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
              </div>
            )}
          </div>
        )}
      </section>
      {history && (
        <section className={cardClasses}>
          <h3 className={heading}>{labels.history_title}</h3>
          <p className={help}>{labels.history_description}</p>
          {undoError && <p className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif] mb-2">{undoError}</p>}
          {history.length === 0 ? (
            <p className="text-sm text-[color:var(--page-dim)] font-[Söhne,sans-serif]">{labels.history_empty}</p>
          ) : (
            <ul className="space-y-3">
              {history.map((h) => (
                <li key={h.id} className="flex items-start justify-between gap-3 border-t border-[color:var(--rule-mid)] pt-3 first:border-t-0 first:pt-0">
                  <div className="min-w-0">
                    <p className={labelClasses}>
                      {h.by === 'agent' ? labels.history_by_agent : labels.history_by_owner} · {new Date(h.at).toLocaleString()} · {labels['history_field_' + h.field.replace('.', '_')] || h.field}
                    </p>
                    <p className="text-sm text-[color:var(--page)] font-[Söhne,sans-serif] break-words mt-1">
                      {shortText(h.before) || '—'} {'→'} {shortText(h.after) || '—'}
                    </p>
                  </div>
                  <button onClick={() => undo(h.id)} className={btnSecondary}>{labels.history_undo}</button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  )
}

function PersonaNoteSection() {
  const labels = useLabels()
  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">Current persona</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1">
        {labels.persona_note}{' '}
        <code className="text-xs text-[color:var(--gold-text)] font-[JetBrains_Mono,monospace]">{labels.persona_path}</code>.
      </p>
    </section>
  )
}

// ── Agent ──
// Shown only when the adapter offers getAgentStatus (the House host does not).

function agoText(iso, nowMs) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return ''
  const mins = Math.max(0, Math.round((nowMs - t) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

function AgentSection() {
  const { adapter } = useHost()
  const labels = useLabels()
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try { setStatus(await adapter.getAgentStatus()); setError(null) } catch { setError(labels.agent_status_error) }
  }, [adapter, labels])
  useEffect(() => {
    load()
    const timer = setInterval(load, 30000)
    return () => clearInterval(timer)
  }, [load])

  const toggle = async enabled => {
    setBusy(true)
    setError(null)
    try { setStatus(await adapter.setAgentEnabled(enabled)) } catch { setError(labels.agent_status_error) } finally { setBusy(false) }
  }

  let line = ''
  if (status) {
    if (!status.enabled) line = labels.agent_status_off
    else if (status.connected) line = `${labels.agent_status_connected} · last seen ${agoText(status.last_seen, Date.now())}`
    else line = labels.agent_status_not_connected
  }

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">{labels.agent_title}</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        {labels.agent_help}
      </p>
      <label className="flex items-center gap-2 cursor-pointer mb-2 min-h-[44px]">
        <input type="checkbox" checked={!!status?.enabled} disabled={!status || busy} onChange={e => toggle(e.target.checked)} className="w-4 h-4" />
        <span className={`text-sm font-[Söhne,sans-serif] ${status?.enabled ? 'text-[color:var(--page)]' : 'text-[color:var(--page-faint)]'}`}>
          {labels.agent_enabled_label}
        </span>
      </label>
      {line && <p className="text-xs text-[color:var(--page-dim)] font-[JetBrains_Mono,monospace]">{line}</p>}
      {error && <p className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif] mt-1">{error}</p>}
    </section>
  )
}

// ── Servers ──
// One card per server the bot is in. "How much the bot talks here" (Same as the main dial, or one of
// the six steps) sits on the card with its meaning; Details holds what it remembers, the rules and the
// channels. One Save per server sends only what changed. A channel's step still lives in the `posture`
// map, keyed by channel id, so it saves through the same setDiscordConfig call.

const selectClass = inputClass + ' max-w-[260px]'
/** A stored posture map with old words read as steps, so the page only ever shows the six. */
const normaliseMap = (m) => Object.fromEntries(Object.entries(m || {}).map(([id, v]) => [id, normStep(v) || v]))

/** The server's own step, or the main dial's when it follows it. */
const serverStepOf = (form, houseStep) => form.step || houseStep

function ChannelPostureList({ serverId, posture, serverStep, onChange }) {
  const { adapter } = useHost()
  const labels = useLabels()
  const [channels, setChannels] = useState(null) // null = loading
  const [failed, setFailed] = useState(false)
  const [collapsed, setCollapsed] = useState({})

  useEffect(() => {
    let cancelled = false
    Promise.resolve(adapter.getDiscordChannels(serverId))
      .then(res => { if (!cancelled) setChannels((res && res.channels) || []) })
      .catch(() => { if (!cancelled) { setFailed(true); setChannels([]) } })
    return () => { cancelled = true }
  }, [serverId])

  const groups = useMemo(() => groupChannels(channels || [], labels.server_uncategorized), [channels, labels.server_uncategorized])

  return (
    <div>
      <p className={labelClasses + ' mb-2'}>{labels.server_channels_title}</p>
      <p className="text-xs text-[color:var(--page-faint)] font-[Cormorant_Garamond,serif] italic mb-2">{labels.server_channels_note}</p>
      {channels === null ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">{labels.server_channels_loading}</p>
      ) : failed ? (
        <p className="text-sm text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{labels.server_channels_error}</p>
      ) : groups.length === 0 ? (
        <p className="text-xs text-[color:var(--page-faint)] font-[Cormorant_Garamond,serif] italic">{labels.server_channels_empty}</p>
      ) : (
        <div className="space-y-3">
          {groups.map(g => {
            const open = !collapsed[g.name]
            return (
              <div key={g.name} data-category={g.name}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setCollapsed({ ...collapsed, [g.name]: open })}
                  className={labelClasses + ' hover:text-[color:var(--gold-text)] transition-colors min-h-[44px] flex items-center gap-2'}
                >
                  <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                  {g.name}
                </button>
                {open && (
                  <div className="space-y-2 mt-1">
                    {g.channels.map(c => (
                      <div key={c.id} className="flex items-center gap-2 flex-wrap justify-between">
                        <span className="text-[13px] text-[color:var(--page)] font-[Söhne,sans-serif] flex-1 min-w-[140px]">#{c.name}</span>
                        <select
                          aria-label={`Step for ${c.name}`}
                          value={normStep(posture[c.id]) || ''}
                          onChange={e => onChange(c.id, e.target.value)}
                          className={inputClass + ' sm:w-auto sm:min-w-[280px] max-w-full'}
                        >
                          <option value="">{`${labels.channel_step_default} (${labels[`step_${normStep(c.default_step) || serverStep}`]})`}</option>
                          {STEPS.map(st => <option key={st} value={st}>{labels[`step_${st}`]}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ServerCard({ server, config, onUpdated }) {
  const houseStep = houseStepOf(config)
  const { adapter } = useHost()
  const labels = useLabels()
  const live = (config.servers && config.servers[server.id]) || null
  const [saved, setSaved] = useState(() => ({
    server: effectiveServer(server.defaults, live),
    posture: normaliseMap(config.posture),
  }))
  const [form, setForm] = useState(saved.server)
  const [posture, setPosture] = useState(saved.posture)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [error, setError] = useState(null)

  const patch = diffServer(saved.server, form)
  // Only the channels this card changed; the map itself is shared by every server, so a save
  // applies these edits on top of the latest saved map rather than sending a stale copy.
  const postureEdits = Object.entries(posture).filter(([id, v]) => (v || '') !== (saved.posture[id] || ''))
  const postureChanged = postureEdits.length > 0
  const dirty = !!patch || postureChanged

  const setRule = (k, v) => setForm({ ...form, rules: { ...form.rules, [k]: v } })

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const body = {}
      if (patch) body.servers = { [server.id]: patch }
      if (postureChanged) {
        const next = { ...(config.posture || {}) }
        for (const [id, v] of postureEdits) { if (v) next[id] = v; else delete next[id] }
        body.posture = next
      }
      const { discord } = await adapter.setDiscordConfig(body)
      onUpdated(discord)
      const persisted = {
        server: effectiveServer(server.defaults, (discord.servers && discord.servers[server.id]) || null),
        posture: normaliseMap(discord.posture),
      }
      setSaved(persisted)
      setForm(persisted.server)
      setPosture(persisted.posture)
      setJustSaved(true)
      setTimeout(() => setJustSaved(false), 2000)
    } catch {
      setError(labels.server_save_error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="border border-[color:var(--rule-mid)] rounded-md p-4" data-server={server.id}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h4 className="text-lg font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] break-words">{server.name || server.id}</h4>
          <p className="text-[11px] text-[color:var(--page-faint)] font-[JetBrains_Mono,monospace]">
            {Number.isFinite(server.channel_count) ? `${server.channel_count} channels` : server.id}
          </p>
        </div>
      </div>
      <div className="mt-3">
        <label className={labelClasses + ' block mb-1.5'}>{labels.server_step_label}</label>
        <select
          aria-label={labels.server_step_label}
          value={form.step || ''}
          onChange={e => setForm({ ...form, step: e.target.value === '' ? null : e.target.value })}
          className={selectClass}
        >
          <option value="">{`${labels.server_step_default} (${labels[`step_${houseStep}`]})`}</option>
          {STEPS.map(st => <option key={st} value={st}>{labels[`step_${st}`]}</option>)}
        </select>
        <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-2" data-step-meaning>
          {labels[`step_${serverStepOf(form, houseStep)}_hint`]}
        </p>
      </div>

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={btnSecondary + ' mt-3 min-h-[44px]'}
      >
        {labels.server_details}
      </button>

      {open && (
        <div className="mt-4 space-y-5">
          <div>
            <label className={labelClasses + ' block mb-1.5'}>{labels.server_memory_label}</label>
            <select
              aria-label={labels.server_memory_label}
              value={form.context_log || ''}
              onChange={e => setForm({ ...form, context_log: e.target.value === '' ? null : e.target.value })}
              className={selectClass}
            >
              <option value="">{labels.server_memory_default}</option>
              {SERVER_MEMORY_VALUES.map(v => (
                <option key={v} value={v}>{v === 'off' ? 'Off' : v === 'mentions_only' ? 'Mentions only' : v === 'this_server' ? labels.server_memory_this : 'All'}</option>
              ))}
            </select>
            <p className="text-xs text-[color:var(--page-faint)] font-[Cormorant_Garamond,serif] italic mt-1.5">{labels.server_memory_note}</p>
          </div>

          <div>
            <label className={labelClasses + ' block mb-1.5'}>{labels.server_stickers_label}</label>
            <select
              aria-label={labels.server_stickers_label}
              value={form.stickers === true ? 'on' : form.stickers === false ? 'off' : ''}
              onChange={e => setForm({ ...form, stickers: e.target.value === 'on' ? true : e.target.value === 'off' ? false : null })}
              className={selectClass}
            >
              <option value="">{labels.server_stickers_default}</option>
              <option value="on">{labels.server_stickers_on}</option>
              <option value="off">{labels.server_stickers_off}</option>
            </select>
            <p className="text-xs text-[color:var(--page-faint)] font-[Cormorant_Garamond,serif] italic mt-1.5">{labels.server_stickers_description}</p>
          </div>

          <div>
            <p className={labelClasses + ' mb-2'}>{labels.server_rules_title}</p>
            <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
              <input type="checkbox" checked={!!form.rules.curfew} onChange={e => setRule('curfew', e.target.checked)} className="w-4 h-4" />
              <span className="text-sm font-[Söhne,sans-serif] text-[color:var(--page)]">{labels.server_rule_curfew}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
              <input type="checkbox" checked={!!form.rules.flag} onChange={e => setRule('flag', e.target.checked)} className="w-4 h-4" />
              <span className="text-sm font-[Söhne,sans-serif] text-[color:var(--page)]">{labels.server_rule_flag}</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer min-h-[44px]">
              <input type="checkbox" checked={!!form.rules.copy_to_owner} onChange={e => setRule('copy_to_owner', e.target.checked)} className="w-4 h-4" />
              <span className="text-sm font-[Söhne,sans-serif] text-[color:var(--page)]">{labels.server_rule_copy}</span>
            </label>
            <label className={labelClasses + ' block mb-1.5 mt-3'}>{labels.server_rule_away_label}</label>
            <select
              aria-label={labels.server_rule_away_label}
              value={form.rules.away}
              onChange={e => setRule('away', e.target.value)}
              className={selectClass}
            >
              {AWAY_RULES.map(a => <option key={a} value={a}>{labels[`server_away_${a}`]}</option>)}
            </select>
          </div>

          <ChannelPostureList
            serverId={server.id}
            posture={posture}
            serverStep={serverStepOf(form, houseStep)}
            onChange={(id, v) => setPosture({ ...posture, [id]: v })}
          />
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap mt-4">
        <button onClick={save} disabled={saving || !dirty} className={btnPrimary}>
          {saving ? 'Saving…' : labels.server_save}
        </button>
        <UnsavedNote show={!saving && dirty} />
        {justSaved && <span className="text-xs text-[color:var(--blue)] font-[JetBrains_Mono,monospace]">Saved</span>}
        {error && <span className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif]">{error}</span>}
      </div>
    </div>
  )
}

function ServersSection({ config, loading, loadError, onRetry, onUpdated }) {
  const { adapter } = useHost()
  const labels = useLabels()
  const [servers, setServers] = useState(null) // null = loading
  const [listError, setListError] = useState(false)

  const fetchServers = useCallback(async () => {
    setListError(false)
    try {
      const res = await adapter.getDiscordServers()
      setServers((res && res.servers) || [])
    } catch {
      setListError(true)
      setServers([])
    }
  }, [])
  useEffect(() => { fetchServers() }, [fetchServers])

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">{labels.servers_title}</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        {labels.servers_description}
      </p>
      {loading || servers === null ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : listError ? (
        <LoadErrorNotice message={labels.servers_error} onRetry={() => { setServers(null); fetchServers() }} />
      ) : servers.length === 0 ? (
        <p className="text-xs text-[color:var(--page-faint)] font-[Cormorant_Garamond,serif] italic">{labels.servers_empty}</p>
      ) : (
        <div className="space-y-4">
          {servers.map(s => <ServerCard key={s.id} server={s} config={config} onUpdated={onUpdated} />)}
        </div>
      )}
    </section>
  )
}

// ── Scene flag / focus mode ──
// Status of the flag, and the buttons that raise it for a while or lower it. The flag itself is
// held by the host; this section only reads `scene` and `scene_sightings` from the config and
// sends { scene } back.

function SceneSection({ config, loading, loadError, onRetry, onUpdated }) {
  const { adapter } = useHost()
  const labels = useLabels()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const scene = (config && config.scene) || null
  const up = !!(scene && scene.active && (!scene.until || Date.parse(scene.until) > Date.now()))
  const sightings = config && Array.isArray(config.scene_sightings) ? config.scene_sightings : (config && config.scene_sighting ? [config.scene_sighting] : [])
  const caught = up && sightings.some(s => s && s.raised_at === scene.raised_at && s.caught === true)

  const send = async (change) => {
    setBusy(true)
    setError(null)
    try {
      const { discord } = await adapter.setDiscordConfig({ scene: change })
      onUpdated(discord)
    } catch {
      setError(labels.focus_error)
    } finally {
      setBusy(false)
    }
  }
  const raise = (hours) => send({ active: true, raised_by: 'dashboard', until_hours: hours })

  return (
    <section className={cardClasses}>
      <h3 className="text-xl font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em]">{labels.focus_title}</h3>
      <p className="text-sm font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.5] mt-1 mb-4">
        {labels.focus_description}
      </p>
      {loading ? (
        <p className="text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] italic text-sm">Loading…</p>
      ) : loadError ? (
        <LoadErrorNotice message={loadError} onRetry={onRetry} />
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mb-4 text-sm font-[Söhne,sans-serif]">
            <dt className={labelClasses}>Status</dt>
            <dd className={up ? 'text-[color:var(--gold-text)]' : 'text-[color:var(--page-dim)]'}>{up ? labels.focus_status_up : labels.focus_status_down}</dd>
            {up && scene.until && (<>
              <dt className={labelClasses}>{labels.focus_until}</dt>
              <dd className="text-[color:var(--page)]">{new Date(scene.until).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</dd>
            </>)}
            {up && scene.raised_by && (<>
              <dt className={labelClasses}>{labels.focus_raised_by}</dt>
              <dd className="text-[color:var(--page)]">{scene.raised_by}</dd>
            </>)}
            {up && (<>
              <dt className={labelClasses}>{labels.focus_caught}</dt>
              <dd className="text-[color:var(--page)]">{caught ? labels.focus_caught_yes : labels.focus_caught_no}</dd>
            </>)}
          </dl>

          <div className="flex items-center gap-2 flex-wrap">
            <span className={labelClasses}>{labels.focus_turn_on}</span>
            <button onClick={() => raise(0.5)} disabled={busy} className={btnSecondary}>30m</button>
            <button onClick={() => raise(1)} disabled={busy} className={btnSecondary}>1h</button>
            <button onClick={() => raise(2)} disabled={busy} className={btnSecondary}>2h</button>
            <button onClick={() => raise(hoursUntilMorning())} disabled={busy} className={btnSecondary}>{labels.focus_until_morning}</button>
            <button onClick={() => send({ active: false })} disabled={busy || !up} className={btnPrimary}>{labels.focus_turn_off}</button>
          </div>
          {error && <p className="text-xs text-[color:var(--gold-text)] font-[Söhne,sans-serif] mt-3">{error}</p>}
        </>
      )}
    </section>
  )
}

// ── Main page ──

export default function DiscordSettings() {
  const { adapter } = useHost()
  const labels = useLabels()
  const caps = useHost().capabilities
  // The Servers and focus sections need an adapter that can list servers; older adapters keep the flat posture list.
  const hasServers = typeof adapter.getDiscordServers === 'function'
  // The Persona and history sections need an adapter that offers getPersona; the House host does not, and keeps its persona note.
  const hasPersona = typeof adapter.getPersona === 'function'
  const [discord, setDiscord] = useState(null)
  const [discordLoading, setDiscordLoading] = useState(true)
  const [discordError, setDiscordError] = useState(null)
  const [curfew, setCurfewState] = useState(null)
  const [curfewLoading, setCurfewLoading] = useState(true)
  const [curfewError, setCurfewError] = useState(null)
  const [awayStatus, setAwayStatus] = useState(null)
  const [awayStatusLoading, setAwayStatusLoading] = useState(true)
  const [awayStatusError, setAwayStatusError] = useState(null)

  // On a failed fetch, do NOT fall back to hardcoded defaults — that would
  // silently leave Save enabled over stale placeholder values a transient
  // error or expired session could then persist over the real config.
  // Instead surface a load error + retry and keep `discord`/`curfew` null,
  // which keeps every section's editable UI unmounted (see loadError below).
  const fetchDiscord = useCallback(async () => {
    setDiscordLoading(true)
    setDiscordError(null)
    try {
      const { discord: data } = await adapter.getDiscordConfig()
      setDiscord(data)
    } catch {
      setDiscordError('Could not load Discord settings. Check your connection or session, then retry.')
    } finally {
      setDiscordLoading(false)
    }
  }, [])

  const fetchCurfew = useCallback(async () => {
    setCurfewLoading(true)
    setCurfewError(null)
    try {
      const { curfew: data } = await adapter.getCurfew()
      setCurfewState(data)
    } catch {
      setCurfewError('Could not load curfew settings. Check your connection or session, then retry.')
    } finally {
      setCurfewLoading(false)
    }
  }, [])

  const fetchAwayStatus = useCallback(async () => {
    setAwayStatusLoading(true)
    setAwayStatusError(null)
    try {
      const status = await adapter.getAwayStatus()
      setAwayStatus(status)
    } catch {
      // Do NOT coerce a failed check into "not away" — a transient outage or
      // expired session would then silently misreport the bot as available
      // even when an override/curfew/event is actually active. Surface an
      // explicit error state with retry instead.
      setAwayStatus(null)
      setAwayStatusError('Could not check away status.')
    } finally {
      setAwayStatusLoading(false)
    }
  }, [])

  const onAwayUpdated = discordConfig => {
    if (discordConfig) setDiscord(discordConfig)
    fetchAwayStatus()
  }

  // Curfew directly affects away-status resolution (it's one of the
  // resolver's inputs), so a curfew save must refresh it too — same as
  // every other mutation path here (config changes, the override itself).
  const onCurfewUpdated = updatedCurfew => {
    setCurfewState(updatedCurfew)
    fetchAwayStatus()
  }

  useEffect(() => {
    fetchDiscord()
    fetchCurfew()
    fetchAwayStatus()
  }, [fetchDiscord, fetchCurfew, fetchAwayStatus])

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div>
        <h2 className="text-[clamp(1.7rem,5.5vw,3.4rem)] font-[Cormorant_Garamond,serif] font-normal text-[color:var(--page)] tracking-[-0.01em] leading-none">
          {labels.page_title}
        </h2>
        <p className="text-[1.1rem] font-light text-[color:var(--page-dim)] font-[Cormorant_Garamond,serif] leading-[1.55] mt-3">
          {labels.page_description}
        </p>
      </div>

      <PresenceDialSection config={discord} loading={discordLoading} loadError={discordError} onRetry={fetchDiscord} onUpdated={setDiscord} />
      <ContextLogSection config={discord} loading={discordLoading} loadError={discordError} onRetry={fetchDiscord} onUpdated={setDiscord} />
      {caps.sweep_minutes && <CadenceSection config={discord} loading={discordLoading} loadError={discordError} onRetry={fetchDiscord} onUpdated={setDiscord} />}
      {hasServers
        ? <ServersSection config={discord} loading={discordLoading} loadError={discordError} onRetry={fetchDiscord} onUpdated={setDiscord} />
        : <PostureSection config={discord} loading={discordLoading} loadError={discordError} onRetry={fetchDiscord} onUpdated={setDiscord} />}
      {hasServers && <SceneSection config={discord} loading={discordLoading} loadError={discordError} onRetry={fetchDiscord} onUpdated={setDiscord} />}
      {caps.extra_instructions && <ExtraInstructionsSection config={discord} loading={discordLoading} loadError={discordError} onRetry={fetchDiscord} onUpdated={setDiscord} />}
      {caps.name_triggers && <NameTriggersSection config={discord} loading={discordLoading} loadError={discordError} onRetry={fetchDiscord} onUpdated={setDiscord} />}
      <BlocklistSection />
      <IgnoreListSection config={discord} loading={discordLoading} loadError={discordError} onRetry={fetchDiscord} onUpdated={setDiscord} />
      {caps.stickers_enabled && <StickersSection config={discord} loading={discordLoading} loadError={discordError} onRetry={fetchDiscord} onUpdated={setDiscord} />}
      <AwaySection
        config={discord}
        loading={discordLoading}
        loadError={discordError}
        onRetry={fetchDiscord}
        onUpdated={onAwayUpdated}
        awayStatus={awayStatus}
        awayStatusLoading={awayStatusLoading}
        awayStatusError={awayStatusError}
        onRetryAwayStatus={fetchAwayStatus}
      />
      <CurfewSection curfew={curfew} loading={curfewLoading} loadError={curfewError} onRetry={fetchCurfew} onUpdated={onCurfewUpdated} />
      {typeof adapter.getAgentStatus === 'function' && <AgentSection />}
      {hasPersona ? <PersonaSection /> : <PersonaNoteSection />}
    </div>
  )
}
