// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import manifest from '../manifest.js'
import { createBotSettingsAdapter } from '../adapters/bot-settings-api.js'

// The page talks to its own address under /settings/api; serve.mjs forwards that to the bot.
// The password is typed here, sent once to log in, and not stored: the bot's login cookie
// (HttpOnly, set by the bot) is the session.
const adapter = createBotSettingsAdapter({ baseUrl: '/settings/api' })
manifest.setup({ adapter, labels: {}, theme: {}, contextLog: {} })

const routes = Object.fromEntries(manifest.routes.map((r) => [r.path, r]))
const TABS = [
  { path: 'settings/discord', label: 'Settings' },
  { path: 'settings/logs', label: 'Context log' },
]

const button = 'min-h-[44px] rounded border border-[color:var(--rule-strong)] px-4 text-sm text-[color:var(--page)]'
const field = 'w-full min-h-[44px] rounded border border-[color:var(--rule-mid)] bg-[color:var(--ink)] px-3 text-base text-[color:var(--page)]'

function Login({ botAddress, onDone }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(e) {
    e.preventDefault()
    setBusy(true); setError('')
    try { await adapter.login(password); setPassword(''); onDone() }
    catch (err) { setError(err.message || 'Could not log in') }
    setBusy(false)
  }
  return (
    <form onSubmit={submit} className="max-w-md mx-auto px-4 py-16 space-y-4">
      <h1 className="text-2xl">Discord settings</h1>
      <p className="text-sm text-[color:var(--page-dim)]">Bot address: <span className="font-mono">{botAddress || '(not reachable)'}</span></p>
      <label className="block text-sm text-[color:var(--page-dim)]">Dashboard password
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={field + ' mt-1'} />
      </label>
      {error && <p role="alert" className="text-sm text-[color:var(--gold-text)]">{error}</p>}
      <button type="submit" disabled={busy || !password} className={button}>{busy ? 'Logging in' : 'Log in'}</button>
    </form>
  )
}

function Shell() {
  const [state, setState] = useState('checking') // checking | login | ready
  const [botAddress, setBotAddress] = useState('')
  const [tab, setTab] = useState(TABS[0].path)
  const [Page, setPage] = useState(null)

  useEffect(() => {
    fetch('/__example-host').then((r) => r.json()).then((d) => setBotAddress(d.bot)).catch(() => {})
    adapter.getDiscordConfig().then(() => setState('ready')).catch(() => setState('login'))
  }, [])

  useEffect(() => {
    if (state !== 'ready') return
    let live = true
    routes[tab].load().then((m) => { if (live) setPage(() => m.default) })
    return () => { live = false }
  }, [state, tab])

  if (state === 'checking') return null
  if (state === 'login') return <Login botAddress={botAddress} onDone={() => setState('ready')} />
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8">
      <nav className="flex flex-wrap items-center gap-2 mb-6">
        {TABS.map((t) => (
          <button key={t.path} onClick={() => { setPage(null); setTab(t.path) }} aria-current={tab === t.path ? 'page' : undefined}
            className={button + (tab === t.path ? ' border-[color:var(--gold)]' : '')}>{t.label}</button>
        ))}
        <button onClick={() => adapter.logout().finally(() => setState('login'))} className={button + ' ml-auto'}>Log out</button>
      </nav>
      {Page ? <Page /> : null}
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Shell />)
