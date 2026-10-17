// @vitest-environment jsdom
// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { beforeEach, expect, it, vi, describe } from 'vitest'
import { act } from 'react'
import { resetHost, setHost } from '../host.js'
import { mount, section, fakeAdapter, click } from './helpers.jsx'
import DiscordSettings from '../pages/DiscordSettings.jsx'
import { normStep, groupChannels, effectiveServer, STEPS, houseStepOf, stepFromLevel, diffServer, hoursUntilMorning } from '../lib/servers.js'
import { createBotSettingsAdapter } from '../adapters/bot-settings-api.js'

beforeEach(() => { document.body.innerHTML = ''; resetHost() })

const C = '333333333333333333'
const B = '222222222222222222'
const A = '111111111111111111'

const SERVERS = [
  { id: A, name: 'Alpha', channel_count: 12, joined_at: '2026-01-01T00:00:00.000Z', defaults: { step: 'balanced', rules: { curfew: true, flag: true, away: 'channel' } } },
  { id: B, name: 'Beta', channel_count: 4, joined_at: '2026-02-01T00:00:00.000Z', defaults: { step: 'reply_only', rules: { curfew: true, flag: false, away: 'owner_dm' } } },
  { id: C, name: 'Gamma', channel_count: 2, joined_at: '2026-03-01T00:00:00.000Z' },
]
const CHANNELS = [
  { id: '1000000000000000001', name: 'general', type: 'text', category: 'Lounges', category_position: 1, position: 1 },
  { id: '1000000000000000002', name: 'after-hours', type: 'text', category: 'Lounges', category_position: 1, position: 0 },
  { id: '1000000000000000003', name: 'welcome', type: 'text', category: 'Start', category_position: 0, position: 0 },
  { id: '1000000000000000004', name: 'loose', type: 'text', category: null, category_position: null, position: 0 },
  { id: '1000000000000000005', name: 'voice-room', type: 'voice', category: 'Start', category_position: 0, position: 1 },
]

function adapterWithServers(over = {}) {
  return fakeAdapter({
    getDiscordServers: vi.fn(async () => ({ servers: SERVERS })),
    getDiscordChannels: vi.fn(async () => ({ channels: CHANNELS })),
    ...over,
  })
}

const card = (el, name) => {
  const c = [...el.querySelectorAll('[data-server]')].find((x) => x.querySelector('h4')?.textContent === name)
  if (!c) throw new Error('no server card: ' + name)
  return c
}
const STEP_LABEL = 'How much the bot talks here'
async function setSelect(sel, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, value)
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function tick(fn) { await act(async () => { fn() }); await act(async () => {}) }
const selectByLabel = (c, label) => c.querySelector(`select[aria-label="${label}"]`)

describe('Servers section', () => {
  it('renders every server the bot is in, with how much it talks there', async () => {
    setHost({ adapter: adapterWithServers() })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Servers')
    expect([...sec.querySelectorAll('[data-server]')].map((c) => c.querySelector('h4').textContent)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(selectByLabel(card(el, 'Alpha'), STEP_LABEL).value).toBe('balanced')
    expect(selectByLabel(card(el, 'Beta'), STEP_LABEL).value).toBe('reply_only')
    // a server the host gave no defaults for starts Silent
    expect(selectByLabel(card(el, 'Gamma'), STEP_LABEL).value).toBe('silent')
    expect(sec.textContent).toContain('12 channels')
  })

  it('the step select offers Same as main dial (showing the dial) and the six steps, with the meaning of the chosen one', async () => {
    setHost({ adapter: adapterWithServers() })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Beta')
    const sel = selectByLabel(c, STEP_LABEL)
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Same as main dial (Balanced)', 'Silent', 'Reply only', 'Reserved', 'Balanced', 'Sociable', 'Chatty'])
    expect(c.querySelector('[data-step-meaning]').textContent).toBe('Answers when someone mentions it. Never starts.')
    await setSelect(sel, 'chatty')
    expect(c.querySelector('[data-step-meaning]').textContent).toBe('Joins in freely.')
    await setSelect(sel, '')
    expect(c.querySelector('[data-step-meaning]').textContent).toBe("Joins in when there's a real opening.")
    expect(c.textContent).not.toMatch(/Gentle|Moderate|High|Full|Guest|Home/)
  })

  it('"Same as main dial" shows the big dial\'s current step', async () => {
    const adapter = adapterWithServers()
    const base = await adapter.getDiscordConfig()
    adapter.getDiscordConfig.mockResolvedValue({ discord: { ...base.discord, step: 'sociable' } })
    setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    expect(selectByLabel(card(el, 'Beta'), STEP_LABEL).options[0].textContent).toBe('Same as main dial (Sociable)')
  })

  it('saved choices win over the host defaults, and an old mode is read as a step', async () => {
    const adapter = adapterWithServers()
    const base = await adapter.getDiscordConfig()
    adapter.getDiscordConfig.mockResolvedValue({ discord: { ...base.discord, servers: { [B]: { step: 'chatty', rules: { away: 'off' } }, [A]: { mode: 'guest' }, [C]: { step: null } } } })
    setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    expect(selectByLabel(card(el, 'Beta'), STEP_LABEL).value).toBe('chatty')
    expect(selectByLabel(card(el, 'Alpha'), STEP_LABEL).value).toBe('reply_only')
    expect(selectByLabel(card(el, 'Gamma'), STEP_LABEL).value).toBe('')
  })

  it('changing the step and saving sends only servers[id].step; "Same as main dial" sends null', async () => {
    const adapter = adapterWithServers(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Gamma')
    await setSelect(selectByLabel(c, STEP_LABEL), 'sociable')
    await click(c, 'Save server')
    expect(adapter.setDiscordConfig).toHaveBeenLastCalledWith({ servers: { [C]: { step: 'sociable' } } })
    await setSelect(selectByLabel(c, STEP_LABEL), '')
    await click(c, 'Save server')
    expect(adapter.setDiscordConfig).toHaveBeenLastCalledWith({ servers: { [C]: { step: null } } })
  })

  it('save is disabled until something changes', async () => {
    setHost({ adapter: adapterWithServers() })
    const { el } = await mount(DiscordSettings)
    const save = [...card(el, 'Alpha').querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save server')
    expect(save.disabled).toBe(true)
  })

  it('details hold the memory choice, rules and the memory note (no per-server dial)', async () => {
    setHost({ adapter: adapterWithServers() })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Alpha')
    await click(c, 'Details')
    expect(selectByLabel(c, 'Presence dial here')).toBeNull()
    const mem = selectByLabel(c, 'What it remembers here')
    expect([...mem.options].map((o) => o.textContent)).toEqual(['Same as default', 'Off', 'Mentions only', 'This server', 'All'])
    expect(c.textContent).toContain('never mixed with another server')
    expect(c.textContent).toContain('Rules here')
  })

  it('memory saves send a partial, and "Same as default" sends null', async () => {
    const adapter = adapterWithServers(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Beta')
    await click(c, 'Details')
    await setSelect(selectByLabel(c, STEP_LABEL), 'reserved')
    await setSelect(selectByLabel(c, 'What it remembers here'), 'this_server')
    await click(c, 'Save server')
    expect(adapter.setDiscordConfig).toHaveBeenLastCalledWith({ servers: { [B]: { step: 'reserved', context_log: 'this_server' } } })
    await setSelect(selectByLabel(c, 'What it remembers here'), '')
    await click(c, 'Save server')
    expect(adapter.setDiscordConfig).toHaveBeenLastCalledWith({ servers: { [B]: { context_log: null } } })
  })

  it('rules save: curfew, flag and the away choice', async () => {
    const adapter = adapterWithServers(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Beta')
    await click(c, 'Details')
    const boxes = [...c.querySelectorAll('input[type=checkbox]')]
    const curfew = boxes.find((b) => b.parentElement.textContent.includes('Curfew'))
    const flag = boxes.find((b) => b.parentElement.textContent.includes('focus flag'))
    expect(curfew.checked).toBe(true)
    expect(flag.checked).toBe(false)
    await act(async () => { curfew.click() })
    await act(async () => { flag.click() })
    await setSelect(selectByLabel(c, 'When someone asks for you while you are away'), 'off')
    await click(c, 'Save server')
    expect(adapter.setDiscordConfig).toHaveBeenCalledWith({ servers: { [B]: { rules: { curfew: false, flag: true, away: 'off' } } } })
  })

  it('rules save: copy to owner by DM', async () => {
    const adapter = adapterWithServers(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Beta')
    await click(c, 'Details')
    const box = [...c.querySelectorAll('input[type=checkbox]')].find((b) => b.parentElement.textContent.includes('copy of what the bot says'))
    expect(box.checked).toBe(false)
    await act(async () => { box.click() })
    await click(c, 'Save server')
    expect(adapter.setDiscordConfig).toHaveBeenCalledWith({ servers: { [B]: { rules: { copy_to_owner: true } } } })
  })

  it('stickers save: a per-server choice, with its plain description', async () => {
    const adapter = adapterWithServers(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Beta')
    await click(c, 'Details')
    expect(c.textContent).toContain("Whether the bot adds this server's own stickers to its messages, sparingly.")
    const sel = selectByLabel(c, 'Stickers here')
    expect([...sel.options].map((o) => o.value)).toEqual(['', 'on', 'off'])
    expect(sel.value).toBe('')
    await setSelect(sel, 'on')
    await click(c, 'Save server')
    expect(adapter.setDiscordConfig).toHaveBeenCalledWith({ servers: { [B]: { stickers: true } } })
  })

  it('stickers: a server the host seeds with stickers off shows Off, and clearing sends null', async () => {
    const adapter = adapterWithServers(); setHost({ adapter })
    expect(effectiveServer({ stickers: false }, null).stickers).toBe(false)
    expect(effectiveServer({ stickers: false }, { stickers: null }).stickers).toBe(null)
    expect(diffServer(effectiveServer({ stickers: false }, null), effectiveServer({ stickers: false }, { stickers: null }))).toEqual({ stickers: null })
  })

  it('the away select carries channel / owner_dm / off with their plain labels', async () => {
    setHost({ adapter: adapterWithServers() })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Alpha')
    await click(c, 'Details')
    const away = selectByLabel(c, 'When someone asks for you while you are away')
    expect([...away.options].map((o) => [o.value, o.textContent])).toEqual([
      ['channel', 'Tell them in the channel'],
      ['owner_dm', 'Only tell you (DM)'],
      ['off', 'Off'],
    ])
    expect(away.value).toBe('channel')
  })

  it('channels are grouped by category in order, voice rooms left out, and fetched for that server', async () => {
    const adapter = adapterWithServers(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Alpha')
    await click(c, 'Details')
    expect(adapter.getDiscordChannels).toHaveBeenCalledWith(A)
    const groups = [...c.querySelectorAll('[data-category]')]
    expect(groups.map((g) => g.getAttribute('data-category'))).toEqual(['Start', 'Lounges', 'No category'])
    expect([...groups[1].querySelectorAll('span.flex-1')].map((s) => s.textContent)).toEqual(['#after-hours', '#general'])
    expect(c.textContent).not.toContain('voice-room')
  })

  it('a channel step is open on every server, and saves as channel-id keys in posture', async () => {
    const adapter = adapterWithServers(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const g = card(el, 'Beta') // replies only
    await click(g, 'Details')
    const sel = g.querySelector('select[aria-label="Step for general"]')
    expect([...g.querySelectorAll('select[aria-label^="Step for"]')].every((s) => !s.disabled)).toBe(true)
    expect(g.textContent).toContain('A channel follows its server unless you pick a step for it.')
    expect([...sel.options].map((o) => o.textContent)).toEqual(['Same as server (Reply only)', 'Silent', 'Reply only', 'Reserved', 'Balanced', 'Sociable', 'Chatty'])
    // wide enough for 'Same as server (Reply only)': no 200px cap, full width on a phone, a floor on desktop
    expect(sel.className).not.toContain('max-w-[200px]')
    expect(sel.className).toContain('max-w-full')
    expect(sel.className).toContain('sm:min-w-[280px]')
    await setSelect(sel, 'chatty')
    await click(g, 'Save server')
    expect(adapter.setDiscordConfig).toHaveBeenCalledWith({ posture: { '1000000000000000001': 'chatty' } })
  })

  it('a channel can be set to Silent and cleared back to Same as server', async () => {
    const adapter = adapterWithServers(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const g = card(el, 'Beta')
    await click(g, 'Details')
    await setSelect(g.querySelector('select[aria-label="Step for general"]'), 'silent')
    await click(g, 'Save server')
    expect(adapter.setDiscordConfig).toHaveBeenLastCalledWith({ posture: { '1000000000000000001': 'silent' } })
  })

  it('a channel edit keeps other channels already saved, and Same as server removes one; old words show as steps', async () => {
    const adapter = adapterWithServers()
    const base = await adapter.getDiscordConfig()
    adapter.getDiscordConfig.mockResolvedValue({ discord: { ...base.discord, posture: { '1000000000000000001': 'high', '9999999999999999999': 'full' } } })
    setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Alpha')
    await click(c, 'Details')
    expect(c.querySelector('select[aria-label="Step for general"]').value).toBe('reserved')
    await setSelect(c.querySelector('select[aria-label="Step for general"]'), '')
    await setSelect(c.querySelector('select[aria-label="Step for welcome"]'), 'balanced')
    await click(c, 'Save server')
    expect(adapter.setDiscordConfig).toHaveBeenCalledWith({ posture: { '9999999999999999999': 'full', '1000000000000000003': 'balanced' } })
  })

  it('category groups collapse', async () => {
    setHost({ adapter: adapterWithServers() })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Alpha')
    await click(c, 'Details')
    expect(c.textContent).toContain('#general')
    await click(c, '▾Lounges')
    expect(c.textContent).not.toContain('#general')
  })

  it('shows an error and keeps the form when the save fails', async () => {
    const adapter = adapterWithServers({ setDiscordConfig: vi.fn(async () => { throw new Error('x') }) }); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const c = card(el, 'Gamma')
    await setSelect(selectByLabel(c, STEP_LABEL), 'reply_only')
    await click(c, 'Save server')
    expect(c.textContent).toContain('Could not save this server. Try again.')
    expect(selectByLabel(c, STEP_LABEL).value).toBe('reply_only')
  })

  it('replaces the flat posture list, and uses neutral wording', async () => {
    setHost({ adapter: adapterWithServers() })
    const { el } = await mount(DiscordSettings)
    expect(() => section(el, 'Per-channel posture')).toThrow()
    expect(el.textContent).not.toMatch(new RegExp(['Cha' + 'drien', 'An' + 'ne', 'House', 'Sanctum', 'Routines'].join('|')))
  })

  it('an empty list says so; a failing list offers a retry', async () => {
    setHost({ adapter: adapterWithServers({ getDiscordServers: vi.fn(async () => ({ servers: [] })) }) })
    let m = await mount(DiscordSettings)
    expect(section(m.el, 'Servers').textContent).toContain('The bot is not in any server yet.')
    document.body.innerHTML = ''; resetHost()
    const adapter = adapterWithServers({ getDiscordServers: vi.fn(async () => { throw new Error('x') }) }); setHost({ adapter })
    m = await mount(DiscordSettings)
    expect(section(m.el, 'Servers').textContent).toContain('Could not load the server list')
    await click(section(m.el, 'Servers'), 'Retry')
    expect(adapter.getDiscordServers).toHaveBeenCalledTimes(2)
  })

  it('hides Servers and Focus mode, and keeps the flat posture list, when the adapter cannot list servers', async () => {
    setHost({ adapter: fakeAdapter() })
    const { el } = await mount(DiscordSettings)
    expect(() => section(el, 'Servers')).toThrow()
    expect(() => section(el, 'Focus mode')).toThrow()
    expect(section(el, 'Per-channel posture')).toBeTruthy()
  })
})

describe('Focus mode section', () => {
  const withScene = (scene, sightings) => {
    const adapter = adapterWithServers()
    return adapter.getDiscordConfig().then((base) => {
      adapter.getDiscordConfig.mockResolvedValue({ discord: { ...base.discord, scene, scene_sightings: sightings } })
      return adapter
    })
  }

  it('shows the flag down by default', async () => {
    setHost({ adapter: adapterWithServers() })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Focus mode')
    expect(sec.textContent).toContain('Down')
    expect([...sec.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Turn off').disabled).toBe(true)
  })

  it('shows up, until, raised by and caught when the flag is up', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString()
    const adapter = await withScene({ active: true, raised_at: '2026-10-15T10:00:00.000Z', raised_by: 'dashboard', until }, [{ raised_at: '2026-10-15T10:00:00.000Z', caught: true }])
    setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const t = section(el, 'Focus mode').textContent
    expect(t).toContain('Up')
    expect(t).toContain('dashboard')
    expect(t).toMatch(/CaughtYes/)
  })

  it('caught is "Not yet" without a sighting for this raise, and an expired flag reads Down', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString()
    let adapter = await withScene({ active: true, raised_at: '2026-10-15T10:00:00.000Z', raised_by: 'a', until }, [{ raised_at: '2026-10-14T10:00:00.000Z', caught: true }])
    setHost({ adapter })
    let m = await mount(DiscordSettings)
    expect(section(m.el, 'Focus mode').textContent).toMatch(/CaughtNot yet/)
    document.body.innerHTML = ''; resetHost()
    adapter = await withScene({ active: true, raised_at: '2026-10-15T10:00:00.000Z', raised_by: 'a', until: '2020-01-01T00:00:00.000Z' }, [])
    setHost({ adapter })
    m = await mount(DiscordSettings)
    expect(section(m.el, 'Focus mode').textContent).toContain('Down')
  })

  it('raising sends { scene: { active, raised_by, until_hours } } for 30m, 1h, 2h and until morning', async () => {
    const adapter = adapterWithServers(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Focus mode')
    await click(sec, '30m')
    expect(adapter.setDiscordConfig).toHaveBeenLastCalledWith({ scene: { active: true, raised_by: 'dashboard', until_hours: 0.5 } })
    await click(sec, '1h')
    expect(adapter.setDiscordConfig).toHaveBeenLastCalledWith({ scene: { active: true, raised_by: 'dashboard', until_hours: 1 } })
    await click(sec, '2h')
    expect(adapter.setDiscordConfig).toHaveBeenLastCalledWith({ scene: { active: true, raised_by: 'dashboard', until_hours: 2 } })
    await click(sec, 'Until morning')
    const last = adapter.setDiscordConfig.mock.calls.at(-1)[0].scene
    expect(last.active).toBe(true)
    expect(last.until_hours).toBeGreaterThan(0)
    expect(last.until_hours).toBeLessThanOrEqual(24)
  })

  it('lowering sends { scene: { active: false } }', async () => {
    const until = new Date(Date.now() + 3_600_000).toISOString()
    const adapter = await withScene({ active: true, raised_at: '2026-10-15T10:00:00.000Z', raised_by: 'dashboard', until }, [])
    setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    await click(section(el, 'Focus mode'), 'Turn off')
    expect(adapter.setDiscordConfig).toHaveBeenLastCalledWith({ scene: { active: false } })
  })

  it('shows an error when the change fails', async () => {
    const adapter = adapterWithServers({ setDiscordConfig: vi.fn(async () => { throw new Error('x') }) }); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    await click(section(el, 'Focus mode'), '1h')
    expect(section(el, 'Focus mode').textContent).toContain('Could not change the focus flag. Try again.')
  })

  it('a host can rename the section through labels', async () => {
    setHost({ adapter: adapterWithServers(), labels: { focus_title: 'Quiet flag' } })
    const { el } = await mount(DiscordSettings)
    expect(section(el, 'Quiet flag')).toBeTruthy()
  })
})

describe('servers helpers', () => {
  it('effectiveServer lays saved choices over defaults, field by field', () => {
    expect(effectiveServer(undefined, null)).toEqual({ step: 'silent', context_log: null, stickers: null, rules: { curfew: true, flag: false, away: 'off', copy_to_owner: false } })
    const e = effectiveServer({ step: 'reply_only', rules: { away: 'owner_dm' } }, { rules: { flag: true }, context_log: 'house_channels', step: null })
    expect(e).toEqual({ step: null, context_log: 'this_server', stickers: null, rules: { curfew: true, flag: true, away: 'owner_dm', copy_to_owner: false } })
  })
  it('effectiveServer keeps an explicit silent seed against a legacy live home dial, like the bot', () => {
    expect(effectiveServer({ step: 'silent' }, { mode: 'home', presence_level: 4 }).step).toBe('silent')
    expect(effectiveServer({ mode: 'silent' }, { mode: 'home', presence_level: 4 }).step).toBe('silent')
    expect(effectiveServer(undefined, { mode: 'home', presence_level: 4 }).step).toBe('chatty')
  })
  it('effectiveServer reads an old mode and dial as a step, like the bot does', () => {
    expect(effectiveServer({ mode: 'guest' }, null).step).toBe('reply_only')
    expect(effectiveServer(null, { mode: 'guest' }).step).toBe('reply_only')
    expect(effectiveServer(null, { mode: 'silent' }).step).toBe('silent')
    expect(effectiveServer(null, { mode: 'home' }).step).toBeNull()
    expect(effectiveServer(null, { mode: 'home', presence_level: 3 }).step).toBe('sociable')
    expect(effectiveServer({ step: 'reply_only' }, { mode: 'home', presence_level: 3 }).step).toBe('reply_only')
    expect(effectiveServer({ step: 'reply_only' }, { mode: 'silent' }).step).toBe('silent')
    expect(effectiveServer({ step: 'reply_only' }, { step: 'chatty', mode: 'silent' }).step).toBe('chatty')
  })
  it('the ladder helpers map old values', () => {
    expect(STEPS).toEqual(['silent', 'reply_only', 'reserved', 'balanced', 'sociable', 'chatty'])
    expect(['off', 'reactive', 'gentle', 'moderate', 'high', 'full', 'chatty', 'loud', undefined].map(normStep)).toEqual(['silent', 'reply_only', 'reserved', 'reserved', 'reserved', 'reserved', 'chatty', null, null])
    expect([0, 1, 2, 3, 4, 5, null].map(stepFromLevel)).toEqual(['reply_only', 'reserved', 'balanced', 'sociable', 'chatty', null, null])
    expect(houseStepOf({ step: 'chatty', presence_level: 0 })).toBe('chatty')
    expect(houseStepOf({ presence_level: 1 })).toBe('reserved')
    expect(houseStepOf({})).toBe('balanced')
  })
  it('diffServer returns the smallest patch, or null', () => {
    const a = effectiveServer(null, null)
    expect(diffServer(a, a)).toBeNull()
    expect(diffServer(a, { ...a, step: 'reply_only', rules: { ...a.rules, away: 'channel' } })).toEqual({ step: 'reply_only', rules: { away: 'channel' } })
    expect(diffServer({ ...a, step: 'balanced' }, { ...a, step: null })).toEqual({ step: null })
  })
  it('groupChannels orders categories by position with uncategorized last', () => {
    expect(groupChannels(CHANNELS).map((g) => g.name)).toEqual(['Start', 'Lounges', 'No category'])
    expect(groupChannels([])).toEqual([])
  })
  it('hoursUntilMorning is the gap to the next 07:00', () => {
    expect(hoursUntilMorning(new Date(2026, 9, 15, 22, 0, 0))).toBe(9)
    expect(hoursUntilMorning(new Date(2026, 9, 15, 6, 30, 0))).toBe(0.5)
    expect(hoursUntilMorning(new Date(2026, 9, 15, 7, 0, 0))).toBe(24)
  })
})

describe('public adapter: servers and the focus flag', () => {
  function bot(doc = {}) {
    const calls = []
    let state = { presence: { step: 'balanced', presence_level: 2, posture: {} }, away: {}, curfew: {}, memory_filter: {}, ignored_user_ids: [], servers: {}, focus: { active: false }, ...doc }
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
      let body = state
      if (url.endsWith('/servers')) body = { servers: [{ id: A, name: 'Alpha', channel_count: 1 }] }
      else if (url.includes('/channels')) body = { channels: [{ id: '5', name: 'g', type: 'text', category: null }] }
      else if (init.method === 'PUT') body = state = { ...state, ...JSON.parse(init.body) }
      return { ok: true, json: async () => body }
    })
    return { adapter: createBotSettingsAdapter({ fetchImpl }), calls }
  }
  it('lists servers and one server\'s channels', async () => {
    const { adapter, calls } = bot()
    expect((await adapter.getDiscordServers()).servers[0].name).toBe('Alpha')
    expect((await adapter.getDiscordChannels(A)).channels).toHaveLength(1)
    expect(calls.at(-1).url).toBe(`/settings/api/channels?server_id=${A}`)
    expect(await adapter.getDiscordChannels()).toEqual({ channels: [] })
  })
  it('sends servers as-is and maps scene to focus', async () => {
    const { adapter, calls } = bot()
    await adapter.setDiscordConfig({ servers: { [A]: { mode: 'home' } } })
    expect(calls.at(-1).body).toEqual({ servers: { [A]: { mode: 'home' } } })
    await adapter.setDiscordConfig({ scene: { active: true, raised_by: 'dashboard', until_hours: 2 } })
    expect(calls.at(-1).body).toEqual({ focus: { active: true, until_hours: 2 } })
    await adapter.setDiscordConfig({ scene: { active: false } })
    expect(calls.at(-1).body).toEqual({ focus: { active: false } })
  })
  it('reads servers, scene and sightings from the document', async () => {
    const { adapter } = bot({ servers: { [A]: { mode: 'guest' } }, focus: { active: true, raised_at: '2026-10-15T10:00:00.000Z', raised_by: 'dashboard', until: '2026-10-15T12:00:00.000Z', caught: true } })
    const { discord } = await adapter.getDiscordConfig()
    expect(discord.servers[A].mode).toBe('guest')
    expect(discord.scene).toMatchObject({ active: true, raised_by: 'dashboard' })
    expect(discord.scene_sightings).toEqual([{ raised_at: '2026-10-15T10:00:00.000Z', caught: true }])
  })
})
