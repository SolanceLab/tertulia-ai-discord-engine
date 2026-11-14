// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// A host written against the earlier contract (getCurfew / setCurfew, scene, rules.curfew / rules.flag, earlier label keys)
// keeps working through lib/legacy-names.js: the new name wins, and one warning names the new one.
import { beforeEach, expect, it, vi, describe, afterEach } from 'vitest'
import { resetHost, useLabels, useHost, setHost } from '../host.js'
import { toNew, EARLIER_NUDGE_NOUN, resetLegacyWarnings, modernAdapter, toOld, modernLabels } from '../lib/legacy-names.js'
import { isInternalModelInstruction } from '../lib/contextLogDisplay.js'

let warn
beforeEach(() => { resetHost(); resetLegacyWarnings(); warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => warn.mockRestore())

const legacyAdapter = () => ({
  getCurfew: vi.fn(async () => ({ curfew: { enabled: true, start: '23:00', end: '06:00' } })),
  setCurfew: vi.fn(async (c) => ({ action: 'updated', curfew: c })),
  getDiscordConfig: vi.fn(async () => ({ discord: { step: 'balanced', scene: { active: true }, scene_sightings: [{ caught: true }], servers: { s1: { rules: { curfew: true, flag: false } } } } })),
  setDiscordConfig: vi.fn(async (patch) => ({ discord: { echoed: patch } })),
})

describe('earlier host contract', () => {
  it('getCurfew / setCurfew answer to getQuietHours / setQuietHours, with one warning', async () => {
    const a = legacyAdapter()
    setHost({ adapter: a })
    const h = useHost().adapter
    expect((await h.getQuietHours()).quiet_hours).toEqual({ enabled: true, start: '23:00', end: '06:00' })
    expect((await h.setQuietHours({ enabled: false, start: '22:00', end: '05:00' })).quiet_hours.start).toBe('22:00')
    expect(a.setCurfew).toHaveBeenCalledWith({ enabled: false, start: '22:00', end: '05:00' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('getQuietHours')
  })
  it('the config a legacy host returns is read in the new keys', async () => {
    setHost({ adapter: legacyAdapter() })
    const { discord } = await useHost().adapter.getDiscordConfig()
    expect(discord.focus).toEqual({ active: true })
    expect(discord.focus_sightings).toEqual([{ caught: true }])
    expect(discord.servers.s1.rules).toEqual({ quiet_hours: true, focus: false })
    expect('scene' in discord).toBe(false)
  })
  it('a patch is sent to a legacy host in the keys it knows', async () => {
    const a = legacyAdapter()
    setHost({ adapter: a })
    await useHost().adapter.setDiscordConfig({ focus: { active: false }, servers: { s1: { rules: { quiet_hours: false, focus: true } } } })
    expect(a.setDiscordConfig).toHaveBeenCalledWith({ scene: { active: false }, servers: { s1: { rules: { curfew: false, flag: true } } } })
  })
  it('an adapter that already offers getQuietHours is used as it is', () => {
    const a = { getQuietHours: async () => ({ quiet_hours: null }), getCurfew: async () => ({}) }
    expect(modernAdapter(a)).toBe(a)
    expect(warn).not.toHaveBeenCalled()
  })
  it('earlier label keys are read as the new ones; the new key wins when both are set', () => {
    expect(modernLabels({ house_channels_option: 'A', curfew_description: 'B', server_rule_curfew: 'C', server_rule_flag: 'D' }))
      .toEqual({ this_server_option: 'A', quiet_hours_description: 'B', server_rule_quiet_hours: 'C', server_rule_focus: 'D' })
    expect(modernLabels({ this_server_option: 'new', house_channels_option: 'old' }).this_server_option).toBe('new')
    setHost({ adapter: {}, labels: { server_rule_curfew: 'Nudge me' } })
    expect(useLabels().server_rule_quiet_hours).toBe('Nudge me')
  })
  it('toNew and toOld are inverses on the renamed keys', () => {
    const doc = { focus: { a: 1 }, focus_sightings: [], quiet_hours: { b: 2 }, servers: { s: { rules: { focus: true, quiet_hours: false } } } }
    expect(toNew(toOld(doc))).toEqual(doc)
  })
  it('context-log recovery still recognises the earlier nudge instruction', () => {
    expect(isInternalModelInstruction({ content: `Write the level 2 ${EARLIER_NUDGE_NOUN} nudge.` })).toBe(true)
    expect(isInternalModelInstruction({ content: 'Write the level 2 quiet hours nudge.' })).toBe(true)
  })

  describe('both names present: the new name wins, whatever the property order', () => {
    const PAIRS = [['curfew', 'quiet_hours'], ['scene', 'focus'], ['scene_sighting', 'focus_sighting'], ['scene_sightings', 'focus_sightings']]
    const RULE_PAIRS = [['curfew', 'quiet_hours'], ['flag', 'focus']]
    for (const [oldK, newK] of PAIRS) {
      it(`${newK} beats ${oldK} (modern first and legacy first), one warning`, () => {
        const modernFirst = toNew({ [newK]: { v: 'new' }, [oldK]: { v: 'old' } })
        expect(modernFirst).toEqual({ [newK]: { v: 'new' } })
        resetLegacyWarnings(); warn.mockClear()
        const legacyFirst = toNew({ [oldK]: { v: 'old' }, [newK]: { v: 'new' }, other: 1 })
        expect(legacyFirst).toEqual({ [newK]: { v: 'new' }, other: 1 })
        toNew({ [oldK]: { v: 'old' }, [newK]: { v: 'new' } })
        expect(warn).toHaveBeenCalledTimes(1)
      })
      it(`writing: ${newK} beats ${oldK} (both orders)`, () => {
        expect(toOld({ [newK]: { v: 'new' }, [oldK]: { v: 'old' } })).toEqual({ [oldK]: { v: 'new' } })
        expect(toOld({ [oldK]: { v: 'old' }, [newK]: { v: 'new' } })).toEqual({ [oldK]: { v: 'new' } })
      })
    }
    for (const [oldK, newK] of RULE_PAIRS) {
      it(`rules: ${newK} beats ${oldK} (both orders)`, () => {
        expect(toNew({ servers: { s: { rules: { [newK]: true, [oldK]: false } } } }).servers.s.rules).toEqual({ [newK]: true })
        expect(toNew({ servers: { s: { rules: { [oldK]: false, [newK]: true } } } }).servers.s.rules).toEqual({ [newK]: true })
        expect(toOld({ servers: { s: { rules: { [oldK]: false, [newK]: true } } } }).servers.s.rules).toEqual({ [oldK]: true })
      })
    }
    it('the focus.active case from review: legacy scene after focus does not override', () => {
      expect(toNew({ focus: { active: true }, scene: { active: false } }).focus.active).toBe(true)
      expect(toNew({ scene: { active: false }, focus: { active: true } }).focus.active).toBe(true)
    })
    it('equal values give no collision warning', () => {
      toNew({ scene: { a: 1 }, focus: { a: 1 } })
      expect(warn).not.toHaveBeenCalled()
    })
  })
})
