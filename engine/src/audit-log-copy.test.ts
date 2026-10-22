// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Copying the audit log: mapping, paging, batching, off at 0, and the failure DM throttle.
 * Run: npx tsx src/audit-log-copy.test.ts
 */
import './test-env.js';
import {
  chunk, mapAuditPage, auditFailureNotice, runAuditCopy, FAILURE_DM_INTERVAL_MS, actionName, runAuditCopyOnce,
  snowflakeToIso, startAuditCopy, type AuditCopyDeps,
} from './audit-log-copy.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } }

const maps = { channels: new Map([['300', 'general']]), roles: new Map([['400', 'Members']]) };
const id = (n: number) => String(1000000000000000000n + BigInt(n));

// --- mapping
ok('action names map, unknown falls back', actionName(1) === 'GUILD_UPDATE' && actionName(9999) === 'ACTION_9999');
ok('created_at comes from the snowflake', snowflakeToIso('175928847299117063') === '2016-04-30T11:18:25.796Z');
const page = {
  users: [{ id: '11', username: 'amy', global_name: 'Amy' }, { id: '12', username: 'bo' }],
  threads: [{ id: '500', name: 'a thread' }],
  webhooks: [{ id: '600', name: 'hook' }],
  integrations: [{ id: '700', name: 'int' }],
  audit_log_entries: [
    { id: id(3), action_type: 11, user_id: '11', target_id: '300', reason: 'tidy', changes: [{ key: 'topic', new_value: 'x' }], options: { a: 1 } },
    { id: id(1), action_type: 24, user_id: '12', target_id: '11' },
    { id: id(2), action_type: 12, user_id: '11', target_id: '999', changes: [{ key: 'name', old_value: 'gone' }] },
    { id: 'bad', action_type: 1 },
    { id: id(4), action_type: 31, user_id: '11', target_id: '400' },
    { id: id(5), action_type: 110, user_id: '11', target_id: '500' },
  ],
};
const rows = mapAuditPage(page, maps);
ok('bad ids are skipped and rows are oldest first', rows.length === 5 && rows.map((r) => r.id).join() === [1, 2, 3, 4, 5].map(id).join());
ok('user and target names resolve from the response', rows[0].user_name === 'bo' && rows[0].target_name === 'Amy');
ok('a channel resolves from the cache, a role too, a thread from the page', rows[2].target_name === 'general' && rows[3].target_name === 'Members' && rows[4].target_name === 'a thread');
ok('a deleted thing is named from its own changes', rows[1].target_name === 'gone');
ok('reason, changes and options carry through', rows[2].reason === 'tidy' && rows[2].changes?.length === 1 && (rows[2].options as any).a === 1 && rows[0].changes === null);
ok('chunk splits by size', chunk([1, 2, 3, 4, 5], 2).length === 3 && chunk([], 2).length === 0);

// --- paging and batching with fakes
function fakeSanctum(latest: string | null) {
  const posts: any[] = [];
  const urls: string[] = [];
  const f = (async (url: string, init?: any) => {
    urls.push(url);
    if (url.includes('/discord-audit/latest')) return { ok: true, json: async () => ({ latest_id: latest }) };
    const body = JSON.parse(init.body);
    posts.push(body);
    return { ok: true, json: async () => ({ stored: body.entries.length, skipped: 0 }) };
  }) as unknown as typeof fetch;
  return { f, posts, urls };
}
function entries(from: number, to: number) { const out = []; for (let i = from; i <= to; i++) out.push({ id: id(i), action_type: 11, user_id: '11', target_id: '300' }); return out; }

async function main() {
  const s = fakeSanctum(id(10));
  const afters: string[] = [];
  const pages = [entries(11, 110), entries(111, 150), []];
  const deps: AuditCopyDeps = {
    guildId: 'g1', sanctumUrl: 'https://s.example', sanctumKey: 'k', fetchImpl: s.f, names: () => maps,
    fetchPage: async (after) => { afters.push(after); return { audit_log_entries: pages.shift() ?? [] }; },
    log: () => {}, dmOwner: async () => {},
  };
  const stored = await runAuditCopy(deps);
  ok('pages with after=<latest>, then the last id of each page, until empty', afters.join() === [id(10), id(110), id(150)].join());
  ok('every entry is posted, 100 at most per call', stored === 140 && s.posts.length === 2 && s.posts.every((p) => p.entries.length <= 100) && s.posts[0].guild_id === 'g1');
  ok('sanctum calls use the configured url', s.urls.every((u) => u.startsWith('https://s.example/')));

  const s2 = fakeSanctum(null);
  const afters2: string[] = [];
  await runAuditCopy({ ...deps, fetchImpl: s2.f, fetchPage: async (a) => { afters2.push(a); return { audit_log_entries: [] }; } });
  ok('no stored entry yet starts from the beginning', afters2[0] === '0' && s2.posts.length === 0);

  // --- failure throttle
  const dms: string[] = [];
  const logs: string[] = [];
  let t = 1_000_000_000;
  const failing: AuditCopyDeps = { ...deps, now: () => t, log: (m) => logs.push(m), dmOwner: async (x) => { dms.push(x); }, fetchPage: async () => { throw new Error('Missing Permissions'); } };
  const state = { lastFailureDmAt: -Infinity };
  await runAuditCopyOnce(failing, state);
  await runAuditCopyOnce(failing, state);
  ok('two failures in a day send one DM, with the reason', dms.length === 1 && dms[0] === auditFailureNotice('Missing Permissions') && dms[0].includes('Discord keeps 45 days'));
  t += FAILURE_DM_INTERVAL_MS + 1;
  await runAuditCopyOnce(failing, state);
  ok('a failure a day later sends another', dms.length === 2);
  ok('every failure logs a line', logs.filter((l) => l.includes('failed')).length === 3);
  const good: string[] = [];
  await runAuditCopyOnce({ ...deps, fetchImpl: fakeSanctum(null).f, log: (m) => good.push(m) }, { lastFailureDmAt: -Infinity });
  ok('a good run logs one stored line', good.length === 1 && good[0] === 'audit log copy: stored 0');

  // --- off at 0, timer runs once and stops
  let calls = 0;
  const countDeps = { ...deps, fetchImpl: fakeSanctum(null).f, fetchPage: async () => { calls++; return { audit_log_entries: [] }; } };
  const offStop = startAuditCopy({ ...countDeps, hours: 0 }, 5);
  await new Promise((r) => setTimeout(r, 40));
  offStop();
  ok('hours 0 starts nothing', calls === 0);
  const stop = startAuditCopy({ ...countDeps, hours: 24 }, 5);
  await new Promise((r) => setTimeout(r, 60));
  stop();
  ok('hours > 0 runs after the delay, then waits for the next interval', calls === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
