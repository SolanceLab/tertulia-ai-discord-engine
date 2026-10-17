// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

export function fakeAdapter(overrides = {}) {
  let discord = {
    presence_level: 2, sweep_minutes: 30, posture: {}, extra_instructions: '', name_triggers: ['alpha'],
    stickers_enabled: true, away: { announce: true, override: { active: false } }, context_log: 'house_channels', ignored_user_ids: [],
  }
  let blocklist = ['one']
  let curfew = { enabled: true, start: '23:00', end: '06:00' }
  const a = {
    getDiscordConfig: vi.fn(async () => ({ discord })),
    setDiscordConfig: vi.fn(async (patch) => { discord = { ...discord, ...patch }; return { action: 'updated', discord } }),
    getDiscordChannels: vi.fn(async () => ({ channels: [] })),
    getDiscordUserInfo: vi.fn(async (ids) => ({ users: ids.map((id) => ({ id, name: null })) })),
    getChannelBlocklist: vi.fn(async () => ({ blocklist })),
    setChannelBlocklist: vi.fn(async (_c, words) => { blocklist = words; return { blocklist } }),
    getCurfew: vi.fn(async () => ({ curfew })),
    setCurfew: vi.fn(async (c) => { curfew = c; return { action: 'updated', curfew } }),
    getAwayStatus: vi.fn(async () => ({ away: false, announce: true })),
    setAwayOverride: vi.fn(async ({ active, reason, until, shareReason }) => {
      discord = { ...discord, away: { ...discord.away, override: { active, reason, until, share_reason: shareReason } } }
      return { action: 'updated', discord }
    }),
    getContextLogs: vi.fn(async () => ({ messages: [] })),
    ...overrides,
  }
  return a
}

export async function mount(Component) {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  await act(async () => { root.render(<Component />) })
  await act(async () => {})
  return { el, unmount: () => act(async () => root.unmount()) }
}

export async function click(el, text) {
  const b = [...el.querySelectorAll('button')].find((x) => x.textContent.trim() === text)
  if (!b) throw new Error('no button: ' + text)
  await act(async () => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => {})
}

export async function type(el, placeholderStart, value) {
  const i = [...el.querySelectorAll('input,textarea')].find((x) => (x.getAttribute('placeholder') || '').startsWith(placeholderStart))
  if (!i) throw new Error('no input: ' + placeholderStart)
  const proto = i.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, value)
    i.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** The <section> whose heading starts with the given text. */
export function section(el, heading) {
  const s = [...el.querySelectorAll('section')].find((x) => (x.querySelector('h3')?.textContent || '').startsWith(heading))
  if (!s) throw new Error('no section: ' + heading)
  return s
}
