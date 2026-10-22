// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/study-listener.test.ts */
import './test-env.js';
import type { AddressInfo } from 'node:net';
import { cleanListenerName, LISTENER_LIVE_MS, Listener } from './study-listener.js';
import { studyDestination, StudyAsideQueue } from './aside.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, channelId: 'c1', guildId: 'g1', channelName: 'meet', question: 'q', transcript: '', history: [], createdAt: 0, claimedAt: null,
  followUp: async () => ({}), ...over,
}) as any;

async function run() {
  // ── the listener ──
  {
    let t = 1_000_000;
    const l = new Listener(() => t);
    ok('nobody is listening at first', l.current() === null && !l.isLive());
    ok('a claim needs a session id', l.listen({ session_id: '', name: 'x' }) === false && l.current() === null);
    l.listen({ session_id: 'A', name: 'Study one' });
    ok('a claim is recorded with name and since', l.current()?.session_id === 'A' && l.current()?.name === 'Study one' && l.current()?.since === new Date(1_000_000).toISOString());
    t += 1000;
    l.listen({ session_id: 'B', name: 'Study two' });
    ok('newest claim wins', l.current()?.session_id === 'B' && l.current()?.since === new Date(1_001_000).toISOString());
    ok('the older session\'s heartbeat is refused', l.heartbeat('A') === false && l.heartbeat('B') === true);
    t += 5000;
    l.listen({ session_id: 'B', name: 'Study two renamed' });
    ok('the same session claiming again keeps its start time', l.current()?.since === new Date(1_001_000).toISOString() && l.current()?.name === 'Study two renamed');
    t += LISTENER_LIVE_MS - 1;
    ok('still live just inside 3 minutes', l.isLive());
    ok('a heartbeat extends it', l.heartbeat('B') === true);
    t += LISTENER_LIVE_MS - 1;
    ok('still live after the heartbeat restarted the clock', l.isLive());
    t += 2;
    ok('3 minutes of silence lapses it', !l.isLive() && l.current() === null);
    ok('a lapsed session\'s heartbeat is refused (it must claim again)', l.heartbeat('B') === false);
    l.listen({ session_id: 'C', name: 'c' });
    ok('release by another id does nothing', l.release('zzz') === false && l.current()?.session_id === 'C');
    ok('release by its own id stops it', l.release('C') === true && l.current() === null);
    l.listen({ session_id: 'D', name: 'd' });
    ok('release with no id (the page\'s Stop) stops whoever listens', l.release() === true && l.current() === null);
    ok('release with nobody listening says so', l.release() === false);
    ok('names are one plain line', cleanListenerName('  <@123> **Bold**\nname `x` ') === '123 Bold name x');
    ok('a name never carries tags or markup', !/[<>@*`]/.test(cleanListenerName('<@123456789012345678> **x** @everyone')));
    ok('an empty name gets a plain word', cleanListenerName('   ') === 'a session');
    ok('a name is capped', cleanListenerName('n'.repeat(200)).length === 60);
  }

  // ── queue gating ──
  {
    let t = 1_000_000;
    const q = new StudyAsideQueue(() => t);
    q.add(item('i1', { createdAt: t }));
    ok('no listener: pending is open to every caller, as before', q.pending().length === 1 && q.pending('whoever').length === 1);
    ok('no listener: the card says a new Study session answers', studyDestination(q) === 'Nobody was listening, so a new Study session is answering');
    q.listener.listen({ session_id: 'L', name: 'Study one' });
    ok('a live listener: the watcher (no session id) gets an empty list', q.pending().length === 0);
    ok('a live listener: another session gets nothing', q.pending('X').length === 0);
    ok('a live listener: its own session sees the item', q.pending('L').length === 1);
    ok('a live listener: the card names the session', studyDestination(q) === 'Sent to Study one');
    ok('claim refuses a caller that is not the listener', q.claim('i1') === false && q.claim('i1', 'X') === false);
    ok('claim lets the listener have it, once', q.claim('i1', 'L') === true && q.claim('i1', 'L') === false);
    ok('release returns it to the queue (existing path)', q.release('i1') === true && q.pending('L').length === 1);
    t += LISTENER_LIVE_MS + 1;
    ok('after the listener lapses the watcher gets it again', q.pending().length === 1 && q.claim('i1') === true);
    ok('after the lapse the card says a new session answers', studyDestination(q) === 'Nobody was listening, so a new Study session is answering');
  }

  // ── the routes, over real HTTP ──
  {
    const { createHttpServer } = await import('./http-server.js');
    const q = new StudyAsideQueue();
    q.add(item('r1', { createdAt: Date.now() }));
    const fake: any = { studyAsides: q, agentPresence: { touch() {}, lastSeen: () => null }, answerStudyAside: async () => ({ delivered: 'private' }) };
    const srv: any = createHttpServer(fake, {} as any, 'bot-secret', 0);
    await new Promise((res) => (srv.listening ? res(null) : srv.once('listening', res)));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const call = async (method: string, path: string, body?: unknown, auth = true) => {
      const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer bot-secret' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: (await r.json().catch(() => null)) as any };
    };
    ok('the listener routes need the bot secret', [(await call('POST', '/api/aside/study/listen', { session_id: 'S' }, false)).status, (await call('GET', '/api/aside/study/listener', undefined, false)).status].every((s) => s === 401 || s === 403));
    ok('GET listener: nobody at first', (await call('GET', '/api/aside/study/listener')).json?.listening === null);
    ok('pending with nobody listening is open (the watcher)', (await call('GET', '/api/aside/study/pending')).json?.pending?.length === 1);
    ok('listen needs a session id', (await call('POST', '/api/aside/study/listen', { name: 'x' })).status === 400);
    const l = await call('POST', '/api/aside/study/listen', { session_id: 'S1', name: 'Study one' });
    ok('listen claims', l.status === 200 && l.json?.listening?.name === 'Study one' && l.json?.listening?.session_id === 'S1');
    ok('pending with no session id is empty while a listener is live', (await call('GET', '/api/aside/study/pending')).json?.pending?.length === 0);
    ok('pending with another session id is empty', (await call('GET', '/api/aside/study/pending?session_id=S2')).json?.pending?.length === 0);
    ok('pending with the listener\'s id returns the item', (await call('GET', '/api/aside/study/pending?session_id=S1')).json?.pending?.[0]?.id === 'r1');
    ok('claim without the id is refused (409)', (await call('POST', '/api/aside/study/claim', { id: 'r1' })).status === 409);
    ok('claim by another session is refused (409)', (await call('POST', '/api/aside/study/claim', { id: 'r1', session_id: 'S2' })).status === 409);
    ok('heartbeat by the listener is fine', (await call('POST', '/api/aside/study/heartbeat', { session_id: 'S1' })).status === 200);
    ok('heartbeat by another session is 409', (await call('POST', '/api/aside/study/heartbeat', { session_id: 'S2' })).status === 409);
    ok('claim by the listener works', (await call('POST', '/api/aside/study/claim', { id: 'r1', session_id: 'S1' })).json?.claimed === 'r1');
    ok('release is unchanged: the item goes back', (await call('POST', '/api/aside/study/release', { id: 'r1' })).json?.released === 'r1' && (await call('GET', '/api/aside/study/pending?session_id=S1')).json?.pending?.length === 1);
    const newer = await call('POST', '/api/aside/study/listen', { session_id: 'S2', name: 'Study two' });
    ok('a newer claim replaces the listener', newer.json?.listening?.session_id === 'S2' && (await call('POST', '/api/aside/study/heartbeat', { session_id: 'S1' })).status === 409);
    ok('unlisten by another id does nothing', (await call('POST', '/api/aside/study/unlisten', { session_id: 'S1' })).json?.released === false);
    ok('unlisten with no id (Stop) releases whoever listens', (await call('POST', '/api/aside/study/unlisten', {})).json?.released === true);
    ok('after Stop the watcher path is open again', (await call('GET', '/api/aside/study/pending')).json?.pending?.length === 1 && (await call('GET', '/api/aside/study/listener')).json?.listening === null);
    srv.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);   // the HTTP server's cleanup timer would otherwise keep the process alive
}
run();
