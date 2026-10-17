// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * away-calendar.ts — a linked iCal feed as the away schedule (Discord Phase 3c).
 *
 * The owner pastes the private iCal address of a calendar. Busy times count as away; event names are
 * NEVER read out of this module (titles are not even kept). The address is a SECRET: it is never
 * logged and never returned — views carry only { linked, host }.
 *
 * Small hand parser, no dependency: VEVENT DTSTART/DTEND/DURATION (UTC "Z", TZID local times via Intl,
 * floating times as UTC, all-day DATE values), RRULE FREQ=DAILY|WEEKLY with INTERVAL, BYDAY, COUNT,
 * UNTIL, plus EXDATE and RECURRENCE-ID overrides. TRANSP:TRANSPARENT and STATUS:CANCELLED are ignored.
 * Anything else (other FREQs, unreadable zones) is skipped with a counted warning.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import { Readable } from 'node:stream';
import { logger } from './logger.js';

export const REFETCH_MS = 10 * 60_000;
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_ICS_BYTES = 2 * 1024 * 1024;
export const GRACE_MS = 6 * 3_600_000;
export const URL_MAX = 2000;
const MAX_ITER_DAYS = 20_000;
const DAY = 86_400_000;
const LOOKAHEAD_DAYS = 14;
/** Hard caps on what one feed may cost: events overall, recurring events, one event's length, and how far from now it may sit. */
export const MAX_RECURRING = 200;
export const MAX_EVENTS = 2000;
const MAX_EVENT_DAYS = 366;
const MAX_YEARS_FROM_NOW = 100;
/** Window cache lifetime: busy windows are recomputed at most once per minute per parsed feed. */
const WINDOW_TTL_MS = 60_000;

export interface CalendarConfig { ics_url: string | null; busy_means_away: true }
export const defaultCalendarConfig = (): CalendarConfig => ({ ics_url: null, busy_means_away: true });

/** Validate a pasted address: https, a real hostname (no IP literal, no localhost), <= 2000 chars. Returns the trimmed url or throws. */
export function validateIcsUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('calendar address must be text');
  const s = raw.trim();
  if (!s) throw new Error('calendar address cannot be empty');
  if (s.length > URL_MAX) throw new Error(`calendar address is too long (max ${URL_MAX})`);
  let u: URL;
  try { u = new URL(s); } catch { throw new Error('calendar address must be a web address'); }
  if (u.protocol !== 'https:') throw new Error('calendar address must start with https://');
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || h === 'localhost' || h.endsWith('.localhost') || h.startsWith('[') || /^\d+(\.\d+){3}$/.test(h)) {
    throw new Error('calendar address must use a public host name');
  }
  return s;
}

/** Expand an IPv6 literal to eight 16-bit groups (handles "::" and a trailing dotted quad), or null when malformed. */
function expandV6(ip: string): number[] | null {
  let l = ip.toLowerCase().split('%')[0];
  const dq = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(l);
  if (dq) {
    const [a, b, c, d] = dq.slice(1).map(Number);
    l = l.slice(0, dq.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = l.split('::');
  if (halves.length > 2) return null;
  const parse = (x: string) => (x ? x.split(':') : []);
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

/** True for loopback, private, link-local, metadata, CGNAT, multicast and otherwise non-public addresses. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (v === 6) {
    const g = expandV6(ip);
    if (!g) return true;
    const embedded = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    const zeros = (n: number) => g.slice(0, n).every((x) => x === 0);
    if (zeros(5) && g[5] === 0xffff) return isPrivateIp(embedded(g[6], g[7])); // ::ffff:a.b.c.d (IPv4-mapped)
    if (zeros(6)) return true; // :: , ::1 and IPv4-compatible ::a.b.c.d (deprecated, never a public peer)
    if (g[0] === 0x2002) return isPrivateIp(embedded(g[1], g[2])); // 6to4: the embedded IPv4 decides
    if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo 2001:0::/32
    if (g[0] === 0x64 && g[1] === 0xff9b) return true; // NAT64
    if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
  }
  return true; // not an address at all
}

export type HostLookup = (host: string) => Promise<string[]>;
const defaultLookup: HostLookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((r) => r.address);

export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

// ── time helpers ───────────────────────────────────────────────────────────────────────────────

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    dtfCache.set(tz, f);
  }
  return f;
}
/** Offset (ms) of `tz` from UTC at instant `ts`. Throws RangeError for an unknown zone. */
function tzOffset(ts: number, tz: string): number {
  if (tz === 'UTC') return 0;
  const parts = dtf(tz).formatToParts(new Date(ts));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return asUtc - Math.floor(ts / 1000) * 1000;
}
/** Offset memo per (zone, UTC day): a day with the same offset at both ends has no transition inside it, so any instant that day reuses it. */
const offsetMemo = new Map<string, { a: number; b: number }>();
function tzOffsetMemo(ts: number, tz: string): number {
  if (tz === 'UTC') return 0;
  const day = Math.floor(ts / DAY);
  const key = `${tz}|${day}`;
  let e = offsetMemo.get(key);
  if (!e) {
    if (offsetMemo.size > 20_000) offsetMemo.clear();
    e = { a: tzOffset(day * DAY, tz), b: tzOffset(day * DAY + DAY - 1000, tz) };
    offsetMemo.set(key, e);
  }
  return e.a === e.b ? e.a : tzOffset(ts, tz); // a transition falls inside this day: compute exactly
}
/** Wall-clock components in `tz` -> UTC ms. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (tz === 'UTC') return guess;
  let t = guess - tzOffsetMemo(guess, tz);
  const off2 = tzOffsetMemo(t, tz);
  t = guess - off2;
  return t;
}

interface Local { y: number; mo: number; d: number; h: number; mi: number; s: number }

interface Prop { name: string; params: Record<string, string>; value: string }

function parseProp(line: string): Prop | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon).split(';');
  const params: Record<string, string> = {};
  for (const p of head.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: head[0].toUpperCase(), params, value: line.slice(colon + 1) };
}

interface When { local: Local; tz: string; utc: boolean; allDay: boolean; ms: number }

function parseWhen(p: Prop, calTz: string | null): When {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(p.value.trim());
  if (!m) throw new Error('bad date');
  const allDay = p.params.VALUE === 'DATE' || m[4] === undefined;
  const local: Local = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  const utc = m[7] === 'Z';
  const tz = utc ? 'UTC' : (p.params.TZID || (allDay ? calTz : null) || 'UTC');
  const ms = zonedToUtc(local.y, local.mo, local.d, local.h, local.mi, local.s, tz);
  return { local, tz, utc, allDay, ms };
}

function parseDuration(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const n = (x?: string) => Number(x ?? 0);
  const ms = (n(m[2]) * 7 + n(m[3])) * DAY + n(m[4]) * 3_600_000 + n(m[5]) * 60_000 + n(m[6]) * 1000;
  return m[1] === '-' ? -ms : ms;
}

// ── events ─────────────────────────────────────────────────────────────────────────────────────

interface Rule { freq: 'DAILY' | 'WEEKLY'; interval: number; wkst: number; byday: number[] | null; count: number | null; until: number | null }
export interface IcsEvent { start: When; durationMs: number; /** whole local days for an all-day event, so each occurrence ends at a local midnight across DST. */ days: number | null; rule: Rule | null; exdates: Set<number> }
export interface ParsedIcs { events: IcsEvent[]; skipped: number }

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

const RULE_KEYS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'WKST', 'COUNT', 'UNTIL']);

function parseRule(value: string, calTz: string | null): Rule | null {
  const kv: Record<string, string> = {};
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) kv[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  if (kv.FREQ !== 'DAILY' && kv.FREQ !== 'WEEKLY') return null;
  // Any clause this reader does not interpret (BYMONTH, BYMONTHDAY, BYSETPOS, …) would be dropped
  // silently and invent busy times, so the whole event is skipped instead.
  for (const key of Object.keys(kv)) if (!RULE_KEYS.has(key)) return null;
  const interval = kv.INTERVAL ? Number(kv.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;
  let byday: number[] | null = null;
  if (kv.BYDAY) {
    byday = [];
    for (const d of kv.BYDAY.split(',')) {
      if (!/^[A-Z]{2}$/.test(d) || WEEKDAYS[d] === undefined) return null; // ordinals like 1MO are not supported
      byday.push(WEEKDAYS[d]);
    }
  }
  const wkst = kv.WKST ? WEEKDAYS[kv.WKST.toUpperCase()] : 1; // week start, default Monday (RFC 5545)
  if (wkst === undefined) return null;
  const count = kv.COUNT ? Number(kv.COUNT) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  let until: number | null = null;
  if (kv.UNTIL) {
    const w = parseWhen({ name: 'UNTIL', params: {}, value: kv.UNTIL }, calTz);
    // A date-only UNTIL runs through the end of that day.
    until = w.allDay ? w.ms + DAY - 1 : w.ms;
  }
  return { freq: kv.FREQ, interval, wkst, byday, count, until };
}

export function parseIcs(text: string, now: number = Date.now()): ParsedIcs {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else lines.push(raw);
  }
  let calTz: string | null = null;
  for (const l of lines) {
    const p = l.startsWith('X-WR-TIMEZONE') ? parseProp(l) : null;
    if (p) { calTz = p.value.trim(); break; }
  }
  if (calTz) { try { tzOffset(0, calTz); } catch { calTz = null; } }

  const events: IcsEvent[] = [];
  const overrides = new Map<string, Set<number>>(); // uid -> RECURRENCE-ID instants replaced by their own VEVENT
  let skipped = 0;
  let cur: Prop[] | null = null;
  const pending: Array<{ props: Prop[] }> = [];
  for (const l of lines) {
    if (l.trim().toUpperCase() === 'BEGIN:VEVENT') cur = [];
    else if (l.trim().toUpperCase() === 'END:VEVENT') { if (cur) pending.push({ props: cur }); cur = null; }
    else if (cur) { const p = parseProp(l); if (p) cur.push(p); }
  }
  // A feed may not cost more than MAX_EVENTS events; the rest are counted, never read.
  if (pending.length > MAX_EVENTS) { skipped += pending.length - MAX_EVENTS; pending.length = MAX_EVENTS; }
  let recurring = 0;
  const horizon = MAX_YEARS_FROM_NOW * 365.25 * DAY;
  const events2: Array<{ uid: string; ev: IcsEvent; recId: boolean }> = [];
  for (const { props } of pending) {
    const get = (n: string) => props.find((p) => p.name === n);
    // Record the RECURRENCE-ID on the master FIRST: a cancelled or freed instance still replaces that
    // occurrence, so the master must not show it as busy.
    const uid = get('UID')?.value.trim() ?? '';
    const rid = get('RECURRENCE-ID');
    if (rid && uid) {
      try {
        const set = overrides.get(uid) ?? new Set<number>();
        set.add(parseWhen(rid, calTz).ms);
        overrides.set(uid, set);
      } catch { /* unreadable RECURRENCE-ID: nothing to replace */ }
    }
    if (get('STATUS')?.value.trim().toUpperCase() === 'CANCELLED') continue;
    if (get('TRANSP')?.value.trim().toUpperCase() === 'TRANSPARENT') continue;
    const ds = get('DTSTART');
    if (!ds) { skipped++; continue; }
    try {
      const start = parseWhen(ds, calTz);
      let durationMs: number;
      const de = get('DTEND');
      const dur = get('DURATION');
      if (de) durationMs = parseWhen(de, calTz).ms - start.ms;
      else if (dur) { const d = parseDuration(dur.value); if (d === null) throw new Error('bad duration'); durationMs = d; }
      else durationMs = start.allDay ? DAY : 0;
      if (!(durationMs > 0)) continue; // zero-length: not busy time (NaN lands here too)
      // An absurd length or a start/end that is not a sane date would poison every later calculation.
      const endMs = start.ms + durationMs;
      if (durationMs > MAX_EVENT_DAYS * DAY || !Number.isFinite(start.ms) || !Number.isFinite(endMs) ||
          Math.abs(start.ms - now) > horizon || Math.abs(endMs - now) > horizon) { skipped++; continue; }
      const rr = get('RRULE');
      let rule: Rule | null = null;
      if (rr) {
        rule = parseRule(rr.value, calTz);
        if (!rule || ++recurring > MAX_RECURRING) { skipped++; continue; }
      }
      const exdates = new Set<number>();
      for (const ex of props.filter((p) => p.name === 'EXDATE')) {
        for (const v of ex.value.split(',')) exdates.add(parseWhen({ ...ex, value: v }, calTz).ms);
      }
      events2.push({ uid, ev: { start, durationMs, days: start.allDay ? Math.max(1, Math.round(durationMs / DAY)) : null, rule, exdates }, recId: !!rid });
    } catch {
      skipped++;
    }
  }
  for (const { uid, ev, recId } of events2) {
    if (!recId && ev.rule && uid) for (const t of overrides.get(uid) ?? []) ev.exdates.add(t);
    events.push(ev);
  }
  return { events, skipped };
}

/** Busy windows [start,end) overlapping [from,to), sorted by start. */
export function busyWindows(parsed: ParsedIcs, from: number, to: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const ev of parsed.events) {
    const { start, rule } = ev;
    const push = (s: number, occDay?: Date) => {
      let e = s + ev.durationMs;
      if (ev.days !== null) {
        const dd = occDay ?? new Date(Date.UTC(start.local.y, start.local.mo - 1, start.local.d));
        const e0 = new Date(dd.getTime() + ev.days * DAY);
        e = zonedToUtc(e0.getUTCFullYear(), e0.getUTCMonth() + 1, e0.getUTCDate(), start.local.h, start.local.mi, start.local.s, start.tz);
      }
      if (!ev.exdates.has(s) && s < to && e > from) out.push({ start: s, end: e });
    };
    if (!rule) { push(start.ms); continue; }
    const base = Date.UTC(start.local.y, start.local.mo - 1, start.local.d); // the start's calendar day, as a UTC day number
    const startDow = new Date(base).getUTCDay();
    const dowOf = (i: number) => (startDow + i) % 7;
    const weekStartOf = (dayMs: number, dow: number) => dayMs - ((dow - rule.wkst + 7) % 7) * DAY;
    const weekZero = weekStartOf(base, startDow);
    // Days before `lo` cannot reach the window (an occurrence is at most a day and a half off its calendar day).
    const lo = from - ev.durationMs - 3 * DAY;
    let i = 0;
    if (rule.count === null) {
      // No COUNT to honour: start near the window instead of at DTSTART, aligned to INTERVAL (DAILY) / week arithmetic (WEEKLY).
      const first = Math.max(0, Math.floor((lo - base) / DAY));
      i = rule.freq === 'DAILY' ? first - (first % rule.interval) : first;
    }
    // COUNT counts occurrences from DTSTART, so that case still walks from day 0 — cheaply, with no zone work before `lo`.
    let n = 0;
    for (const last = i + MAX_ITER_DAYS; i < last; i++) {
      const dayMs = base + i * DAY;
      if (dayMs - 2 * DAY > to) break;
      const dow = dowOf(i);
      let match: boolean;
      if (rule.freq === 'DAILY') match = i % rule.interval === 0 && (!rule.byday || rule.byday.includes(dow));
      else {
        const weeks = Math.round((weekStartOf(dayMs, dow) - weekZero) / (7 * DAY));
        match = weeks % rule.interval === 0 && (rule.byday ? rule.byday.includes(dow) : dow === startDow);
      }
      if (!match) continue;
      n++;
      if (rule.count !== null && n > rule.count) break;
      if (dayMs < lo) continue;
      const d = new Date(dayMs);
      const s = start.utc || start.tz === 'UTC'
        ? dayMs + (start.ms - base)
        : zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), start.local.h, start.local.mi, start.local.s, start.tz);
      if (rule.until !== null && s > rule.until) break;
      push(s, d);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ── fetch + cache ──────────────────────────────────────────────────────────────────────────────

export interface CalendarView {
  linked: boolean;
  host: string | null;
  unreachable: boolean;
  /** epoch ms the current busy block ends, or null when not busy now. */
  busyUntil: number | null;
  next: { start: number; end: number } | null;
}

export const NOT_LINKED: CalendarView = { linked: false, host: null, unreachable: false, busyUntil: null, next: null };

interface Cache { url: string; attemptAt: number; goodAt: number | null; parsed: ParsedIcs | null; failing: boolean; warned: boolean; wins?: { parsed: ParsedIcs; at: number; list: Array<{ start: number; end: number }> } }

/** fetch over https with the connection pinned to already-checked addresses, so a second DNS answer cannot redirect it. */
function pinnedFetch(url: string, init: RequestInit, pinned: string[]): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const req = https.request({
      host,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      servername: isIP(host) ? undefined : host,
      signal: init.signal ?? undefined,
      lookup: (_h: string, opts: any, cb: any) => {
        if (opts?.all) cb(null, pinned.map((address) => ({ address, family: isIP(address) })));
        else cb(null, pinned[0], isIP(pinned[0]));
      },
    }, (res) => {
      const h = new Headers();
      for (const [k, val] of Object.entries(res.headers)) if (val !== undefined) h.set(k, Array.isArray(val) ? val.join(', ') : String(val));
      const status = res.statusCode ?? 0;
      const noBody = status === 204 || status === 205 || status === 304;
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : (Readable.toWeb(res) as any), { status, headers: h }));
    });
    req.on('error', reject);
    req.end();
  });
}

export class AwayCalendar {
  private cache: Cache | null = null;
  private readonly inflight = new Map<string, Promise<void>>(); // keyed by URL: a changed address never awaits the old download
  private readonly fetchImpl: (url: string, init: RequestInit, pinned: string[]) => Promise<Response>;
  private readonly now: () => number;
  private readonly lookup: HostLookup;
  private readonly timeoutMs: number;

  constructor(opts: { fetchImpl?: typeof fetch; now?: () => number; lookup?: HostLookup; timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl
      ? (u, i, pinned) => (opts.fetchImpl as any)(u, i, pinned) // a test double may inspect the pinned addresses
      : pinnedFetch;
    this.now = opts.now ?? (() => Date.now());
    this.lookup = opts.lookup ?? defaultLookup;
  }

  /** Reject a target that is not a public host: resolve it and refuse any private/loopback/metadata address. */
  private async assertPublic(url: string): Promise<string[]> {
    const u = new URL(validateIcsUrl(url));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [host] : await this.lookup(host);
    if (!addrs.length || addrs.some(isPrivateIp)) throw new Error('blocked host');
    return addrs;
  }

  /** The whole download, bounded: the deadline settles it even if the transport ignores the abort signal. */
  private download(startUrl: string): Promise<string> {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ctrl.abort(); reject(new Error('timeout')); }, this.timeoutMs);
    });
    const run = this.downloadInner(startUrl, ctrl);
    run.catch(() => undefined); // a late failure after the deadline won must not go unhandled
    return Promise.race([run, deadline]).finally(() => clearTimeout(timer));
  }

  private async downloadInner(startUrl: string, ctrl: AbortController): Promise<string> {
    {
      let url = startUrl;
      let res: Response | null = null;
      for (let hop = 0; hop <= 3; hop++) {
        const pinned = await this.assertPublic(url); // the connection below is pinned to exactly these checked addresses
        res = await this.fetchImpl(url, { signal: ctrl.signal, redirect: 'manual', headers: { accept: 'text/calendar, text/plain, */*' } }, pinned);
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers?.get?.('location');
          try { await res.body?.cancel(); } catch { /* ignore */ }
          if (!loc || hop === 3) throw new Error('bad redirect');
          url = new URL(loc, url).toString();
          continue;
        }
        break;
      }
      if (!res) throw new Error('no response');
      if (!res.ok) throw new Error(`status ${res.status}`);
      const len = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(len) && len > MAX_ICS_BYTES) throw new Error('too large');
      if (!res.body) {
        const t = await res.text();
        if (t.length > MAX_ICS_BYTES) throw new Error('too large');
        return t;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ICS_BYTES) { await reader.cancel().catch(() => undefined); throw new Error('too large'); }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    }
  }

  private async refresh(url: string): Promise<void> {
    const t = this.now();
    if (!this.cache || this.cache.url !== url) this.cache = { url, attemptAt: -Infinity, goodAt: null, parsed: null, failing: false, warned: false };
    const c = this.cache;
    const existing = this.inflight.get(url);
    if (existing) return existing; // an overlapping caller waits for the download already running
    if (t - c.attemptAt < REFETCH_MS) return; // the throttle only stops a NEW download from starting
    c.attemptAt = t;
    const job = (async () => {
      try {
        const body = await this.download(url);
        // A 200 that is not a calendar (a login page, an error page) is a failed fetch: keep the last good copy.
        if (!/^\s*BEGIN:VCALENDAR/i.test(body.replace(/^\uFEFF/, ''))) throw new Error('not a calendar');
        const parsed = parseIcs(body);
        c.parsed = parsed;
        c.goodAt = t;
        c.failing = false;
        if (parsed.skipped) logger.warn('AwayCalendar', 'calendar events skipped (unsupported or unreadable)', { skipped: parsed.skipped });
      } catch (err: any) {
        c.failing = true;
        // Only the error kind: a fetch error must never carry the secret address into the log.
        logger.warn('AwayCalendar', 'calendar fetch failed', { error: String(err?.name || 'Error') });
      } finally {
        this.inflight.delete(url);
      }
    })();
    this.inflight.set(url, job);
    return job;
  }

  /** The calendar as of now. Never throws. `url` null = not linked. */
  async view(url: string | null, signal?: AbortSignal): Promise<CalendarView> {
    if (!url) { this.cache = null; return NOT_LINKED; }
    try {
      // On abort, stop waiting and answer from the last good copy (the download carries on in the background).
      const job = this.refresh(url);
      if (signal) {
        await Promise.race([job, new Promise<void>((res) => { if (signal.aborted) res(); else signal.addEventListener('abort', () => res(), { once: true }); })]);
      } else await job;
    } catch { /* refresh never rejects; belt and braces */ }
    const c = this.cache;
    const host = hostOf(url);
    const t = this.now();
    // A relink while this call was awaiting replaced the shared cache: never answer with another calendar's data.
    if (!c || c.url !== url) return { linked: true, host, unreachable: true, busyUntil: null, next: null };
    if (!c.parsed || c.goodAt === null) return { linked: true, host, unreachable: true, busyUntil: null, next: null };
    const stale = t - c.goodAt > GRACE_MS;
    if (stale) return { linked: true, host, unreachable: true, busyUntil: null, next: null };
    // Windows are cached per parsed feed and recomputed at most once a minute; a throw is "unreachable", never an error.
    let wins: Array<{ start: number; end: number }>;
    try {
      if (c.wins && c.wins.parsed === c.parsed && t >= c.wins.at && t - c.wins.at < WINDOW_TTL_MS) wins = c.wins.list;
      else {
        wins = busyWindows(c.parsed, t - DAY, t + LOOKAHEAD_DAYS * DAY).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
        c.wins = { parsed: c.parsed, at: t, list: wins };
      }
    } catch {
      logger.warn('AwayCalendar', 'calendar windows failed');
      return { linked: true, host, unreachable: true, busyUntil: null, next: null };
    }
    let busyUntil: number | null = null;
    for (const w of wins) if (w.start <= t && w.end > t) busyUntil = Math.max(busyUntil ?? 0, w.end);
    // Merge back-to-back blocks so "until" is the real return time.
    if (busyUntil !== null) {
      let grew = true;
      while (grew) {
        grew = false;
        for (const w of wins) if (w.start <= busyUntil && w.end > busyUntil) { busyUntil = w.end; grew = true; }
      }
    }
    const after = busyUntil ?? t;
    const next = wins.find((w) => w.start > after) ?? null;
    return { linked: true, host, unreachable: c.failing, busyUntil, next: next ? { start: next.start, end: next.end } : null };
  }
}
