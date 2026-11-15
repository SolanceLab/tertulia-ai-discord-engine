// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Demo: the real settings page against a make-believe bot that keeps invented data in memory.
// No Discord, no real bot, nothing saved to disk. Used for the screenshots in docs/.
//   node dashboard/example-host/demo.mjs        (then open http://127.0.0.1:8787/, any password works)
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { buildExampleHost } from './build.mjs'
import { createExampleHost } from './serve.mjs'

const GUILD_A = '100000000000000001'
const GUILD_B = '100000000000000002'
const step = (s) => ({ step: s, rules: { quiet_hours: true, focus: true, away: 'channel' } })

export function createDemoBot() {
  let doc = {
    presence: { step: 'reserved', presence_level: 2, posture: {} },
    quiet_hours: { enabled: true, start: '23:00', end: '06:00' },
    timezone: 'Europe/Lisbon',
    focus: { active: false },
    away: { active: false, announce: true, reason_shareable: true },
    ignored_user_ids: [],
    memory_filter: { context_log: 'this_server', keyword_blocklist: [] },
    memory: { kind: 'off', ready: false },
    servers: {},
    agent: { enabled: false, connected: false },
    listener: null,
    labels: {},
    can_read_context_logs: false,
  }
  const servers = [
    { id: GUILD_A, name: 'Moonlight Café', channel_count: 3, joined_at: '2026-03-01T00:00:00.000Z', defaults: step('reserved') },
    { id: GUILD_B, name: 'Book Club', channel_count: 2, joined_at: '2026-04-01T00:00:00.000Z', defaults: step('reply_only') },
  ]
  const channels = {
    [GUILD_A]: ['general', 'venting', 'memes'].map((name, i) => ({ id: `20000000000000010${i}`, name, type: 'text', category: 'Text channels', category_position: 0, position: i })),
    [GUILD_B]: ['homework-help', 'off-topic'].map((name, i) => ({ id: `20000000000000020${i}`, name, type: 'text', category: 'Text channels', category_position: 0, position: i })),
  }
  const persona = { source: 'page', editable: true, persona: { text: 'A friendly regular who reads the room.', name: 'Juniper', voice: 'warm, brief' }, text_in_use: 'A friendly regular who reads the room.', instructions: '' }
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body)) }
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {}
      const p = url.pathname.replace(/^\/settings\/api/, '')
      if (p === '/login' || p === '/logout') return json(res, 200, { ok: true })
      if (p === '/settings' && req.method === 'GET') return json(res, 200, doc)
      if (p === '/settings' && req.method === 'PUT') {
        for (const [k, v] of Object.entries(body)) doc = { ...doc, [k]: v && typeof v === 'object' && !Array.isArray(v) ? { ...doc[k], ...v } : v }
        return json(res, 200, doc)
      }
      if (p === '/servers') return json(res, 200, { servers })
      if (p === '/channels') return json(res, 200, { channels: channels[url.searchParams.get('server_id')] || [] })
      if (p === '/persona') return json(res, 200, persona)
      if (p === '/settings-history') return json(res, 200, { history: [] })
      if (p === '/away-calendar') return json(res, 501, { error: 'no calendar in the demo' })
      if (p === '/context-logs') return json(res, 200, { rows: [] })
      json(res, 404, { error: 'not in the demo' })
    })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bot = createDemoBot()
  await new Promise((ok) => bot.listen(0, '127.0.0.1', ok))
  await buildExampleHost()
  const port = Number(process.env.PORT || 8787)
  createExampleHost({ botUrl: `http://127.0.0.1:${bot.address().port}` }).listen(port, '127.0.0.1', () => {
    console.log(`Demo settings page (invented data): http://127.0.0.1:${port}/`)
  })
}
