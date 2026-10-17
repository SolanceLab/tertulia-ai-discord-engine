// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { beforeEach, expect, it, describe } from 'vitest'
import { statSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resetHost, useLabels, useHost, setHost } from '../host.js'
import { DEFAULT_LABELS } from '../labels.js'
import manifest from '../manifest.js'
import { createBotSettingsAdapter } from '../adapters/bot-settings-api.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const walk = (d) => readdirSync(d).flatMap((f) => {
  if (f === 'node_modules') return []
  const p = join(d, f)
  return statSync(p).isDirectory() ? walk(p) : [p]
})

beforeEach(() => resetHost())

describe('host contract', () => {
  it('useHost without setHost throws a clear error', () => {
    expect(() => useHost()).toThrow(/no host set/)
  })
  it('setHost needs an adapter', () => {
    expect(() => setHost({})).toThrow(/adapter/)
  })
  it('neutral labels when none passed; given labels override', () => {
    setHost({ adapter: {} })
    expect(useLabels()).toEqual(DEFAULT_LABELS)
    setHost({ adapter: {}, labels: { bot_sender: 'bram' } })
    expect(useLabels().bot_sender).toBe('bram')
    expect(useLabels().page_title).toBe('Tertúlia')
  })
  it('manifest.setup sets the host', () => {
    const adapter = { marker: 1 }
    manifest.setup({ adapter })
    expect(useHost().adapter).toBe(adapter)
  })
  it('no @frame import anywhere under dashboard/', () => {
    const files = walk(root).filter((f) => /\.(js|jsx)$/.test(f) && !f.includes('/tests/'))
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@frame\//)
  })
  it('default labels carry no House names', () => {
    expect(JSON.stringify(DEFAULT_LABELS)).not.toMatch(new RegExp(['Cha' + 'drien', 'An' + 'ne', 'House', 'Sanctum', 'Routines'].join('|')))
  })
})

describe('bot-settings-api adapter', () => {
  const doc = {
    presence: { presence_level: 3, posture: { '1': 'high' } }, curfew: { enabled: true, start: '23:00', end: '06:00' },
    away: { active: false, reason: '', until: null, announce: true, reason_shareable: true }, focus: { active: false },
    ignored_user_ids: ['9'], memory_filter: { context_log: 'all', keyword_blocklist: ['w'] }, appearance: {}, labels: {},
  }
  function mk() {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) })
      const body = url.includes('/context-logs') ? { rows: [{ time: 't', channel: 'c', author: 'A', reply: 'r', is_bot: true, details: { model: 'm' } }] } : doc
      return { ok: true, status: 200, json: async () => body }
    }
    return { a: createBotSettingsAdapter({ fetchImpl }), calls }
  }
  it('away status honours until expiry and sets until_label (WIB)', async () => {
    const NOW = Date.parse('2026-10-14T10:00:00Z')
    const mkAway = (away) => createBotSettingsAdapter({
      now: () => NOW,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ...doc, curfew: { enabled: false }, away: { announce: true, reason_shareable: true, reason: 'trip', ...away } }) }),
    })
    const future = await mkAway({ active: true, until: '2026-10-14T12:30:00Z' }).getAwayStatus()
    expect(future).toMatchObject({ away: true, status: 'away', source: 'override', reason: 'trip', until_label: '19:30' })
    const expired = await mkAway({ active: true, until: '2026-10-14T09:00:00Z' }).getAwayStatus()
    expect(expired).toMatchObject({ away: false, status: null, until_label: null })
    const open = await mkAway({ active: true, until: null }).getAwayStatus()
    expect(open).toMatchObject({ away: true, until_label: null })
  })
  it('curfew is evaluated in WIB regardless of the host timezone', async () => {
    const mkCurfew = (iso) => createBotSettingsAdapter({
      now: () => Date.parse(iso),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ...doc, away: { active: false }, curfew: { enabled: true, start: '23:00', end: '06:00' } }) }),
    })
    // 16:30Z = 23:30 WIB (inside); 10:00Z = 17:00 WIB (outside); 22:30Z = 05:30 WIB (inside)
    expect(await mkCurfew('2026-07-11T16:30:00Z').getAwayStatus()).toMatchObject({ away: true, source: 'curfew', status: 'asleep', until_label: '06:00' })
    expect((await mkCurfew('2026-07-11T10:00:00Z').getAwayStatus()).away).toBe(false)
    expect((await mkCurfew('2026-07-11T22:30:00Z').getAwayStatus()).away).toBe(true)
  })
  it('setAwayOverride maps onto the away document and returns the updated config', async () => {
    const { a, calls } = mk()
    const out = await a.setAwayOverride({ active: true, reason: 'trip', until: '2026-10-14T12:00:00.000Z', shareReason: false })
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: '/settings/api/settings', body: { away: { active: true, reason: 'trip', until: '2026-10-14T12:00:00.000Z', reason_shareable: false } } })
    expect(out.discord.away.override).toMatchObject({ share_reason: expect.any(Boolean) })
  })
  it('calendar: linked busy time reads as away (calendar source), never exposes the address, hidden when none', async () => {
    const NOW = Date.parse('2026-10-14T10:00:00Z')
    const cal = { linked: true, host: 'calendar.example.com', unreachable: false, busy_now: { until: '2026-10-14T11:30:00.000Z' }, next: { start: '2026-10-15T08:00:00.000Z', end: '2026-10-15T09:00:00.000Z' } }
    const calls = []
    const mkCal = (body) => createBotSettingsAdapter({
      now: () => NOW,
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) })
        if (url.endsWith('/away-calendar')) return { ok: true, status: 200, json: async () => body }
        return { ok: true, status: 200, json: async () => ({ ...doc, curfew: { enabled: false }, away: { announce: true, reason_shareable: true, active: false } }) }
      },
    })
    const a = mkCal(cal)
    expect(await a.getAwayStatus()).toMatchObject({ away: true, source: 'calendar', reason: null, until_label: '18:30' })
    expect(await a.getAwaySchedule()).toEqual({ next: { start: '2026-10-15T08:00:00.000Z', end: '2026-10-15T09:00:00.000Z', label: null }, source: 'calendar' })
    expect(await a.getAwayCalendar()).toEqual({ linked: true, host: 'calendar.example.com', unreachable: false })
    await a.setAwayCalendar('https://calendar.example.com/x.ics')
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: '/settings/api/away-calendar', body: { ics_url: 'https://calendar.example.com/x.ics' } })
    const none = mkCal({ linked: false, host: null, unreachable: false, busy_now: null, next: null })
    expect((await none.getAwayStatus()).away).toBe(false)
    expect(await none.getAwaySchedule()).toEqual({ next: null, source: null })
    // a bot that has no calendar route (404 / odd body) simply shows nothing
    const odd = mkCal({ nothing: true })
    expect(await odd.getAwaySchedule()).toEqual({ next: null, source: null })
  })
  it('maps the document onto the discord config shape', async () => {
    const { a } = mk()
    const { discord } = await a.getDiscordConfig()
    expect(discord).toMatchObject({ presence_level: 3, posture: { '1': 'high' }, context_log: 'all', ignored_user_ids: ['9'], name_triggers: [], extra_instructions: '' })
    expect((await a.getChannelBlocklist('discord')).blocklist).toEqual(['w'])
  })
  it('maps patches onto the document and refuses fields the bot does not hold', async () => {
    const { a, calls } = mk()
    await a.setDiscordConfig({ presence_level: 1 })
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: '/settings/api/settings', body: { presence: { presence_level: 1 } } })
    await a.setDiscordConfig({ step: 'chatty' })
    expect(calls.at(-1).body).toEqual({ presence: { step: 'chatty' } })
    expect((await a.getDiscordConfig()).discord).toHaveProperty('step')
    await a.setDiscordConfig({ away: { announce: false } })
    expect(calls.at(-1).body).toEqual({ away: { announce: false } })
    await a.setChannelBlocklist('discord', ['x'])
    expect(calls.at(-1).body).toEqual({ memory_filter: { keyword_blocklist: ['x'] } })
    await a.setCurfew({ enabled: false, start: '22:00', end: '05:00' })
    expect(calls.at(-1).body).toEqual({ curfew: { enabled: false, start: '22:00', end: '05:00' } })
    await expect(a.setDiscordConfig({ name_triggers: ['a'] })).rejects.toThrow(/does not hold/)
  })
  it('maps context logs rows to messages', async () => {
    const { a } = mk()
    const { messages } = await a.getContextLogs({ channel: 'discord', limit: 5 })
    expect(messages[0]).toMatchObject({ sender: 'bot', author_name: 'A', message: 'r', model: 'm' })
    expect((await a.getContextLogs({ channel: 'telegram', limit: 5 })).messages).toEqual([])
  })
})

import { resetHost as _rh, useHost as _uh, setHost as _sh } from '../host.js'
import { createBotSettingsAdapter as _cba } from '../adapters/bot-settings-api.js'
describe('capabilities', () => {
  it('default all supported; bot adapter hides the four unsupported', () => {
    _sh({ adapter: {} })
    expect(_uh().capabilities.sweep_minutes).toBe(true)
    _sh({ adapter: _cba({ fetchImpl: () => {} }) })
    expect(_uh().capabilities).toEqual({ sweep_minutes: false, extra_instructions: false, name_triggers: false, stickers_enabled: false })
    _rh()
  })
})
