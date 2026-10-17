// @vitest-environment jsdom
// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { beforeEach, expect, it, vi, describe } from 'vitest'
import { act } from 'react'
import { resetHost, setHost } from '../host.js'
import { mount, type, section, fakeAdapter, click } from './helpers.jsx'
import DiscordSettings from '../pages/DiscordSettings.jsx'
import ContextLogs from '../pages/ContextLogs.jsx'

beforeEach(() => { document.body.innerHTML = ''; resetHost() })

describe('DiscordSettings with a fake host', () => {
  it('renders all sections with neutral labels when none are passed', async () => {
    setHost({ adapter: fakeAdapter() })
    const { el } = await mount(DiscordSettings)
    const text = el.textContent
    expect(text).toContain('Context log (what the bot remembers)')
    expect(text).toContain('Chosen channels')
    expect(text).toContain('Presence dial')
    expect(text).toContain('Keyword filter')
    expect(text).not.toMatch(new RegExp(['Cha' + 'drien', 'An' + 'ne', 'House', 'Sanctum', 'Routines'].join('|')))
  })

  it('given labels override the neutral ones', async () => {
    setHost({ adapter: fakeAdapter(), labels: { context_log_title: 'Context log (what the House remembers)', house_channels_option: 'House channels', page_description: 'Custom line.' } })
    const { el } = await mount(DiscordSettings)
    expect(el.textContent).toContain('Context log (what the House remembers)')
    expect(el.textContent).toContain('House channels')
    expect(el.textContent).toContain('Custom line.')
    expect(el.textContent).toContain('Hidden people (who the bot never sees)')
  })

  it('presence save sends { step }, read from the old dial when the host sends no step', async () => {
    const adapter = fakeAdapter(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    await click(el, 'Save presence')
    expect(adapter.setDiscordConfig).toHaveBeenCalledWith({ step: 'balanced' })
  })

  it('the big dial has six labelled ticks and shows the meaning of the chosen step', async () => {
    const adapter = fakeAdapter(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Presence dial')
    expect(sec.textContent).toContain('How willing the bot is to speak up on its own. Servers and channels can set their own.')
    for (const l of ['Silent', 'Reply only', 'Reserved', 'Balanced', 'Sociable', 'Chatty']) expect(sec.textContent).toContain(l)
    expect(sec.textContent).not.toMatch(/Gentle|Moderate|High|Full/)
    expect(sec.querySelector('[data-step-meaning]').textContent).toBe("Joins in when there's a real opening.")
    const range = sec.querySelector('input[type=range]')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(range, '5')
      range.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(sec.querySelector('[data-step-meaning]').textContent).toBe('Joins in freely.')
    await click(sec, 'Save presence')
    expect(adapter.setDiscordConfig).toHaveBeenLastCalledWith({ step: 'chatty' })
  })

  it('posture save sends { posture }', async () => {
    const adapter = fakeAdapter(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Per-channel posture')
    await type(sec, 'Add a channel', '123456789012345678')
    await click(sec, 'Add')
    await click(sec, 'Save posture')
    expect(adapter.setDiscordConfig).toHaveBeenCalledWith({ posture: { '123456789012345678': 'reserved' } })
  })

  it('extra instructions save sends { extra_instructions }', async () => {
    const adapter = fakeAdapter(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    expect([...el.querySelectorAll('textarea')][0].getAttribute('placeholder')).toBe('Current guidance for the room…')
    await type(el, 'Current guidance', 'be brief')
    await click(el, 'Save instructions')
    expect(adapter.setDiscordConfig).toHaveBeenCalledWith({ extra_instructions: 'be brief' })
  })

  it('name triggers save sends { name_triggers }', async () => {
    const adapter = fakeAdapter(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Name triggers')
    await type(sec, 'Add name(s)', 'beta')
    await click(sec, 'Add')
    await click(sec, 'Save triggers')
    expect(adapter.setDiscordConfig).toHaveBeenCalledWith({ name_triggers: ['alpha', 'beta'] })
  })

  it('hiding an id sends { ignored_user_ids }', async () => {
    const adapter = fakeAdapter(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    await type(el, 'Add Discord id', '222222222222222222')
    await click(el, 'Hide')
    expect(adapter.setDiscordConfig).toHaveBeenCalledWith({ ignored_user_ids: ['222222222222222222'] })
  })

  it('blocklist add and remove call get/setChannelBlocklist', async () => {
    const adapter = fakeAdapter(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    expect(adapter.getChannelBlocklist).toHaveBeenCalledWith('discord')
    const sec = section(el, 'Keyword filter')
    await type(sec, 'Add a word', 'two')
    await click(sec, 'Add')
    await click(sec, 'Save filter')
    expect(adapter.setChannelBlocklist).toHaveBeenCalledWith('discord', ['one', 'two'])
    const x = [...section(el, 'Keyword filter').querySelectorAll('button')].find((b) => b.textContent.trim() === '×')
    await act(async () => { x.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await click(section(el, 'Keyword filter'), 'Save filter')
    expect(adapter.setChannelBlocklist).toHaveBeenLastCalledWith('discord', ['two'])
  })
})

describe('ContextLogs with a fake host', () => {
  it('fetches through the adapter and shows neutral wording', async () => {
    const adapter = fakeAdapter({ getContextLogs: vi.fn(async () => ({ messages: [{ id: 'a', sender: 'bot', author_name: 'Botty', message: 'hello', created_at: '2026-10-14T10:00:00Z', context_log: null }] })) })
    setHost({ adapter })
    const { el } = await mount(ContextLogs)
    expect(adapter.getContextLogs).toHaveBeenCalledWith({ channel: 'discord', limit: 30 })
    expect(el.textContent).toContain('See what the bot received and responded for each message.')
    expect(el.textContent).toContain('Botty')
    expect(el.textContent).not.toMatch(/Sanctum|Telegram/)
  })

  it('channel tabs come from labels', async () => {
    const adapter = fakeAdapter(); setHost({ adapter, labels: { context_log_channels: ['discord', 'telegram', 'web'] } })
    const { el } = await mount(ContextLogs)
    await click(el, 'Telegram')
    expect(adapter.getContextLogs).toHaveBeenLastCalledWith({ channel: 'telegram', limit: 30 })
  })
})

describe('Away section', () => {
  it('saves the override through setAwayOverride and refreshes RIGHT NOW', async () => {
    const adapter = fakeAdapter(); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Away')
    expect(sec.textContent).toContain("Whether the bot tells guests it's away, and why. Set it here, or let a linked calendar set it.")
    const boxes = sec.querySelectorAll('input[type=checkbox]')
    const away = [...boxes].find((b) => b.parentElement.textContent.includes('Away right now'))
    await act(async () => { away.click() })
    await type(sec, 'e.g. traveling', '  at the shops ')
    const priv = [...boxes].find((b) => b.parentElement.textContent.includes('Keep this reason private'))
    await act(async () => { priv.click() })
    const before = adapter.getAwayStatus.mock.calls.length
    await click(sec, 'Save away status')
    expect(adapter.setAwayOverride).toHaveBeenCalledWith({ active: true, reason: 'at the shops', until: null, shareReason: false })
    expect(adapter.getAwayStatus.mock.calls.length).toBeGreaterThan(before)
    expect(sec.textContent).toContain('Saved')
  })
  it('shows an error when the override cannot be saved', async () => {
    const adapter = fakeAdapter({ setAwayOverride: vi.fn(async () => { throw new Error('x') }) }); setHost({ adapter })
    const { el } = await mount(DiscordSettings)
    await click(section(el, 'Away'), 'Save away status')
    expect(section(el, 'Away').textContent).toContain('Could not save the away override. Try again.')
  })
  it('calendar row is hidden when the adapter lacks setAwayCalendar, and no schedule line shows', async () => {
    setHost({ adapter: fakeAdapter() })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Away')
    expect(sec.textContent).not.toContain('Calendar')
    expect(sec.textContent).not.toContain('Next scheduled away')
    expect(sec.querySelector('input[type=password]')).toBeNull()
  })
  it('calendar row links with a masked field, shows the host, unlinks, and shows the next scheduled away', async () => {
    let state = { linked: false, host: null }
    const adapter = fakeAdapter({
      getAwayCalendar: vi.fn(async () => state),
      setAwayCalendar: vi.fn(async (url) => { state = url ? { linked: true, host: 'calendar.google.com' } : { linked: false, host: null }; return state }),
      getAwaySchedule: vi.fn(async () => ({ next: { start: '2026-10-15T08:00:00.000Z', end: '2026-10-15T09:00:00.000Z', label: 'Thu 08:00–09:00' }, source: 'calendar' })),
    })
    setHost({ adapter, labels: { schedule_link: { href: 'https://example.com/cal', text: 'Open calendar' } } })
    const { el } = await mount(DiscordSettings)
    const sec = section(el, 'Away')
    expect(sec.textContent).toContain('Next scheduled away: Thu 08:00–09:00')
    expect(sec.querySelector('a[href="https://example.com/cal"]').textContent).toBe('Open calendar')
    expect(sec.textContent).toContain('Busy times count as away; event names are never shown.')
    expect(sec.querySelector('input[type=password]')).not.toBeNull()
    await type(sec, 'Paste your private', 'https://calendar.google.com/calendar/ical/secret/basic.ics')
    await click(sec, 'Link')
    expect(adapter.setAwayCalendar).toHaveBeenCalledWith('https://calendar.google.com/calendar/ical/secret/basic.ics')
    expect(sec.textContent).toContain('Linked (calendar.google.com)')
    expect(sec.textContent).not.toContain('secret/basic.ics')
    await click(sec, 'Unlink')
    expect(adapter.setAwayCalendar).toHaveBeenLastCalledWith(null)
    expect(sec.querySelector('input[type=password]')).not.toBeNull()
  })
})

describe('slider fill', () => {
  it('the fill variable tracks the value on both range inputs', async () => {
    setHost({ adapter: fakeAdapter() })
    const { el } = await mount(DiscordSettings)
    const ranges = [...el.querySelectorAll('input[type=range]')]
    expect(ranges.length).toBe(2)
    expect(ranges.every((r) => r.classList.contains('range-fill'))).toBe(true)
    const fill = (r) => /--fill:\s*([\d.]+)%/.exec(r.getAttribute('style'))[1]
    expect(fill(ranges[0])).toBe('60') // balanced = tick 3 of 0-5
    const set = async (r, v) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, String(v))
        r.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await set(ranges[0], 5)
    expect(fill(ranges[0])).toBe('100')
    await set(ranges[1], 0)
    expect(fill(ranges[1])).toBe('0')
    await set(ranges[1], 3)
    expect(fill(ranges[1])).toBe('100')
  })
})
