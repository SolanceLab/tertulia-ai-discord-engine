// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * dashboard/routes.ts — the bot's settings API, mounted under /settings/api. The page itself is a
 * dashboard module (modules/discord/dashboard) that a host renders; the bot serves no page.
 *
 * OFF unless env DASHBOARD_PASSWORD is set: every /settings route then answers 503 with a short
 * note on how to enable it. Separate from the /api bot-secret routes (mounted before that
 * middleware). Login = one shared password -> HMAC-signed, HttpOnly, SameSite=Strict cookie.
 * Settings are read and written through the active SettingsStore seam (the local file in the
 * public default); a store that cannot hold the document answers 501.
 */
import express, { type Request, Router, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EditableSettings, SettingsStore } from '../seams/settings-store.js';
import type { Plugs } from '../config/house-config.js';
import type { MemoryProvider } from '../seams/memory-provider.js';
import { DEFAULT_LABELS } from '../seams/local-settings-store.js';
import type { PersonaProvider } from '../seams/persona-provider.js';
import { readHistory, readInstructions, readPersona, PersonaEditError, undo, savePersonaAndInstructions } from '../persona-edit.js';
import { logger } from '../logger.js';
import { isAgentConnected } from '../agent-presence.js';
import { SERVER_MODES, normalizeServerContextLog, GUILD_ID_RE, type ServerEntry, SERVER_CONTEXT_LOG_VALUES, AWAY_RULES } from '../presence/servers.js';
import { type Step, stepFromLevel, isStep } from '../presence/steps.js';

export interface DashboardDeps {
  settingsStore: SettingsStore;
  plugs: Plugs;
  /** The memory socket, for the read-only status line. Absent = off. */
  memory?: () => MemoryProvider | undefined;
  /** House label overrides from the house config (generic: none). */
  houseLabels?: Record<string, string>;
  /** The persona socket (public build). Absent = the House: no persona section. */
  persona?: PersonaProvider;
  contextLogPath?: string;
  /** When the owner's agent last polled the bot (ms), or null. Absent = no agent status. */
  agentLastSeen?: () => number | null;
  /** The session that is listening for the owner's Discord asks (name, since), or null. Absent = no listener line. */
  listener?: () => { name: string; since: string } | null;
  /** The Stop button: release the listening session. true = someone was listening. */
  stopListener?: () => boolean;
  /** The servers the bot is in (the Servers section). Absent = the page shows none. */
  listServers?: () => Array<{ id: string; name: string; icon?: string | null; channel_count: number; joined_at: string | null; defaults?: unknown }>;
  /** One server's channels, grouped by category (as the bot's list-channels tool returns them). */
  listChannels?: (serverId: string) => Promise<{ categories: any[]; uncategorized: any[] } | null>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const COOKIE = 'dash';
const COOKIE_TTL_MS = 12 * 3_600_000;
const LOGIN_MAX = 10;
const LIST_CAP = 500;
const STR_CAP = 2000;
const LOGIN_WINDOW_MS = 60_000;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SNOWFLAKE = /^\d{15,21}$/;
// A channel value is one of the six steps; the old posture words stay valid so an older save still loads.
const POSTURES = new Set(['silent', 'reply_only', 'reserved', 'balanced', 'sociable', 'chatty', 'full', 'high', 'moderate', 'gentle', 'reactive', 'off']);
const CONTEXT_LOG_VALUES = new Set(['off', 'mentions_only', 'house_channels', 'this_server', 'all']);
const SERVERS_CAP = 200;
const COLOUR = /^[a-zA-Z0-9#(),.%\s-]{1,40}$/;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (s: string) => crypto.createHash('sha256').update(s).digest();
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Labels the page shows: defaults, then the House config's, then anything the store carries that is not the default. */
export function resolveLabels(houseLabels: Record<string, string> = {}, stored: Record<string, string> = {}): Record<string, string> {
  const out = { ...DEFAULT_LABELS, ...houseLabels };
  for (const k of Object.keys(DEFAULT_LABELS)) {
    if (typeof stored[k] === 'string' && stored[k] && stored[k] !== DEFAULT_LABELS[k]) out[k] = stored[k];
  }
  return out;
}

class ValidationError extends Error {}
const bad = (msg: string): never => { throw new ValidationError(msg); };

function onlyKeys(o: Record<string, any>, allowed: string[], where: string) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`unknown key '${k}' in ${where}`);
}
function bool(v: unknown, where: string): boolean { return typeof v === 'boolean' ? v : bad(`${where} must be true or false`); }
function str(v: unknown, where: string, max = STR_CAP, allowEmpty = true): string {
  if (typeof v !== 'string') bad(`${where} must be text`);
  const s = v as string;
  if (s.length > max) bad(`${where} is too long (max ${max})`);
  if (!allowEmpty && !s.trim()) bad(`${where} cannot be empty`);
  return s;
}
function idList(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) bad(`${where} must be a list`);
  const a = v as unknown[];
  if (a.length > LIST_CAP) bad(`${where} has too many entries (max ${LIST_CAP})`);
  const out = new Set<string>();
  for (const x of a) {
    if (typeof x !== 'string' || !SNOWFLAKE.test(x)) bad(`${where} entries must be Discord ids (15-21 digits)`);
    out.add(x as string);
  }
  return [...out];
}

/** Validate a (possibly partial) page document and merge it over the current one. Throws ValidationError. */
export function validateDocument(body: unknown, current: EditableSettings): EditableSettings {
  if (!isObj(body)) bad('body must be an object');
  const b = body as Record<string, any>;
  onlyKeys(b, ['presence', 'curfew', 'away', 'focus', 'ignored_user_ids', 'memory_filter', 'servers', 'appearance', 'labels', 'agent'], 'settings');
  const out: EditableSettings = JSON.parse(JSON.stringify(current));

  if (b.presence !== undefined) {
    if (!isObj(b.presence)) bad('presence must be an object');
    onlyKeys(b.presence, ['step', 'presence_level', 'posture'], 'presence');
    if (b.presence.presence_level !== undefined) {
      const n = b.presence.presence_level;
      if (!Number.isInteger(n) || n < 0 || n > 4) bad('presence_level must be a whole number 0-4');
      out.presence.presence_level = n;
      out.presence.step = stepFromLevel(n) as Step;   // an old client's dial moves the step with it
    }
    if (b.presence.step !== undefined) {
      if (!isStep(b.presence.step)) bad('step must be silent, reply_only, reserved, balanced, sociable or chatty');
      out.presence.step = b.presence.step;
    }
    if (b.presence.posture !== undefined) {
      if (!isObj(b.presence.posture)) bad('posture must be an object');
      const entries = Object.entries(b.presence.posture);
      if (entries.length > LIST_CAP) bad(`posture has too many entries (max ${LIST_CAP})`);
      const p: Record<string, string> = {};
      for (const [id, v] of entries) {
        if (!SNOWFLAKE.test(id)) bad('posture channel ids must be Discord ids (15-21 digits)');
        if (typeof v !== 'string' || !POSTURES.has(v)) bad('posture must be silent, reply_only, reserved, balanced, sociable or chatty');
        p[id] = v as string;
      }
      out.presence.posture = p;
    }
  }
  if (b.curfew !== undefined) {
    if (!isObj(b.curfew)) bad('curfew must be an object');
    onlyKeys(b.curfew, ['enabled', 'start', 'end'], 'curfew');
    if (b.curfew.enabled !== undefined) out.curfew.enabled = bool(b.curfew.enabled, 'curfew.enabled');
    for (const k of ['start', 'end'] as const) {
      if (b.curfew[k] !== undefined) {
        if (typeof b.curfew[k] !== 'string' || !HHMM.test(b.curfew[k])) bad(`curfew.${k} must be a time like 23:00`);
        out.curfew[k] = b.curfew[k];
      }
    }
  }
  if (b.away !== undefined) {
    if (!isObj(b.away)) bad('away must be an object');
    onlyKeys(b.away, ['active', 'reason', 'until', 'announce', 'reason_shareable'], 'away');
    if (b.away.active !== undefined) out.away.active = bool(b.away.active, 'away.active');
    if (b.away.reason !== undefined) out.away.reason = str(b.away.reason, 'away.reason', 1000);
    if (b.away.until !== undefined) {
      if (b.away.until === null || b.away.until === '') out.away.until = null;
      else if (typeof b.away.until === 'string' && b.away.until.length <= 64 && Number.isFinite(Date.parse(b.away.until))) out.away.until = b.away.until;
      else bad('away.until must be a date and time or empty');
    }
    if (b.away.announce !== undefined) out.away.announce = bool(b.away.announce, 'away.announce');
    if (b.away.reason_shareable !== undefined) out.away.reason_shareable = bool(b.away.reason_shareable, 'away.reason_shareable');
  }
  if (b.focus !== undefined) {
    if (!isObj(b.focus)) bad('focus must be an object');
    onlyKeys(b.focus, ['active', 'until_hours'], 'focus');
    if (b.focus.active !== undefined) out.focus.active = bool(b.focus.active, 'focus.active');
    if (b.focus.until_hours !== undefined) {
      const h = b.focus.until_hours;
      if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || h > 48) bad('focus.until_hours must be a number of hours, up to 48');
      out.focus.until_hours = h;
    }
  }
  if (b.ignored_user_ids !== undefined) out.ignored_user_ids = idList(b.ignored_user_ids, 'ignored_user_ids');
  if (b.memory_filter !== undefined) {
    if (!isObj(b.memory_filter)) bad('memory_filter must be an object');
    onlyKeys(b.memory_filter, ['context_log', 'keyword_blocklist'], 'memory_filter');
    if (b.memory_filter.context_log !== undefined) {
      if (typeof b.memory_filter.context_log !== 'string' || !CONTEXT_LOG_VALUES.has(b.memory_filter.context_log)) bad('context_log must be off, mentions_only, house_channels, this_server or all');
      out.memory_filter.context_log = b.memory_filter.context_log;
    }
    if (b.memory_filter.keyword_blocklist !== undefined) {
      const kw = b.memory_filter.keyword_blocklist;
      if (!Array.isArray(kw)) bad('keyword_blocklist must be a list');
      if (kw.length > LIST_CAP) bad(`keyword_blocklist has too many entries (max ${LIST_CAP})`);
      out.memory_filter.keyword_blocklist = [...new Set<string>(kw.map((k: unknown) => str(k, 'keyword', STR_CAP, false).trim()))];
    }
  }
  if (b.servers !== undefined) {
    if (!isObj(b.servers)) bad('servers must be an object');
    const entries = Object.entries(b.servers);
    if (entries.length > SERVERS_CAP) bad(`servers has too many entries (max ${SERVERS_CAP})`);
    for (const [id, patch] of entries) {
      if (!GUILD_ID_RE.test(id)) bad('server ids must be Discord ids (15-25 digits)');
      if (!isObj(patch)) bad('each server must be an object');
      const p = patch as Record<string, any>;
      onlyKeys(p, ['step', 'mode', 'presence_level', 'context_log', 'stickers', 'rules'], `servers.${id}`);
      const cur: ServerEntry = { ...(out.servers[id] ?? {}) };
      if (p.step !== undefined) {
        if (p.step !== null && !isStep(p.step)) bad('server step must be null (same as House), silent, reply_only, reserved, balanced, sociable or chatty');
        cur.step = p.step;
      }
      if (p.mode !== undefined) {
        if (!(SERVER_MODES as readonly unknown[]).includes(p.mode)) bad('server mode must be home, guest or silent');
        cur.mode = p.mode;
      }
      if (p.presence_level !== undefined) {
        if (p.presence_level !== null && (!Number.isInteger(p.presence_level) || p.presence_level < 0 || p.presence_level > 4)) bad('server presence_level must be null or a whole number 0-4');
        cur.presence_level = p.presence_level;
      }
      if (p.context_log !== undefined) {
        if (p.context_log === null) cur.context_log = null;
        else {
          const c = typeof p.context_log === 'string' && SERVER_CONTEXT_LOG_VALUES.includes(normalizeServerContextLog(p.context_log) as any) ? normalizeServerContextLog(p.context_log) : undefined;
          if (!c) bad('server context_log must be null, off, mentions_only, this_server or all');
          cur.context_log = c;
        }
      }
      if (p.stickers !== undefined) {
        if (p.stickers !== null && typeof p.stickers !== 'boolean') bad('server stickers must be true, false or null (same as the global switch)');
        cur.stickers = p.stickers;
      }
      if (p.rules !== undefined) {
        if (!isObj(p.rules)) bad('server rules must be an object');
        onlyKeys(p.rules, ['curfew', 'flag', 'away', 'copy_to_owner'], `servers.${id}.rules`);
        const r = { ...(cur.rules ?? {}) };
        if (p.rules.curfew !== undefined) r.curfew = bool(p.rules.curfew, 'rules.curfew');
        if (p.rules.flag !== undefined) r.flag = bool(p.rules.flag, 'rules.flag');
        if (p.rules.copy_to_owner !== undefined) r.copy_to_owner = bool(p.rules.copy_to_owner, 'rules.copy_to_owner');
        if (p.rules.away !== undefined) {
          if (!(AWAY_RULES as readonly unknown[]).includes(p.rules.away)) bad('rules.away must be channel, owner_dm or off');
          r.away = p.rules.away;
        }
        cur.rules = r;
      }
      out.servers[id] = cur;
    }
  }
  if (b.appearance !== undefined) {
    if (!isObj(b.appearance)) bad('appearance must be an object');
    onlyKeys(b.appearance, ['colour_main', 'colour_accent', 'logo', 'title'], 'appearance');
    for (const k of ['colour_main', 'colour_accent'] as const) {
      if (b.appearance[k] !== undefined) {
        const v = str(b.appearance[k], `appearance.${k}`, 40, false).trim();
        if (!COLOUR.test(v)) bad(`appearance.${k} is not a valid colour`);
        out.appearance[k] = v;
      }
    }
    if (b.appearance.logo !== undefined) {
      const v = str(b.appearance.logo, 'appearance.logo', 200, false).trim();
      if (v !== 'none' && !/^https?:\/\/[^\s"'<>]+$/i.test(v)) bad('appearance.logo must be none or an http(s) address');
      out.appearance.logo = v;
    }
    if (b.appearance.title !== undefined) out.appearance.title = str(b.appearance.title, 'appearance.title', 200, false).trim();
  }
  if (b.agent !== undefined) {
    if (!isObj(b.agent)) bad('agent must be an object');
    onlyKeys(b.agent, ['enabled'], 'agent');
    if (b.agent.enabled !== undefined) {
      if (typeof b.agent.enabled !== 'boolean') bad('agent.enabled must be true or false');
      out.agent = { enabled: b.agent.enabled };
    }
  }
  if (b.labels !== undefined) {
    if (!isObj(b.labels)) bad('labels must be an object');
    onlyKeys(b.labels, Object.keys(DEFAULT_LABELS), 'labels');
    for (const [k, v] of Object.entries(b.labels)) out.labels[k] = str(v, `labels.${k}`, 60, false).trim();
  }
  return out;
}

function readContextLog(path: string, limit: number) {
  const file = resolve(path);
  if (!existsSync(file)) return [];
  const rows: any[] = [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0 && rows.length < limit; i--) {
    try {
      const r = JSON.parse(lines[i]);
      if (!isObj(r)) continue;
      rows.push({
        time: String(r.at ?? r.timestamp ?? ''),
        channel: String(r.channel_name ?? r.channel_id ?? ''),
        author: String(r.author_name ?? ''),
        reply: String(r.content ?? ''),
        is_bot: r.is_bot === true,
        details: isObj(r.context) ? r.context : isObj(r.context_log) ? r.context_log : null,
      });
    } catch { /* skip a corrupt line */ }
  }
  return rows;
}

export function createDashboardRouter(deps: DashboardDeps): Router {
  const env = () => deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const router = Router();
  const randomKey = crypto.randomBytes(32);
  const signingKey = () => (env().DASHBOARD_SECRET ? sha(`dash-cookie:${env().DASHBOARD_SECRET}`) : randomKey);
  const attempts = new Map<string, { count: number; resetAt: number }>();

  const sign = (payload: string) => crypto.createHmac('sha256', signingKey()).update(payload).digest();
  const makeToken = () => {
    const payload = b64u(JSON.stringify({ exp: now() + COOKIE_TTL_MS }));
    return `${payload}.${b64u(sign(payload))}`;
  };
  const validToken = (tok: string | undefined): boolean => {
    if (!tok) return false;
    const [payload, mac, extra] = tok.split('.');
    if (!payload || !mac || extra !== undefined) return false;
    const want = sign(payload);
    let got: Buffer;
    try { got = Buffer.from(mac, 'base64url'); } catch { return false; }
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return false;
    try {
      const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return typeof exp === 'number' && exp > now();
    } catch { return false; }
  };
  const cookieOf = (req: Request): string | undefined => {
    const h = req.headers.cookie;
    if (!h) return undefined;
    for (const part of h.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return undefined;
  };
  const secure = (req: Request) => req.secure || String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  const setCookie = (req: Request, res: Response, value: string, maxAgeS: number) => {
    res.append('Set-Cookie', `${COOKIE}=${value}; Path=/settings; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure(req) ? '; Secure' : ''}`);
  };

  // Off unless a password is set.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!env().DASHBOARD_PASSWORD) {
      res.status(503).type('text/plain').send('The settings page is off. Set the DASHBOARD_PASSWORD environment variable on the bot to turn it on.');
      return;
    }
    next();
  });
  router.use(express.json({ limit: '256kb' }));

  const needAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!validToken(cookieOf(req))) { res.status(401).json({ error: 'login required' }); return; }
    next();
  };

  // --- login / logout ---
  router.post('/api/login', (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const t = now();
    let e = attempts.get(ip);
    if (!e || t > e.resetAt) { e = { count: 0, resetAt: t + LOGIN_WINDOW_MS }; attempts.set(ip, e); }
    e.count++;
    if (e.count > LOGIN_MAX) { res.status(429).json({ error: 'too many attempts, wait a minute' }); return; }
    const pw = isObj(req.body) && typeof req.body.password === 'string' ? req.body.password : '';
    if (!crypto.timingSafeEqual(sha(pw), sha(String(env().DASHBOARD_PASSWORD)))) {
      logger.warn('Dashboard', 'failed login', { ip });
      res.status(401).json({ error: 'wrong password' });
      return;
    }
    setCookie(req, res, makeToken(), COOKIE_TTL_MS / 1000);
    res.json({ ok: true });
  });
  router.post('/api/logout', (req, res) => {
    setCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  // --- settings ---
  const store = deps.settingsStore;
  const agentView = (enabled: boolean) => {
    const seen = deps.agentLastSeen?.() ?? null;
    return { enabled, connected: isAgentConnected(seen, (deps.now ?? Date.now)()), last_seen: seen === null ? null : new Date(seen).toISOString() };
  };
  const view = (doc: EditableSettings) => ({
    ...doc,
    labels: resolveLabels(deps.houseLabels, doc.labels),
    agent: agentView(doc.agent?.enabled === true),
    // Who is listening now (name and since, never the session id).
    listener: (() => { const l = deps.listener?.(); return l ? { name: l.name, since: l.since } : null; })(),
    can_read_context_logs: deps.plugs.memory === 'off',
  });
  // Memory status for the page: the kind and whether it answers. Never a key, never an address.
  let memoryCache: { kind: string; ready: boolean; at: number } | null = null;
  const memoryStatus = async (): Promise<{ kind: 'off' | 'http' | 'antechamber'; ready: boolean }> => {
    const m = deps.memory?.();
    if (!m || m.kind === 'off') return { kind: 'off', ready: false };
    const t = (deps.now ?? Date.now)();
    if (memoryCache && memoryCache.kind === m.kind && t - memoryCache.at < 30_000) return { kind: m.kind, ready: memoryCache.ready };
    let ready = false;
    try {
      // Bound the probe so a down service never stalls the settings page (the result is cached either way).
      ready = m.ping ? await Promise.race([m.ping(), new Promise<boolean>((r) => setTimeout(() => r(false), 1500).unref?.())]) : true;
    } catch { ready = false; }
    memoryCache = { kind: m.kind, ready, at: t };
    return { kind: m.kind, ready };
  };
  router.get('/api/settings', needAuth, async (_req, res) => {
    if (!store.getDocument) { res.status(501).json({ error: 'settings are managed outside this bot for this setup' }); return; }
    try { res.json({ ...view(await store.getDocument()), memory: await memoryStatus() }); }
    catch (err: any) { logger.error('Dashboard', 'settings read failed', { error: err?.message }); res.status(500).json({ error: 'could not read settings' }); }
  });
  router.put('/api/settings', needAuth, async (req, res) => {
    if (!store.getDocument || !store.updateDocument) { res.status(501).json({ error: 'settings are managed outside this bot for this setup' }); return; }
    try {
      const body = req.body;
      res.json(view(await store.updateDocument((current) => validateDocument(body, current))));
    } catch (err: any) {
      if (err instanceof ValidationError) { res.status(400).json({ error: err.message }); return; }
      logger.error('Dashboard', 'settings write failed', { error: err?.message });
      res.status(500).json({ error: 'could not save settings' });
    }
  });

  // --- Stop the listening session (the page's Stop button) ---
  router.post('/api/unlisten', needAuth, (_req, res) => {
    const released = deps.stopListener ? deps.stopListener() : false;
    const l = deps.listener?.() ?? null;
    res.json({ released, listener: l ? { name: l.name, since: l.since } : null });
  });

  // --- persona + extra instructions + history (changes here are the owner's) ---
  const editFailed = (res: Response, err: unknown, what: string) => {
    if (err instanceof PersonaEditError) { res.status(err.status).json({ error: err.message }); return; }
    logger.error('Dashboard', `${what} failed`, { error: String((err as any)?.name || 'Error') });
    res.status(500).json({ error: `could not ${what}` });
  };
  router.get('/api/persona', needAuth, async (_req, res) => {
    try { res.json({ ...(await readPersona(store, deps.persona)), instructions: (await readInstructions(store)).text }); }
    catch (err) { editFailed(res, err, 'read the persona'); }
  });
  router.put('/api/persona', needAuth, async (req, res) => {
    const b = req.body;
    if (!isObj(b)) { res.status(400).json({ error: 'body must be an object' }); return; }
    try {
      res.json(await savePersonaAndInstructions(store, deps.persona, b, 'owner'));
    } catch (err) { editFailed(res, err, 'save the persona'); }
  });
  router.get('/api/settings-history', needAuth, async (_req, res) => {
    try { res.json({ history: await readHistory(store) }); }
    catch (err) { editFailed(res, err, 'read the history'); }
  });
  router.post('/api/settings-history/undo', needAuth, async (req, res) => {
    try { res.json({ undone: await undo(store, deps.persona, isObj(req.body) ? req.body.id : undefined, 'owner') }); }
    catch (err) { editFailed(res, err, 'undo the change'); }
  });

  // --- servers (the Servers section) ---
  router.get('/api/servers', needAuth, (_req, res) => {
    if (!deps.listServers) { res.json({ servers: [] }); return; }
    try { res.json({ servers: deps.listServers() }); }
    catch (err: any) { logger.error('Dashboard', 'server list failed', { error: err?.message }); res.status(500).json({ error: 'could not list servers' }); }
  });
  router.get('/api/channels', needAuth, async (req, res) => {
    const id = String(req.query.server_id ?? '');
    if (!GUILD_ID_RE.test(id)) { res.status(400).json({ error: 'server_id must be a Discord id' }); return; }
    if (!deps.listChannels) { res.json({ channels: [] }); return; }
    try {
      const body = await deps.listChannels(id);
      const channels: any[] = [];
      for (const cat of body?.categories ?? []) {
        for (const ch of cat?.channels ?? []) channels.push({ id: ch.id, name: ch.name, type: ch.type, category: cat.name ?? null, category_position: cat.position ?? 0, position: ch.position ?? 0 });
      }
      for (const ch of body?.uncategorized ?? []) channels.push({ id: ch.id, name: ch.name, type: ch.type, category: null, category_position: null, position: ch.position ?? 0 });
      res.json({ channels });
    } catch (err: any) {
      logger.error('Dashboard', 'channel list failed', { error: err?.message });
      res.status(500).json({ error: 'could not list channels' });
    }
  });

  // --- away calendar (the address is a secret: it goes in, and only { linked, host } comes out) ---
  router.get('/api/away-calendar', needAuth, async (_req, res) => {
    if (!store.getAwayCalendar) { res.status(501).json({ error: 'the calendar is managed outside this bot for this setup' }); return; }
    try { res.json(await store.getAwayCalendar()); }
    catch (err: any) { logger.error('Dashboard', 'calendar read failed', { error: String(err?.name || 'Error') }); res.status(500).json({ error: 'could not read the calendar' }); }
  });
  router.put('/api/away-calendar', needAuth, async (req, res) => {
    if (!store.setAwayCalendar) { res.status(501).json({ error: 'the calendar is managed outside this bot for this setup' }); return; }
    const b = req.body;
    if (!isObj(b) || !Object.keys(b).every((k) => k === 'ics_url') || !('ics_url' in b) || !(b.ics_url === null || typeof b.ics_url === 'string')) {
      res.status(400).json({ error: 'send { ics_url: "https://…" } to link, or { ics_url: null } to unlink' });
      return;
    }
    try { res.json(await store.setAwayCalendar(b.ics_url === '' ? null : b.ics_url)); }
    catch (err: any) {
      // Validation messages name the rule, never the pasted address.
      if (/^calendar address/.test(String(err?.message))) { res.status(400).json({ error: err.message }); return; }
      logger.error('Dashboard', 'calendar write failed', { error: String(err?.name || 'Error') });
      res.status(500).json({ error: 'could not save the calendar' });
    }
  });

  // --- context logs ---
  router.get('/api/context-logs', needAuth, (req, res) => {
    if (deps.plugs.memory !== 'off') { res.status(501).json({ error: 'context logs live in Sanctum for this setup' }); return; }
    const n = Number(req.query.limit ?? 50);
    const limit = Number.isInteger(n) && n >= 1 ? Math.min(n, 200) : 50;
    try {
      res.json({ rows: readContextLog(deps.contextLogPath ?? (env().CONTEXT_LOG_PATH || './data/context-log.jsonl'), limit) });
    } catch (err: any) {
      logger.error('Dashboard', 'context log read failed', { error: err?.message });
      res.status(500).json({ error: 'could not read the context log' });
    }
  });

  router.use((_req, res) => { res.status(404).json({ error: 'not found' }); });
  return router;
}
