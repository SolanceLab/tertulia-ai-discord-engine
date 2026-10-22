// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Public host adapter: talks to the bot's own /settings/api (login cookie, GET/PUT
// /settings, GET /context-logs) and maps each adapter method onto the bot's
// settings document. Login is the host's job (see login() below, or its own form).
// Fields the bot's document does not hold come back empty/neutral and refuse
// writes; HOST.md lists them.

const UNSUPPORTED_KEYS = ['sweep_minutes', 'extra_instructions', 'name_triggers', 'stickers_enabled']

export function createBotSettingsAdapter({ baseUrl = '/settings/api', fetchImpl, now = () => Date.now() } = {}) {
  const doFetch = (...a) => (fetchImpl || globalThis.fetch)(...a)

  async function call(method, path, body) {
    const res = await doFetch(baseUrl + path, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
  }

  const toDiscord = (doc) => ({
    step: doc.presence?.step,
    presence_level: doc.presence?.presence_level,
    sweep_minutes: null,
    posture: doc.presence?.posture || {},
    extra_instructions: '',
    name_triggers: [],
    stickers_enabled: true,
    away: {
      announce: doc.away?.announce !== false,
      override: {
        active: !!doc.away?.active,
        reason: doc.away?.reason || '',
        until: doc.away?.until || null,
        set_at: null,
        share_reason: doc.away?.reason_shareable !== false,
      },
    },
    context_log: doc.memory_filter?.context_log,
    // Read-only: which memory service the bot is wired to, and whether it answers (no keys or addresses).
    memory: doc.memory && typeof doc.memory.kind === 'string' ? { kind: doc.memory.kind, ready: !!doc.memory.ready } : null,
    ignored_user_ids: doc.ignored_user_ids || [],
    // Per-server choices the owner has saved (only what was set; the bot's defaults fill the rest).
    servers: doc.servers || {},
    // The focus flag: its state, and whether it caught the first message of this raise.
    scene: {
      active: !!doc.focus?.active,
      raised_at: doc.focus?.raised_at || null,
      raised_by: doc.focus?.raised_by || null,
      until: doc.focus?.until || null,
      lowered_at: null,
    },
    scene_sightings: doc.focus?.active && doc.focus?.caught !== null && doc.focus?.caught !== undefined
      ? [{ raised_at: doc.focus.raised_at, caught: !!doc.focus.caught }]
      : [],
  })

  const minutes = (hhmm) => {
    const [h, m] = String(hhmm || '').split(':').map(Number)
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null
  }

  function awayStatus(doc, at = new Date()) {
    const announce = doc.away?.announce !== false
    const reason_shareable = doc.away?.reason_shareable !== false
    // Same semantics as the bot's LocalSettingsStore.getAwayStatus(): an override whose
    // `until` has passed is expired; a live one carries the return time as a WIB HH:MM label.
    const untilMs = doc.away?.until ? Date.parse(doc.away.until) : NaN
    const expired = Number.isFinite(untilMs) && untilMs <= now()
    if (doc.away?.active && !expired) {
      let until_label = null
      if (Number.isFinite(untilMs)) {
        const d = new Date(untilMs + 7 * 3_600_000)
        until_label = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
      }
      return { away: true, source: 'override', status: 'away', reason: doc.away.reason || null, announce, reason_shareable, until: doc.away.until || null, until_label }
    }
    const c = doc.curfew
    const s = minutes(c?.start), e = minutes(c?.end)
    if (c?.enabled && s !== null && e !== null) {
      // Wall clock in WIB (UTC+7), independent of the host's timezone (as curfew-watch.ts does).
      const wib = new Date(at.getTime() + 7 * 3_600_000)
      const cur = wib.getUTCHours() * 60 + wib.getUTCMinutes()
      const inside = s <= e ? cur >= s && cur < e : cur >= s || cur < e
      if (inside) return { away: true, source: 'curfew', status: 'asleep', reason: null, announce, reason_shareable: true, until: null, until_label: c.end }
    }
    return { away: false, source: null, status: null, reason: null, announce, reason_shareable, until: null, until_label: null }
  }

  // The calendar view is optional: a bot without one answers 501 (or nothing useful) and the page shows nothing for it.
  const getCalendar = async () => {
    try {
      const cal = await call('GET', '/away-calendar')
      return cal && typeof cal.linked === 'boolean' ? cal : null
    } catch { return null }
  }

  const getDoc = () => call('GET', '/settings')
  const putDoc = (patch) => call('PUT', '/settings', patch)

  return {
    /** The bot's document does not hold these, so the page hides their sections. */
    capabilities: { sweep_minutes: false, extra_instructions: false, name_triggers: false, stickers_enabled: false },

    /** Optional helper for hosts without their own login form. */
    login: (password) => call('POST', '/login', { password }),
    logout: () => call('POST', '/logout', {}),

    async getDiscordConfig() { return { discord: toDiscord(await getDoc()) } },

    async setDiscordConfig(patch) {
      const bad = Object.keys(patch || {}).filter((k) => UNSUPPORTED_KEYS.includes(k))
      if (bad.length) throw new Error(`The bot's settings API does not hold: ${bad.join(', ')}`)
      const body = {}
      if (patch.step !== undefined || patch.presence_level !== undefined || patch.posture !== undefined) {
        body.presence = {}
        if (patch.presence_level !== undefined) body.presence.presence_level = patch.presence_level
        if (patch.step !== undefined) body.presence.step = patch.step
        if (patch.posture !== undefined) body.presence.posture = patch.posture
      }
      if (patch.servers !== undefined) body.servers = patch.servers
      if (patch.scene !== undefined) {
        body.focus = patch.scene && patch.scene.active
          ? { active: true, ...(patch.scene.until_hours !== undefined ? { until_hours: patch.scene.until_hours } : {}) }
          : { active: false }
      }
      if (patch.context_log !== undefined) body.memory_filter = { context_log: patch.context_log }
      if (patch.ignored_user_ids !== undefined) body.ignored_user_ids = patch.ignored_user_ids
      if (patch.away) {
        body.away = {}
        if (patch.away.announce !== undefined) body.away.announce = patch.away.announce
        const o = patch.away.override
        if (o) {
          if (o.active !== undefined) body.away.active = o.active
          if (o.reason !== undefined) body.away.reason = o.reason
          if (o.until !== undefined) body.away.until = o.until
          if (o.share_reason !== undefined) body.away.reason_shareable = o.share_reason
        }
      }
      return { action: 'updated', discord: toDiscord(await putDoc(body)) }
    },

    /** { servers: [{ id, name, icon, channel_count, joined_at }] }: the servers the bot is in. */
    async getDiscordServers() {
      const res = await call('GET', '/servers')
      return { servers: res.servers || [] }
    },

    /** { channels: [{ id, name, type, category, category_position, position }] } for one server. */
    async getDiscordChannels(guildId) {
      if (!guildId) return { channels: [] }
      const res = await call('GET', `/channels?server_id=${encodeURIComponent(guildId)}`)
      return { channels: res.channels || [] }
    },
    async getDiscordUserInfo(ids) { return { users: (ids || []).map((id) => ({ id, name: null })) } },

    async getChannelBlocklist() { return { blocklist: (await getDoc()).memory_filter?.keyword_blocklist || [] } },
    async setChannelBlocklist(_channel, words) {
      const doc = await putDoc({ memory_filter: { keyword_blocklist: words } })
      return { blocklist: doc.memory_filter?.keyword_blocklist || [] }
    },

    async getCurfew() { return { curfew: (await getDoc()).curfew } },
    async setCurfew({ enabled, start, end }) {
      const doc = await putDoc({ curfew: { enabled, start, end } })
      return { action: 'updated', curfew: doc.curfew }
    },

    async getAwayStatus() {
      const doc = await getDoc()
      const base = awayStatus(doc, new Date(now()))
      // Precedence: manual override > calendar busy now > curfew. The calendar view is best effort.
      if (base.source !== 'override') {
        const cal = await getCalendar()
        if (cal && cal.linked && cal.busy_now?.until) {
          const untilMs = Date.parse(cal.busy_now.until)
          const d = new Date(untilMs + 7 * 3_600_000)
          const until_label = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
          return { away: true, source: 'calendar', status: 'away', reason: null, announce: base.announce, reason_shareable: true, until: cal.busy_now.until, until_label, calendar_unreachable: !!cal.unreachable }
        }
        if (cal && cal.linked && cal.unreachable) return { ...base, calendar_unreachable: true }
      }
      return base
    },

    async setAwayOverride({ active, reason, until, shareReason }) {
      const doc = await putDoc({ away: { active: !!active, reason: reason ?? '', until: until || null, reason_shareable: shareReason !== false } })
      return { action: 'updated', discord: toDiscord(doc) }
    },

    /** Next scheduled away from the linked calendar, or nothing when none is linked. */
    async getAwaySchedule() {
      const cal = await getCalendar()
      if (!cal || !cal.linked) return { next: null, source: null }
      return { next: cal.next ? { start: cal.next.start, end: cal.next.end, label: null } : null, source: 'calendar' }
    },

    /** { linked, host, unreachable }. The address itself is never returned. */
    async getAwayCalendar() {
      const cal = await getCalendar()
      return { linked: !!cal?.linked, host: cal?.host || null, unreachable: !!cal?.unreachable }
    },

    /** url: an https iCal address to link, or null to unlink. */
    async setAwayCalendar(url) {
      const cal = await call('PUT', '/away-calendar', { ics_url: url })
      return { linked: !!cal.linked, host: cal.host || null, unreachable: !!cal.unreachable }
    },

    /**
     * Persona + extra instructions: { source: 'page'|'file'|'url', editable, persona: {text,name,voice}, text_in_use, instructions }.
     * A bot without the persona socket (501) makes the page hide the section.
     */
    async getPersona() { return call('GET', '/persona') },
    /** patch: any of { text, name, voice, instructions }. Changes are recorded as the owner's. */
    async setPersona(patch) { return call('PUT', '/persona', patch) },
    /** { history: [{ id, at, by: 'owner'|'agent', field, before, after }] }, newest first. */
    async getSettingsHistory() { return call('GET', '/settings-history') },
    /** Restore the text one history entry replaced; recorded as its own entry. */
    async undoSettingsChange(id) { return call('POST', '/settings-history/undo', { id }) },

    /** { enabled, connected, last_seen }: the owner's own agent. */
    async getAgentStatus() {
      const a = (await getDoc()).agent || {}
      return { enabled: !!a.enabled, connected: !!a.connected, last_seen: a.last_seen || null }
    },
    /** Switch the agent on or off; answers like getAgentStatus. */
    async setAgentEnabled(enabled) {
      const a = (await putDoc({ agent: { enabled: !!enabled } })).agent || {}
      return { enabled: !!a.enabled, connected: !!a.connected, last_seen: a.last_seen || null }
    },

    /** { listener: { name, since } | null }: the session listening for the owner's Discord asks. */
    async getListener() {
      const l = (await getDoc()).listener
      return { listener: l && typeof l.name === 'string' ? { name: l.name, since: l.since || null } : null }
    },
    /** Stop the listening session; answers like getListener. */
    async stopListener() {
      const res = await call('POST', '/unlisten', {})
      const l = res.listener
      return { listener: l && typeof l.name === 'string' ? { name: l.name, since: l.since || null } : null }
    },

    async getContextLogs({ channel, limit } = {}) {
      if (channel && channel !== 'discord') return { messages: [] }
      const { rows } = await call('GET', `/context-logs?limit=${encodeURIComponent(limit ?? 30)}`)
      return {
        messages: (rows || []).map((r, i) => ({
          id: `${r.time}#${i}`,
          sender: r.is_bot ? 'bot' : 'user',
          author_name: r.author,
          message: r.reply,
          created_at: r.time,
          model: r.details?.model,
          context_log: r.details,
          tool_results: null,
          reasoning: null,
        })),
      }
    },
  }
}
