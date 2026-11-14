// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * The bot's HTTP server checks the rate limit and the secret before it reads a request body: a caller
 * without the secret gets 401/403, never a body-parser 400/413. A caller with the secret still has its body parsed.
 *
 * Run: npx tsx src/http-auth-order.test.ts
 */
import './test-env.js';
import type { AddressInfo } from 'node:net';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

async function run() {
  const { createHttpServer } = await import('./http-server.js');
  const fake: any = {
    listServers: () => [{ id: 'g1', name: 'One', icon: 'abc', channel_count: 7, joined_at: '2026-01-01T00:00:00.000Z', defaults: { mode: 'silent' } }],
    describeServers: async (id?: string) => (id ? { server: { id, name: 'One', member_count: 3, is_home: false } } : { servers: [{ id: 'g1', name: 'One', member_count: 3, icon_url: 'https://cdn/x.png', is_home: true }] }),
  };
  const srv: any = createHttpServer(fake, {} as any, 'bot-secret', 0);
  await new Promise((res) => (srv.listening ? res(null) : srv.once('listening', res)));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const url = base + '/api/list-servers';
  const send = async (body: string, auth?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth !== undefined) headers.authorization = auth;
    const r = await fetch(url, { method: 'POST', headers, body });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };

  const malformed = '{not json';
  const big = '{"a":"' + 'x'.repeat(11 * 1024 * 1024) + '"}'; // over the 10mb limit

  const m1 = await send(malformed);
  ok('no secret + malformed JSON: 401 from auth, not a 400 from the parser', m1.status === 401 && /Authorization/.test(m1.json?.error ?? ''));
  const m2 = await send(malformed, 'Bearer wrong-secret');
  ok('wrong secret + malformed JSON: 403 from auth, not a 400', m2.status === 403 && m2.json?.error === 'Invalid token');
  const b1 = await send(big);
  ok('no secret + body over 10 MB: 401 from auth, not a 413', b1.status === 401);
  const b2 = await send(big, 'Bearer wrong-secret');
  ok('wrong secret + body over 10 MB: 403 from auth, not a 413', b2.status === 403);
  const good = await send(JSON.stringify({ server_id: 'g1' }), 'Bearer bot-secret');
  ok('right secret + valid body: parsed and answered', good.status === 200 && good.json?.server?.id === 'g1');
  const bad = await send(malformed, 'Bearer bot-secret');
  ok('right secret + malformed JSON: the parser still runs after auth (400)', bad.status === 400);

  const health = async (method: string, body?: string) => {
    const r = await fetch(base + '/health', { method, headers: { 'content-type': 'application/json' }, body });
    return r.status;
  };
  ok('GET /health needs no secret', (await health('GET')) === 200);
  ok('POST /health + malformed JSON, no secret: 401, not a 400', (await health('POST', malformed)) === 401);
  ok('POST /health + body over 10 MB, no secret: 401, not a 413', (await health('POST', big)) === 401);

  srv.close();
}

run().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }).catch((e) => { console.error(e); process.exit(1); });
