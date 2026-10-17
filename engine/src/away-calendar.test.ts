// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/away-calendar.test.ts
 * The linked away calendar: ICS parser, status precedence, secrecy of the address, fetch-failure grace. */
import './test-env.js';
import express from 'express';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const dir = mkdtempSync(join(tmpdir(), 'away-cal-'));
process.env.HOUSE_CONFIG_PATH = join(dir, 'no-such-house.json');
process.env.DISCORD_LOG_DIR = join(dir, 'logs');

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

const SECRET = 'https://calendar.example.com/ical/private-token-8f3a9c/basic.ics';
const wrap = (...events: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.map((e) => `BEGIN:VEVENT\r\n${e}\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`;
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-14T10:00:00Z');

async function run() {
  const { parseIcs, busyWindows, AwayCalendar: RealCal, validateIcsUrl, isPrivateIp, GRACE_MS, REFETCH_MS } = await import('./away-calendar.js');
  const { LocalSettingsStore } = await import('./seams/local-settings-store.js');
  const { createDashboardRouter } = await import('./dashboard/routes.js');
  const { fetchAwayStatus } = await import('./away-status.js');
  const pub = async (h: string) => (h === 'internal.example.com' ? ['10.0.0.5'] : ['93.184.216.34']);
  const AwayCalendar = class extends RealCal { constructor(o: any = {}) { super({ lookup: pub, ...o }); } } as typeof RealCal;
  const win = (text: string, from = T0 - 30 * 86_400_000, to = T0 + 40 * 86_400_000) => busyWindows(parseIcs(text), from, to);

  // --- parser ---
  let w = win(wrap('UID:a\r\nDTSTART:20261014T093000Z\r\nDTEND:20261014T103000Z\r\nSUMMARY:Secret title'));
  ok('timed UTC event', w.length === 1 && iso(w[0].start) === '2026-10-14T09:30:00.000Z' && iso(w[0].end) === '2026-10-14T10:30:00.000Z');
  w = win(wrap('UID:b\r\nDTSTART;TZID=America/New_York:20261014T090000\r\nDTEND;TZID=America/New_York:20261014T100000'));
  ok('TZID local time (EDT = UTC-4)', iso(w[0].start) === '2026-10-14T13:00:00.000Z' && iso(w[0].end) === '2026-10-14T14:00:00.000Z');
  w = win(wrap('UID:c\r\nDTSTART;VALUE=DATE:20261015\r\nDTEND;VALUE=DATE:20261016'));
  ok('all-day DATE event', w.length === 1 && iso(w[0].start) === '2026-10-15T00:00:00.000Z' && iso(w[0].end) === '2026-10-16T00:00:00.000Z');
  w = win(wrap('UID:c2\r\nDTSTART;VALUE=DATE:20261015'));
  ok('all-day with no end lasts one day', w.length === 1 && w[0].end - w[0].start === 86_400_000);
  w = win(wrap('UID:d\r\nDTSTART;TZID=Europe/Berlin:20261005T100000\r\nDTEND;TZID=Europe/Berlin:20261005T110000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE'));
  const starts = w.map((x) => iso(x.start));
  ok('weekly BYDAY expands', starts.includes('2026-10-05T08:00:00.000Z') && starts.includes('2026-10-07T08:00:00.000Z') && starts.includes('2026-10-14T08:00:00.000Z'));
  ok('weekly keeps local wall time across DST', starts.includes('2026-10-26T09:00:00.000Z') && starts.includes('2026-10-21T08:00:00.000Z'));
  w = win(wrap('UID:e\r\nDTSTART:20261012T080000Z\r\nDTEND:20261012T090000Z\r\nRRULE:FREQ=DAILY;COUNT=3'));
  ok('daily COUNT', w.length === 3 && iso(w[2].start) === '2026-10-14T08:00:00.000Z');
  w = win(wrap('UID:f\r\nDTSTART:20261012T080000Z\r\nDTEND:20261012T090000Z\r\nRRULE:FREQ=DAILY;UNTIL=20261014T000000Z'));
  ok('daily UNTIL', w.length === 2);
  w = win(wrap('UID:g\r\nDTSTART:20261012T080000Z\r\nDTEND:20261012T090000Z\r\nRRULE:FREQ=WEEKLY;INTERVAL=2'));
  ok('weekly INTERVAL=2', w.length >= 3 && w[1].start - w[0].start === 14 * 86_400_000);
  w = win(wrap('UID:h\r\nDTSTART:20261012T080000Z\r\nDTEND:20261012T090000Z\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEXDATE:20261013T080000Z'));
  ok('EXDATE removes an instance', w.length === 3 && !w.some((x) => iso(x.start).startsWith('2026-10-13')));
  w = win(wrap('UID:i\r\nDTSTART:20261014T080000Z\r\nDTEND:20261014T090000Z\r\nSTATUS:CANCELLED'));
  ok('cancelled is ignored', w.length === 0);
  w = win(wrap('UID:j\r\nDTSTART:20261014T080000Z\r\nDTEND:20261014T090000Z\r\nTRANSP:TRANSPARENT'));
  ok('transparent (free) is ignored', w.length === 0);
  // recurring all-day across the US fall-back (2026-11-01): each occurrence ends at the next local midnight
  w = win(wrap('UID:dst\r\nDTSTART;TZID=America/New_York;VALUE=DATE:20261031\r\nDTEND;TZID=America/New_York;VALUE=DATE:20261101\r\nRRULE:FREQ=DAILY;COUNT=3'));
  ok('all-day recurring ends at local midnight over DST fall-back',
    w.length === 3 && iso(w[0].end) === '2026-11-01T04:00:00.000Z' && iso(w[1].start) === '2026-11-01T04:00:00.000Z' && iso(w[1].end) === '2026-11-02T05:00:00.000Z' && iso(w[2].start) === '2026-11-02T05:00:00.000Z');
  let p = parseIcs(wrap('UID:k\r\nDTSTART:20261014T080000Z\r\nDTEND:20261014T090000Z\r\nRRULE:FREQ=MONTHLY', 'UID:l\r\nDTSTART;TZID=Not/AZone:20261014T080000\r\nDTEND;TZID=Not/AZone:20261014T090000'));
  ok('unsupported RRULE and unknown zone are skipped and counted', p.skipped === 2 && p.events.length === 0);
  w = win('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:m\r\nDTSTART:20261014T08\r\n 0000Z\r\nDTEND:20261014T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
  ok('folded lines are unfolded', w.length === 1);

  // --- address validation ---
  for (const bad of ['http://calendar.example.com/x.ics', 'https://localhost/x', 'https://127.0.0.1/x', 'ftp://a.b/c', 'not a url', '', 'https://a.example/' + 'x'.repeat(2000)]) {
    let threw = false; try { validateIcsUrl(bad); } catch { threw = true; }
    ok(`rejects ${bad.slice(0, 30) || '(empty)'}`, threw);
  }
  ok('accepts an https calendar address', validateIcsUrl('  ' + SECRET + ' ') === SECRET);

  // --- fetch cache, failure, grace ---
  let nowMs = T0;
  let mode: 'ok' | 'fail' = 'ok';
  let fetches = 0;
  const feed = wrap('UID:z\r\nDTSTART:20261014T093000Z\r\nDTEND:20261014T103000Z\r\nSUMMARY:Dentist', 'UID:y\r\nDTSTART:20261014T103000Z\r\nDTEND:20261014T113000Z', 'UID:x\r\nDTSTART:20261015T080000Z\r\nDTEND:20261015T090000Z');
  const fake = (async () => {
    fetches++;
    if (mode === 'fail') throw Object.assign(new Error(`connect failed for ${SECRET}`), { name: 'TypeError' });
    return new Response(feed, { status: 200, headers: { 'content-type': 'text/calendar' } });
  }) as unknown as typeof fetch;
  const cal = new AwayCalendar({ fetchImpl: fake, now: () => nowMs });
  let v = await cal.view(SECRET);
  ok('busy now: until merges back-to-back blocks', v.linked && v.busyUntil === Date.parse('2026-10-14T11:30:00Z') && !v.unreachable && v.host === 'calendar.example.com');
  ok('next block is reported', v.next?.start === Date.parse('2026-10-15T08:00:00Z'));
  nowMs += 5 * 60_000; await cal.view(SECRET);
  ok('fetched at most every 10 minutes', fetches === 1);
  nowMs += REFETCH_MS; mode = 'fail';
  v = await cal.view(SECRET);
  ok('fetch failure keeps the last good copy, flagged unreachable', fetches === 2 && v.unreachable && v.linked);
  ok('last good copy still answers', cal && (await cal.view(SECRET)).host === 'calendar.example.com');
  nowMs = T0 + GRACE_MS + 60_000; v = await cal.view(SECRET);
  ok('after 6 hours the calendar is ignored (not busy) and unreachable', v.unreachable && v.busyUntil === null && v.next === null);
  mode = 'ok'; nowMs += REFETCH_MS; v = await cal.view(SECRET);
  ok('recovers when the feed returns', !v.unreachable);
  const big = new AwayCalendar({ fetchImpl: (async () => new Response('x'.repeat(2 * 1024 * 1024 + 10))) as any, now: () => T0 });
  ok('over 2MB is refused', (await big.view(SECRET)).unreachable);
  ok('unlinked is not linked', !(await cal.view(null)).linked);


  // --- review fixes ---
  w = win(wrap('UID:r1\r\nDTSTART:20261012T080000Z\r\nDTEND:20261012T090000Z\r\nRRULE:FREQ=DAILY;COUNT=4', 'UID:r1\r\nRECURRENCE-ID:20261013T080000Z\r\nDTSTART:20261013T080000Z\r\nDTEND:20261013T090000Z\r\nSTATUS:CANCELLED'));
  ok('cancelled instance (RECURRENCE-ID, no EXDATE) frees that day', w.length === 3 && !w.some((x) => iso(x.start).startsWith('2026-10-13')));
  w = win(wrap('UID:r2\r\nDTSTART:20261012T080000Z\r\nDTEND:20261012T090000Z\r\nRRULE:FREQ=DAILY;COUNT=4', 'UID:r2\r\nRECURRENCE-ID:20261013T080000Z\r\nDTSTART:20261013T080000Z\r\nDTEND:20261013T090000Z\r\nTRANSP:TRANSPARENT'));
  ok('freed (transparent) instance frees that day', w.length === 3 && !w.some((x) => iso(x.start).startsWith('2026-10-13')));
  w = win(wrap('UID:r3\r\nDTSTART:20261012T080000Z\r\nDTEND:20261012T090000Z\r\nRRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=5'));
  ok('DAILY with BYDAY skips weekends, COUNT counts matching days', w.length === 5 && !w.some((x) => [0, 6].includes(new Date(x.start).getUTCDay())) && iso(w[4].start) === '2026-10-16T08:00:00.000Z');
  ok('private ranges recognised', ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', 'fd00::1', '::ffff:127.0.0.1'].every(isPrivateIp) && !isPrivateIp('93.184.216.34'));
  {
    let calls = 0;
    const urls: string[] = [];
    const redir = (loc: string) => (async (u: any) => { calls++; urls.push(String(u)); return new Response(null, { status: 302, headers: { location: loc } }); }) as any;
    const c1 = new AwayCalendar({ fetchImpl: redir('http://169.254.169.254/latest/meta-data'), now: () => T0 });
    ok('redirect to metadata IP is not followed', (await c1.view(SECRET)).unreachable && calls === 1);
    const c2 = new AwayCalendar({ fetchImpl: redir('https://internal.example.com/x.ics'), now: () => T0 });
    calls = 0;
    ok('redirect to a host resolving private is not followed', (await c2.view(SECRET)).unreachable && calls === 1);
    const c3 = new AwayCalendar({ fetchImpl: (async () => { calls++; return new Response(feed); }) as any, now: () => T0 });
    calls = 0;
    ok('a link whose host resolves to a private address is never fetched', (await c3.view('https://internal.example.com/a.ics')).unreachable && calls === 0);
  }
  {
    // changing the URL mid-refresh does not await (or read) the old download
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const seen: string[] = [];
    const c4 = new AwayCalendar({ now: () => T0, fetchImpl: (async (u: any) => { seen.push(String(u)); if (String(u).includes('old')) await gate; return new Response(feed); }) as any });
    const oldP = c4.view('https://calendar.example.com/old.ics');
    await new Promise((r) => setTimeout(r, 10));
    const nv = await c4.view('https://calendar.example.com/new.ics');
    ok('new URL fetched on its own, not shown unreachable', seen.some((x) => x.includes('new')) && !nv.unreachable && nv.busyUntil !== null);
    release();
    const ov = await oldP;
    ok('old URL view never returns the new calendar data after a relink', ov.host === 'calendar.example.com' && ov.busyUntil === null && ov.unreachable);
  }
  {
    // an aborted caller does not wait for a slow download
    const c5 = new AwayCalendar({ now: () => T0, timeoutMs: 150, fetchImpl: (() => new Promise(() => undefined)) as any });
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 30);
    const av = await c5.view(SECRET, ac.signal);
    ok('abort returns promptly with a not-busy view', Date.now() - t0 < 2000 && av.busyUntil === null);
    const store2 = new LocalSettingsStore(join(dir, 'settings2.json'), () => T0, c5);
    await store2.setAwayCalendar(SECRET);
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 30);
    const t1 = Date.now();
    const resp = await store2.getAwayStatus(ac2.signal);
    ok('getAwayStatus honours the abort signal', Date.now() - t1 < 2000 && ((await resp.json()) as any).away === false);
  }

  // --- grok review fixes ---
  {
    // overlapping reads during a cold download all wait for it (page load fires three)
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    const slow = new AwayCalendar({ now: () => T0, fetchImpl: (async () => { n++; await gate; return new Response(feed); }) as any });
    const reads = [slow.view(SECRET), slow.view(SECRET), slow.view(SECRET)];
    await new Promise((r) => setTimeout(r, 10));
    release();
    const vs = await Promise.all(reads);
    ok('overlapping views all await the one download, none reads as not away', n === 1 && vs.every((x) => !x.unreachable && x.busyUntil !== null));
  }
  {
    // a 200 that is not a calendar keeps the last good copy
    let html = false;
    let tNow = T0;
    const c6 = new AwayCalendar({ now: () => tNow, fetchImpl: (async () => new Response(html ? '<html><body>Sign in</body></html>' : feed)) as any });
    await c6.view(SECRET);
    html = true; tNow += REFETCH_MS;
    const hv = await c6.view(SECRET);
    ok('non-calendar 200 is a failure: last good copy kept, flagged unreachable', hv.unreachable && hv.busyUntil !== null || (hv.unreachable && hv.linked && hv.next !== null));
    const c7 = new AwayCalendar({ now: () => T0, fetchImpl: (async () => new Response('<html>login</html>')) as any });
    ok('non-calendar 200 on first fetch is unreachable, not free', (await c7.view(SECRET)).unreachable);
  }
  {
    // the connection is pinned to the addresses that were checked
    let pinnedSeen: string[] | null = null;
    const c8 = new AwayCalendar({ now: () => T0, fetchImpl: (async (_u: any, _i: any, pinned: string[]) => { pinnedSeen = pinned; return new Response(feed); }) as any });
    await c8.view(SECRET);
    ok('fetch is pinned to the checked public addresses', JSON.stringify(pinnedSeen) === JSON.stringify(['93.184.216.34']));
    let answers = 0;
    const flip = new AwayCalendar({ now: () => T0, lookup: async () => (answers++ === 0 ? ['93.184.216.34'] : ['10.0.0.5']), fetchImpl: (async (_u: any, _i: any, pinned: string[]) => { pinnedSeen = pinned; return new Response(feed); }) as any });
    await flip.view(SECRET);
    ok('a later DNS answer cannot change the address used', answers === 1 && JSON.stringify(pinnedSeen) === JSON.stringify(['93.184.216.34']));
  }
  ok('6to4, Teredo, IPv4-compatible and mapped-hex forms are classified', [
    '2002:7f00:0001::1', '2002:0a00:0001::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '::127.0.0.1', '::7f00:1', '::10.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a00:1', '64:ff9b::7f00:1', 'fe80::1', 'ff02::1',
  ].every(isPrivateIp) && ['2002:5db8:d822::1', '2606:4700:4700::1111', '::ffff:93.184.216.34', '::ffff:5db8:d822'].every((x) => !isPrivateIp(x) || x === '::ffff:5db8:d822' && false));
  w = win(wrap('UID:wk\r\nDTSTART:20261011T080000Z\r\nDTEND:20261011T090000Z\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU'));
  {
    const days = w.map((x) => iso(x.start).slice(0, 10));
    ok('WKST=SU biweekly puts Sun+Mon in the same week', days.slice(0, 4).join() === '2026-10-11,2026-10-12,2026-10-25,2026-10-26');
  }
  w = win(wrap('UID:wk2\r\nDTSTART:20261011T080000Z\r\nDTEND:20261011T090000Z\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO'));
  ok('default week start stays Monday', w.slice(0, 3).map((x) => iso(x.start).slice(0, 10)).join() === '2026-10-11,2026-10-19,2026-10-25');
  p = parseIcs(wrap('UID:wk3\r\nDTSTART:20261011T080000Z\r\nDTEND:20261011T090000Z\r\nRRULE:FREQ=WEEKLY;WKST=XX'));
  ok('unknown WKST is skipped and counted', p.skipped === 1);
  for (const clause of ['BYMONTH=2', 'BYMONTHDAY=15', 'BYSETPOS=-1']) {
    p = parseIcs(wrap(`UID:rk\r\nDTSTART:20260105T080000Z\r\nDTEND:20260105T090000Z\r\nRRULE:FREQ=DAILY;${clause};COUNT=3`));
    ok(`a rule with ${clause.split('=')[0]} is skipped, never guessed`, p.skipped === 1 && p.events.length === 0);
  }

  // --- store: precedence + secrecy ---
  nowMs = T0; mode = 'ok';
  const store = new LocalSettingsStore(join(dir, 'settings.json'), () => nowMs, new AwayCalendar({ fetchImpl: fake, now: () => nowMs }));
  const st = async () => (await (await store.getAwayStatus()).json()) as any;
  ok('no calendar: not away', (await st()).away === false);
  const linked = await store.setAwayCalendar(SECRET);
  ok('link returns host only', linked.linked && linked.host === 'calendar.example.com' && !JSON.stringify(linked).includes('private-token'));
  let s = await st();
  ok('calendar busy now: away, source calendar, no reason', s.away && s.source === 'calendar' && s.reason === '' && s.until === '2026-10-14T11:30:00.000Z' && s.until_label === '18:30');
  ok('event title never in status', !JSON.stringify(s).includes('Dentist'));
  await store.updateDocument((d) => ({ ...d, away: { ...d.away, active: true, reason: 'trip', until: null } }));
  s = await st();
  ok('manual override wins over calendar', s.away && s.source === 'local' && s.reason === 'trip');
  await store.updateDocument((d) => ({ ...d, away: { ...d.away, active: false } }));
  nowMs = Date.parse('2026-10-14T13:00:00Z');
  ok('calendar free: not away', (await st()).away === false);
  nowMs = T0;
  const guest = await fetchAwayStatus('http://x', 't', store);
  ok('guest-facing status has no reason and is away', !!guest && guest.away && guest.reason === '' && guest.source === 'calendar');
  await store.updateDocument((d) => d);
  ok('page saves keep the link', (await store.getAwayCalendar()).linked);
  ok('unlink', !(await store.setAwayCalendar(null)).linked && (await st()).away === false);

  // --- API: the address goes in, never comes out ---
  await store.setAwayCalendar(null);
  const env: Record<string, string | undefined> = { DASHBOARD_PASSWORD: 'hunter2' };
  const app = express();
  app.use('/settings', createDashboardRouter({ settingsStore: store, plugs: { model: 'direct', settings: 'local', memory: 'off' }, env: env as any, now: () => nowMs }));
  const srv = await new Promise<any>((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/settings`;
  const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })(), headers: r.headers };
  };
  const login = await call('POST', '/api/login', { password: 'hunter2' });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  ok('calendar routes need login', (await call('GET', '/api/away-calendar')).status === 401);
  let r = await call('PUT', '/api/away-calendar', { ics_url: 'http://insecure.example.com/x.ics' }, cookie);
  ok('http address rejected, address not echoed', r.status === 400 && !r.text.includes('insecure'));
  r = await call('PUT', '/api/away-calendar', { ics_url: SECRET }, cookie);
  ok('link via API returns only linked + host', r.status === 200 && r.json.linked === true && r.json.host === 'calendar.example.com' && !r.text.includes('private-token') && !('ics_url' in r.json));
  r = await call('GET', '/api/away-calendar', undefined, cookie);
  ok('GET never returns the address; busy_now is present', r.status === 200 && !r.text.includes('private-token') && r.json.busy_now?.until === '2026-10-14T11:30:00.000Z');
  r = await call('GET', '/api/settings', undefined, cookie);
  ok('settings document never carries the address', r.status === 200 && !r.text.includes('private-token') && !r.text.includes('calendar.example.com'));
  r = await call('PUT', '/api/settings', { away: { active: true, reason: 'x'.repeat(1001) } }, cookie);
  ok('away reason over 1000 rejected', r.status === 400);
  r = await call('PUT', '/api/settings', { away: { active: true, reason: 'trip', until: '2026-10-14T12:00:00.000Z', reason_shareable: false } }, cookie);
  ok('away override write accepted', r.status === 200 && r.json.away.active && r.json.away.reason === 'trip' && r.json.away.reason_shareable === false);
  r = await call('PUT', '/api/away-calendar', { ics_url: null }, cookie);
  ok('unlink via API', r.status === 200 && r.json.linked === false);
  srv.close();
  {
    const { statSync } = await import('node:fs');
    const f = join(dir, 'perm-settings.json');
    const old = process.umask(0o022);
    try {
      const ps = new LocalSettingsStore(f, () => T0, new AwayCalendar({ fetchImpl: fake, now: () => nowMs }));
      await ps.setAwayCalendar(SECRET);
      await ps.setAwayCalendar(SECRET);
      ok('settings file is owner-only (0600) after writes', (statSync(f).mode & 0o777) === 0o600);
    } finally { process.umask(old); }
  }

  // --- security: cost caps, near-window iteration, offset memo ---
  {
    const DAYMS = 86_400_000;
    // Hostile feed: 200 recurring events from 1970 in a DST zone must not stall the loop.
    const hostile = wrap(...Array.from({ length: 200 }, (_, i) => `UID:h${i}\r\nDTSTART;TZID=America/New_York:19700101T090000\r\nDTEND;TZID=America/New_York:19700101T100000\r\nRRULE:FREQ=DAILY`));
    const hp = parseIcs(hostile);
    const t0 = performance.now();
    const hw = busyWindows(hp, T0 - DAYMS, T0 + 14 * DAYMS);
    const took = performance.now() - t0;
    ok(`hostile 200-event feed computes in < 500 ms (${Math.round(took)} ms)`, took < 500 && hw.length > 0);
    // Caps: 2,100 events -> 2,000 kept at most; 250 recurring -> 200 kept, the rest skipped.
    const many = parseIcs(wrap(...Array.from({ length: 2100 }, (_, i) => `UID:m${i}\r\nDTSTART:20261014T080000Z\r\nDTEND:20261014T090000Z`)));
    ok('events per feed capped at 2000, rest counted skipped', many.events.length === 2000 && many.skipped === 100);
    const rec = parseIcs(wrap(...Array.from({ length: 250 }, (_, i) => `UID:q${i}\r\nDTSTART:20261014T080000Z\r\nDTEND:20261014T090000Z\r\nRRULE:FREQ=DAILY`)));
    ok('recurring events per feed capped at 200, rest counted skipped', rec.events.length === 200 && rec.skipped === 50);
    // Large COUNT from far back stays cheap (cheap walk, no zone work before the window).
    const bigCount = parseIcs(wrap(...Array.from({ length: 200 }, (_, i) => `UID:c${i}\r\nDTSTART;TZID=America/New_York:20000101T090000\r\nDTEND;TZID=America/New_York:20000101T100000\r\nRRULE:FREQ=DAILY;COUNT=999999999`)));
    const t1 = performance.now(); busyWindows(bigCount, T0 - DAYMS, T0 + 14 * DAYMS);
    ok('hostile COUNT feed also < 500 ms', performance.now() - t1 < 500);

    // Brute-force reference: walk every day from DTSTART (the pre-fix algorithm) with an independent zone helper.
    const dtfRef = (tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    const wall = (y: number, mo: number, d: number, h: number, mi: number, tz: string) => {
      if (tz === 'UTC') return Date.UTC(y, mo - 1, d, h, mi);
      const f = dtfRef(tz);
      const off = (ts: number) => { const q = f.formatToParts(new Date(ts)); const g = (t: string) => Number(q.find((x) => x.type === t)!.value); return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - ts; };
      const guess = Date.UTC(y, mo - 1, d, h, mi);
      return guess - off(guess - off(guess));
    };
    const brute = (text: string, from: number, to: number) => {
      const ev = parseIcs(text).events[0];
      const r = ev.rule!;
      const base = Date.UTC(ev.start.local.y, ev.start.local.mo - 1, ev.start.local.d);
      const sdow = new Date(base).getUTCDay();
      const wk = (ms: number) => ms - ((new Date(ms).getUTCDay() - r.wkst + 7) % 7) * DAYMS;
      const out: number[] = [];
      let n = 0;
      for (let i = 0; i < 20_000; i++) {
        const dayMs = base + i * DAYMS;
        if (dayMs - 2 * DAYMS > to) break;
        const dow = new Date(dayMs).getUTCDay();
        const match = r.freq === 'DAILY' ? i % r.interval === 0 && (!r.byday || r.byday.includes(dow))
          : Math.round((wk(dayMs) - wk(base)) / (7 * DAYMS)) % r.interval === 0 && (r.byday ? r.byday.includes(dow) : dow === sdow);
        if (!match) continue;
        n++;
        if (r.count !== null && n > r.count) break;
        const d = new Date(dayMs);
        const s = wall(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), ev.start.local.h, ev.start.local.mi, ev.start.tz);
        if (r.until !== null && s > r.until) break;
        if (s < to && s + ev.durationMs > from) out.push(s);
      }
      return out;
    };
    const cases: Array<[string, string, number, number]> = [
      ['DAILY from 2019', 'DTSTART:20190103T080000Z\r\nDTEND:20190103T090000Z\r\nRRULE:FREQ=DAILY', T0 - DAYMS, T0 + 14 * DAYMS],
      ['DAILY INTERVAL=2', 'DTSTART:20190103T080000Z\r\nDTEND:20190103T090000Z\r\nRRULE:FREQ=DAILY;INTERVAL=2', T0 - DAYMS, T0 + 14 * DAYMS],
      ['DAILY INTERVAL=3 odd offset', 'DTSTART:20200229T230000Z\r\nDTEND:20200301T010000Z\r\nRRULE:FREQ=DAILY;INTERVAL=3', T0 - 2 * DAYMS, T0 + 20 * DAYMS],
      ['DAILY BYDAY list', 'DTSTART:20190103T080000Z\r\nDTEND:20190103T090000Z\r\nRRULE:FREQ=DAILY;BYDAY=MO,WE,FR', T0, T0 + 30 * DAYMS],
      ['WEEKLY', 'DTSTART:20190103T080000Z\r\nDTEND:20190103T090000Z\r\nRRULE:FREQ=WEEKLY', T0 - DAYMS, T0 + 30 * DAYMS],
      ['WEEKLY INTERVAL=2 BYDAY list', 'DTSTART:20190104T080000Z\r\nDTEND:20190104T090000Z\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', T0 - DAYMS, T0 + 40 * DAYMS],
      ['WEEKLY WKST=SU INTERVAL=2 BYDAY=SU,TU', 'DTSTART:20190106T080000Z\r\nDTEND:20190106T090000Z\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=SU,TU', T0 - DAYMS, T0 + 40 * DAYMS],
      ['WEEKLY WKST=MO INTERVAL=2 BYDAY=SU,TU', 'DTSTART:20190106T080000Z\r\nDTEND:20190106T090000Z\r\nRRULE:FREQ=WEEKLY;INTERVAL=2;WKST=MO;BYDAY=SU,TU', T0 - DAYMS, T0 + 40 * DAYMS],
      ['WEEKLY with UNTIL', 'DTSTART:20190103T080000Z\r\nDTEND:20190103T090000Z\r\nRRULE:FREQ=WEEKLY;UNTIL=20261020T000000Z', T0 - DAYMS, T0 + 40 * DAYMS],
      ['DAILY COUNT reaches into window', 'DTSTART:20261001T080000Z\r\nDTEND:20261001T090000Z\r\nRRULE:FREQ=DAILY;COUNT=20', T0 - DAYMS, T0 + 40 * DAYMS],
      ['DAILY NY across DST end (2026-11-01)', 'DTSTART;TZID=America/New_York:20190103T090000\r\nDTEND;TZID=America/New_York:20190103T100000\r\nRRULE:FREQ=DAILY', Date.parse('2026-10-28T00:00:00Z'), Date.parse('2026-11-06T00:00:00Z')],
      ['WEEKLY Berlin across DST end (2026-10-25)', 'DTSTART;TZID=Europe/Berlin:20190103T100000\r\nDTEND;TZID=Europe/Berlin:20190103T110000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,TH', Date.parse('2026-10-19T00:00:00Z'), Date.parse('2026-11-05T00:00:00Z')],
      ['DAILY INTERVAL=2 NY across DST start (2026-03-08)', 'DTSTART;TZID=America/New_York:20190103T020000\r\nDTEND;TZID=America/New_York:20190103T033000\r\nRRULE:FREQ=DAILY;INTERVAL=2', Date.parse('2026-03-01T00:00:00Z'), Date.parse('2026-03-15T00:00:00Z')],
    ];
    for (const [name, body, from, to] of cases) {
      const text = wrap(`UID:ref\r\n${body}`);
      const got = busyWindows(parseIcs(text), from, to).map((x) => x.start);
      const want = brute(text, from, to);
      ok(`matches brute force: ${name} (${want.length} occurrences)`, want.length > 0 && JSON.stringify(got) === JSON.stringify(want));
    }

    // Finding 2: absurd lengths and dates are rejected, never reach toISOString.
    const NOW = Date.now();
    const huge = parseIcs(wrap('UID:big\r\nDTSTART:20200101T000000Z\r\nDURATION:P99999999999999W'), NOW);
    ok('huge DURATION is skipped and counted', huge.events.length === 0 && huge.skipped === 1);
    const hugeAllDay = parseIcs(wrap('UID:big2\r\nDTSTART;VALUE=DATE:20261015\r\nDURATION:P99999999999999W\r\nRRULE:FREQ=DAILY', 'UID:big3\r\nDTSTART;VALUE=DATE:20261015\r\nDTEND;VALUE=DATE:99991231'), NOW);
    ok('all-day events with huge DURATION / DTEND are skipped', hugeAllDay.events.length === 0 && hugeAllDay.skipped === 2);
    ok('a duration over 366 days is skipped, 366 days is kept',
      parseIcs(wrap('UID:d1\r\nDTSTART:20261015T000000Z\r\nDURATION:P367D'), NOW).skipped === 1 && parseIcs(wrap('UID:d2\r\nDTSTART:20261015T000000Z\r\nDURATION:P366D'), NOW).events.length === 1);
    ok('a start more than 100 years from now is skipped', parseIcs(wrap('UID:far\r\nDTSTART:19000101T000000Z\r\nDTEND:19000101T010000Z', 'UID:far2\r\nDTSTART:29990101T000000Z\r\nDTEND:29990101T010000Z'), NOW).skipped === 2);
    const hugeFeed = wrap('UID:big\r\nDTSTART:20200101T000000Z\r\nDURATION:P99999999999999W', 'UID:ok\r\nDTSTART:20261014T093000Z\r\nDTEND:20261014T103000Z');
    const hugeFeedAllDay = 'BEGIN:VCALENDAR\r\nX-WR-TIMEZONE:Asia/Jakarta\r\n' + wrap('UID:big\r\nDTSTART;VALUE=DATE:20261014\r\nDURATION:P99999999999999W').replace('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n', '');
    for (const [label, feedText] of [['DURATION probe', hugeFeed], ['all-day + X-WR-TIMEZONE probe', hugeFeedAllDay]] as const) {
      const hc = new AwayCalendar({ fetchImpl: (async () => new Response(feedText, { status: 200 })) as any, now: () => T0 });
      let threw = false; let hv: any = null;
      try { hv = await hc.view(SECRET); } catch { threw = true; }
      ok(`view() never throws: ${label}`, !threw && hv && Number.isFinite(hv.busyUntil ?? 0));
      const hs = new LocalSettingsStore(join(dir, `huge-${label.length}.json`), () => T0, hc);
      let sthrew = false; let sv: any = null;
      try { await hs.setAwayCalendar(SECRET); sv = await hs.getAwayCalendar(); JSON.stringify(sv); } catch { sthrew = true; }
      ok(`settings store survives the ${label}`, !sthrew && sv?.linked === true);
    }
    // busyWindows throwing inside view() -> unreachable, not an exception.
    const bomb = new AwayCalendar({ fetchImpl: (async () => new Response(wrap('UID:k\r\nDTSTART:20261014T080000Z\r\nDTEND:20261014T090000Z\r\nRRULE:FREQ=DAILY'), { status: 200 })) as any, now: () => T0 });
    (bomb as any).refresh = async () => { (bomb as any).cache = { url: SECRET, attemptAt: T0, goodAt: T0, parsed: { events: [{ start: null, durationMs: 1, days: null, rule: { freq: 'DAILY', interval: 1, wkst: 1, byday: null, count: null, until: null }, exdates: new Set() }], skipped: 0 }, failing: false, warned: false }; };
    let bthrew = false; let bv: any = null;
    try { bv = await bomb.view(SECRET); } catch { bthrew = true; }
    ok('view() returns unreachable when window computation throws', !bthrew && bv?.unreachable === true && bv.busyUntil === null);

    // Window cache: computed once per minute per parse.
    let fcalls = 0;
    let cn = T0;
    const cc = new AwayCalendar({ fetchImpl: (async () => { fcalls++; return new Response(feed, { status: 200 }); }) as any, now: () => cn });
    await cc.view(SECRET);
    const cached = (cc as any).cache.wins;
    await cc.view(SECRET); cn += 30_000; await cc.view(SECRET);
    ok('busy windows are cached within a minute', (cc as any).cache.wins === cached);
    cn += 40_000; await cc.view(SECRET);
    ok('busy windows are recomputed after a minute', (cc as any).cache.wins !== cached && fcalls === 1);
  }

  // --- logs never hold the address ---
  const logDir = process.env.DISCORD_LOG_DIR!;
  let logs = '';
  try { for (const f of readdirSync(logDir)) logs += readFileSync(join(logDir, f), 'utf8'); } catch { /* no logs written */ }
  ok('failures were logged', logs.includes('calendar fetch failed'));
  ok('logs never contain the address', !logs.includes('private-token') && !logs.includes(SECRET));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
