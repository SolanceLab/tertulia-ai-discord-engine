// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Serves the built example host and forwards /settings/* to the bot, so the browser only ever talks
// to this server (same origin: no CORS change on the bot). It listens on this computer only.
//   BOT_URL=http://127.0.0.1:3000 PORT=8787 node dashboard/example-host/serve.mjs
// BOT_URL is set by the owner when starting the server; the page cannot point it elsewhere.
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFile } from 'node:fs/promises'
import { extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const MAX_BODY = 1024 * 1024

/** True for /settings and anything under /settings/, after the address is normalised. */
export function isSettingsPath(pathname) {
  return pathname === '/settings' || pathname.startsWith('/settings/')
}

const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** True when the Host header names this computer (any port). */
export function isLocalHost(host) {
  if (typeof host !== 'string' || !host) return false
  try { return LOCAL_NAMES.has(new URL(`http://${host}`).hostname) } catch { return false }
}

/** True when an Origin header is this computer over plain http. */
export function isLocalOrigin(origin) {
  try { const u = new URL(origin); return u.protocol === 'http:' && LOCAL_NAMES.has(u.hostname) } catch { return false }
}

export function createExampleHost({ botUrl, root = resolve(here, 'build') }) {
  const target = new URL(botUrl)
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('BOT_URL must be an http or https address')
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest

  function proxy(req, res, url) {
    const headers = { host: target.host }
    for (const k of ['cookie', 'content-type', 'accept']) if (req.headers[k]) headers[k] = req.headers[k]
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (res.writableEnded) return
      const body = Buffer.concat(chunks)
      if (body.length) headers['content-length'] = String(body.length)
      const up = send({
        protocol: target.protocol, hostname: target.hostname, port: target.port || undefined,
        method: req.method, path: url.pathname + url.search, headers, timeout: 15000,
      }, (upRes) => {
        const out = { ...upRes.headers }
        // The page is served over http on this computer; a Secure cookie would not be kept.
        if (out['set-cookie']) out['set-cookie'] = out['set-cookie'].map((c) => c.replace(/;\s*Secure/gi, ''))
        delete out['transfer-encoding']
        res.writeHead(upRes.statusCode || 502, out)
        upRes.pipe(res)
      })
      up.on('timeout', () => up.destroy(new Error('timeout')))
      up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Could not reach the bot at ' + target.origin })) })
      up.end(body)
    })
  }

  return createServer(async (req, res) => {
    // Only requests addressed to this computer: a web page that re-points its own name at 127.0.0.1
    // (DNS rebinding) arrives with a foreign Host header and is refused.
    if (!isLocalHost(req.headers.host)) { res.writeHead(421).end(); return }
    // A write must come from this page itself, not from another site the browser has open.
    if (req.method !== 'GET' && req.headers.origin && !isLocalOrigin(req.headers.origin)) { res.writeHead(403).end(); return }
    let url
    try { url = new URL(req.url || '/', 'http://localhost') } catch { res.writeHead(400).end(); return }
    if (isSettingsPath(url.pathname)) {
      if (!['GET', 'PUT', 'POST'].includes(req.method || '')) { res.writeHead(405).end(); return }
      proxy(req, res, url); return
    }
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    if (url.pathname === '/__example-host') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ bot: target.origin })); return
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    if (!['index.html', 'main.js', 'main.css'].includes(name)) { res.writeHead(404).end(); return }
    try {
      const data = await readFile(resolve(root, name))
      res.writeHead(200, { 'content-type': TYPES[extname(name)], 'cache-control': 'no-store' }).end(data)
    } catch { res.writeHead(404).end('Not built yet: run make example-host') }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const botUrl = process.env.BOT_URL || `http://127.0.0.1:${process.env.BOT_API_PORT || 3000}`
  const port = Number(process.env.PORT || 8787)
  createExampleHost({ botUrl }).listen(port, '127.0.0.1', () => {
    console.log(`Example host: http://127.0.0.1:${port}/  (bot: ${new URL(botUrl).origin})`)
  })
}
