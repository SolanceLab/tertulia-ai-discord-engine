// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { expect, it, describe, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildExampleHost } from '../example-host/build.mjs'
import { isSettingsPath, isLocalOrigin, isLocalHost, createExampleHost } from '../example-host/serve.mjs'
import { createBotSettingsAdapter } from '../adapters/bot-settings-api.js'

const closers = []
afterEach(async () => { while (closers.length) await closers.pop()() })
const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => { closers.push(() => new Promise((d) => srv.close(d))); ok(srv.address().port) }))

describe('example host', () => {
  it('builds the page and the bundle', async () => {
    const out = mkdtempSync(join(tmpdir(), 'example-host-'))
    try {
      await buildExampleHost(out)
      for (const f of ['index.html', 'main.js', 'main.css']) expect(existsSync(join(out, f))).toBe(true)
      const html = readFileSync(join(out, 'index.html'), 'utf8')
      expect(html).not.toMatch(/<script[^>]+src="https?:/i)
      expect(readFileSync(join(out, 'main.css'), 'utf8')).toMatch(/\.min-h-\\\[44px\\\]/)
      expect(readFileSync(join(out, 'main.js'), 'utf8')).not.toMatch(/DASHBOARD_PASSWORD/)
    } finally { rmSync(out, { recursive: true, force: true }) }
  }, 30000)

  it('treats only /settings paths as the bot', () => {
    expect(isSettingsPath('/settings')).toBe(true)
    expect(isSettingsPath('/settings/api/settings')).toBe(true)
    for (const p of ['/', '/settingsx', '/admin', '/api/mcp', '/health']) expect(isSettingsPath(p)).toBe(false)
  })

  it('answers only requests addressed to this computer (no DNS rebinding)', () => {
    for (const h of ['127.0.0.1:8787', 'localhost:8787', '[::1]:8787', 'localhost']) expect(isLocalHost(h)).toBe(true)
    for (const h of ['evil.example:8787', '127.0.0.1.evil.example', '', undefined]) expect(isLocalHost(h)).toBe(false)
    expect(isLocalOrigin('http://127.0.0.1:8787')).toBe(true)
    for (const o of ['https://evil.example', 'http://evil.example', 'null']) expect(isLocalOrigin(o)).toBe(false)
  })

  it('forwards /settings requests (with cookie and body) and nothing else', async () => {
    const seen = []
    const bot = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, cookie: req.headers.cookie, body })
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dash=abc; Path=/settings; HttpOnly; Secure' })
        res.end('{"ok":true}')
      })
    })
    const botPort = await listen(bot)
    const root = mkdtempSync(join(tmpdir(), 'example-host-root-'))
    const host = createExampleHost({ botUrl: `http://127.0.0.1:${botPort}`, root })
    const port = await listen(host)
    const base = `http://127.0.0.1:${port}`

    const r = await fetch(`${base}/settings/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'dash=1' }, body: '{"password":"x"}' })
    expect(r.status).toBe(200)
    expect(r.headers.get('set-cookie')).not.toMatch(/Secure/i)
    expect(seen).toEqual([{ method: 'POST', url: '/settings/api/login', cookie: 'dash=1', body: '{"password":"x"}' }])

    for (const p of ['/api/mcp', '/health', '/settingsx', '/settings/../health', '/%2e%2e/health', '/index.js']) {
      const x = await fetch(base + p)
      expect([404, 200]).toContain(x.status)
    }
    expect((await fetch(`${base}/health`, { method: 'DELETE' })).status).toBe(405)
    expect((await fetch(`${base}/settings/api/settings`, { method: 'DELETE' })).status).toBe(405)
    // Only the one login call ever reached the bot.
    expect(seen).toHaveLength(1)
    rmSync(root, { recursive: true, force: true })
  })

  it('answers 502 when the bot is down', async () => {
    const host = createExampleHost({ botUrl: 'http://127.0.0.1:9', root: tmpdir() })
    const port = await listen(host)
    expect((await fetch(`http://127.0.0.1:${port}/settings/api/settings`)).status).toBe(502)
  })

  it('refuses a BOT_URL that is not http(s)', () => {
    expect(() => createExampleHost({ botUrl: 'file:///etc/passwd' })).toThrow()
  })
})

describe('bot settings adapter', () => {
  it('calls only /settings routes', async () => {
    const urls = []
    const fetchImpl = async (u) => { urls.push(String(u)); return { ok: true, json: async () => ({ presence: {}, memory_filter: {}, servers: [], channels: [], rows: [], curfew: {}, agent: {} }) } }
    const a = createBotSettingsAdapter({ fetchImpl })
    await Promise.all([
      a.login('x'), a.getDiscordConfig(), a.getDiscordServers(), a.getDiscordChannels('1'), a.getChannelBlocklist(),
      a.getCurfew(), a.getAwayStatus(), a.getContextLogs({}), a.getAgentStatus(), a.getPersona(), a.getSettingsHistory(),
    ])
    expect(urls.length).toBeGreaterThan(8)
    for (const u of urls) expect(u.startsWith('/settings/api/')).toBe(true)
  })
})
