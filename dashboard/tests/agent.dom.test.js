// @vitest-environment jsdom
// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { beforeEach, expect, it, vi, describe } from 'vitest'
import { act } from 'react'
import { resetHost, setHost } from '../host.js'
import { mount, section, fakeAdapter } from './helpers.jsx'
import DiscordSettings from '../pages/DiscordSettings.jsx'
import { createBotSettingsAdapter } from '../adapters/bot-settings-api.js'

beforeEach(() => { document.body.innerHTML = ''; resetHost() })

const agentAdapter = (status) => {
  let s = status
  return fakeAdapter({
    getAgentStatus: vi.fn(async () => s),
    setAgentEnabled: vi.fn(async (enabled) => { s = { ...s, enabled }; return s }),
  })
}

describe('Agent section', () => {
  it('is hidden when the adapter has no getAgentStatus', async () => {
    setHost({ adapter: fakeAdapter() })
    const { el } = await mount(DiscordSettings)
    expect([...el.querySelectorAll('section h3')].some((h) => h.textContent === 'Agent')).toBe(false)
  })

  it('shows Off, Not connected, and Connected with last seen', async () => {
    for (const [status, text] of [
      [{ enabled: false, connected: false, last_seen: null }, 'Off'],
      [{ enabled: true, connected: false, last_seen: null }, 'Not connected'],
      [{ enabled: true, connected: true, last_seen: new Date(Date.now() - 60_000).toISOString() }, 'Connected · last seen 1 min ago'],
    ]) {
      document.body.innerHTML = ''
      setHost({ adapter: agentAdapter(status) })
      const { el } = await mount(DiscordSettings)
      const sec = section(el, 'Agent')
      expect(sec.textContent).toContain(text)
      expect(sec.textContent).toContain('Your own agent (for example Claude Code or Codex)')
    }
  })

  it('the switch calls setAgentEnabled', async () => {
    const adapter = agentAdapter({ enabled: false, connected: false, last_seen: null })
    setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const box = section(el, 'Agent').querySelector('input[type=checkbox]')
    await act(async () => { box.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})
    expect(adapter.setAgentEnabled).toHaveBeenCalledWith(true)
  })
})

describe('bot settings adapter, agent', () => {
  it('reads and writes the agent through the settings document', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push([init.method, url, init.body])
      return { ok: true, json: async () => ({ agent: { enabled: true, connected: true, last_seen: '2026-10-16T00:00:00.000Z' } }) }
    }
    const a = createBotSettingsAdapter({ fetchImpl })
    expect(await a.getAgentStatus()).toEqual({ enabled: true, connected: true, last_seen: '2026-10-16T00:00:00.000Z' })
    await a.setAgentEnabled(false)
    expect(calls[1]).toEqual(['PUT', '/settings/api/settings', JSON.stringify({ agent: { enabled: false } })])
  })
})

describe('Listening line', () => {
  const listenAdapter = (listener) => {
    let l = listener
    return fakeAdapter({
      getAgentStatus: vi.fn(async () => ({ enabled: true, connected: true, last_seen: null })),
      getListener: vi.fn(async () => ({ listener: l })),
      stopListener: vi.fn(async () => { l = null; return { listener: null } }),
    })
  }

  it('says who is listening and since when, with a Stop button', async () => {
    setHost({ adapter: listenAdapter({ name: 'Study one', since: new Date().toISOString() }) })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Agent')
    expect(sec.textContent).toContain('Listening: Study one since ')
    expect([...sec.querySelectorAll('button')].some((b) => b.textContent === 'Stop')).toBe(true)
  })

  it('says no session is listening, and has no Stop button', async () => {
    setHost({ adapter: listenAdapter(null) })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Agent')
    expect(sec.textContent).toContain('No session is listening')
    expect([...sec.querySelectorAll('button')].some((b) => b.textContent === 'Stop')).toBe(false)
  })

  it('Stop calls stopListener and the line changes', async () => {
    const adapter = listenAdapter({ name: 'Study one', since: new Date().toISOString() })
    setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const stop = [...section(el, 'Agent').querySelectorAll('button')].find((b) => b.textContent === 'Stop')
    await act(async () => { stop.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => {})
    expect(adapter.stopListener).toHaveBeenCalled()
    expect(section(el, 'Agent').textContent).toContain('No session is listening')
  })

  it('an adapter without getListener shows no listening line', async () => {
    setHost({ adapter: agentAdapter({ enabled: true, connected: true, last_seen: null }) })
    const { el } = await mount(DiscordSettings)
    expect(section(el, 'Agent').textContent).not.toContain('listening')
  })

  it('the bot adapter reads the listener from the settings document and posts Stop to /unlisten', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push([init.method, url])
      return { ok: true, json: async () => (init.method === 'POST' ? { released: true, listener: null } : { listener: { name: 'Study one', since: '2026-10-22T05:00:00.000Z' } }) }
    }
    const a = createBotSettingsAdapter({ fetchImpl })
    expect(await a.getListener()).toEqual({ listener: { name: 'Study one', since: '2026-10-22T05:00:00.000Z' } })
    expect(await a.stopListener()).toEqual({ listener: null })
    expect(calls[1]).toEqual(['POST', '/settings/api/unlisten'])
  })
})
