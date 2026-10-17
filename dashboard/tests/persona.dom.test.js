// @vitest-environment jsdom
// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { beforeEach, expect, it, vi, describe } from 'vitest'
import { resetHost, setHost } from '../host.js'
import { mount, type, section, fakeAdapter, click } from './helpers.jsx'
import DiscordSettings from '../pages/DiscordSettings.jsx'
import { createBotSettingsAdapter } from '../adapters/bot-settings-api.js'

beforeEach(() => { document.body.innerHTML = ''; resetHost() })

const personaAdapter = (over = {}, historyRows) => {
  let state = { source: 'page', editable: true, persona: { text: 'A host.', name: 'Bram', voice: 'dry' }, text_in_use: 'A host.', instructions: 'be brief' }
  const history = historyRows ?? [
    { id: 'id-b', at: '2026-10-16T01:00:00.000Z', by: 'agent', field: 'extra_instructions', before: 'old', after: 'be brief' },
    { id: 'id-a', at: '2026-10-16T00:00:00.000Z', by: 'owner', field: 'persona.name', before: '', after: 'Bram' },
  ]
  return fakeAdapter({
    getPersona: vi.fn(async () => state),
    setPersona: vi.fn(async (patch) => { state = { ...state, persona: { ...state.persona, ...patch }, instructions: patch.instructions ?? state.instructions }; return state }),
    getSettingsHistory: vi.fn(async () => ({ history })),
    undoSettingsChange: vi.fn(async () => ({})),
    ...over,
  })
}

describe('Persona section', () => {
  it('is hidden when the host has no persona adapter; the persona note stays', async () => {
    setHost({ adapter: fakeAdapter() })
    const { el } = await mount(DiscordSettings)
    expect(el.textContent).not.toContain('Change history')
    expect(el.textContent).toContain('deploy-managed')
    expect([...el.querySelectorAll('section h3')].some((h) => h.textContent === 'Persona')).toBe(false)
  })

  it('renders editable fields for the page source and saves only what changed', async () => {
    const adapter = personaAdapter(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Persona')
    expect(sec.textContent).not.toContain('Set by your core')
    expect(el.textContent).not.toContain('deploy-managed')
    const name = [...sec.querySelectorAll('input')][0]
    expect(name.value).toBe('Bram')
    await type(sec, 'Current guidance', 'be very brief')
    await click(sec, 'Save persona')
    expect(adapter.setPersona).toHaveBeenCalledWith({ instructions: 'be very brief' })
  })

  it('shows the text read-only with the core note for a file source, instructions still editable', async () => {
    const adapter = personaAdapter({ getPersona: vi.fn(async () => ({ source: 'file', editable: false, persona: { text: '', name: '', voice: '' }, text_in_use: 'From the core.', instructions: '' })) })
    setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Persona')
    expect(sec.textContent).toContain('Set by your core')
    const ro = [...sec.querySelectorAll('textarea')].find((t) => t.readOnly)
    expect(ro.value).toBe('From the core.')
    expect([...sec.querySelectorAll('input')].length).toBe(0)
    await type(sec, 'Current guidance', 'x')
    await click(sec, 'Save persona')
    expect(adapter.setPersona).toHaveBeenCalledWith({ instructions: 'x' })
  })

  it('lists the history with who and when, and undo calls the adapter', async () => {
    const adapter = personaAdapter(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Change history')
    expect(sec.textContent).toContain('Companion')
    expect(sec.textContent).toContain('You')
    expect(sec.textContent).toContain('old → be brief')
    const undoButtons = [...sec.querySelectorAll('button')].filter((b) => b.textContent === 'Undo')
    expect(undoButtons.length).toBe(2)
    await click(sec, 'Undo')
    expect(adapter.undoSettingsChange).toHaveBeenCalledWith('id-b')
  })

  it('says so when there is no history yet', async () => {
    setHost({ adapter: personaAdapter({}, []) })
    const { el } = await mount(DiscordSettings)
    expect(section(el, 'Change history').textContent).toContain('No changes yet.')
  })

  it('uses neutral wording', async () => {
    setHost({ adapter: personaAdapter() })
    const { el } = await mount(DiscordSettings)
    expect(el.textContent).not.toMatch(new RegExp(['Cha' + 'drien', 'An' + 'ne', 'House', 'Sanctum', 'Routines'].join('|')))
  })
})

describe('public adapter persona calls', () => {
  it('maps to the bot settings API', async () => {
    const calls = []
    const a = createBotSettingsAdapter({ fetchImpl: async (url, init) => { calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({}) } } })
    await a.getPersona(); await a.setPersona({ name: 'B' }); await a.getSettingsHistory(); await a.undoSettingsChange('id-3')
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /settings/api/persona', 'PUT /settings/api/persona', 'GET /settings/api/settings-history', 'POST /settings/api/settings-history/undo'])
    expect(calls[1].body).toEqual({ name: 'B' })
    expect(calls[3].body).toEqual({ id: 'id-3' })
  })
})
