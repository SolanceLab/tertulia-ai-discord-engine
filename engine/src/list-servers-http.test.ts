// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * POST /api/list-servers over real HTTP: one handler, list mode and server_id mode, the settings page's
 * fields kept on each row, a refusal answered 403 with its words.
 *
 * Run: npx tsx src/list-servers-http.test.ts
 */
import './test-env.js';
import type { AddressInfo } from 'node:net';
import { ToolRefusal } from './role-admin.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

async function run() {
  const { createHttpServer } = await import('./http-server.js');
  const seen: Array<string | undefined> = [];
  const fake: any = {
    listServers: () => [{ id: 'g1', name: 'One', icon: 'abc', channel_count: 7, joined_at: '2026-01-01T00:00:00.000Z', defaults: { mode: 'silent' } }],
    describeServers: async (id?: string) => {
      seen.push(id);
      if (id === 'nope') throw new ToolRefusal('The bot is not in a server with id nope.');
      if (id) return { server: { id, name: 'One', member_count: 3, is_home: false } };
      return { servers: [{ id: 'g1', name: 'One', member_count: 3, icon_url: 'https://cdn/x.png', is_home: true }] };
    },
  };
  const srv: any = createHttpServer(fake, {} as any, 'bot-secret', 0);
  await new Promise((res) => (srv.listening ? res(null) : srv.once('listening', res)));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = async (b: unknown) => {
    const r = await fetch(base + '/api/list-servers', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bot-secret' }, body: JSON.stringify(b) });
    return { status: r.status, json: (await r.json().catch(() => null)) as any };
  };

  const list = await post({});
  const row = list.json?.servers?.[0];
  ok('list mode reaches describeServers (new shape)', list.status === 200 && row?.member_count === 3 && row?.icon_url === 'https://cdn/x.png' && row?.is_home === true);
  ok('list mode keeps the settings page fields', row?.icon === 'abc' && row?.channel_count === 7 && row?.joined_at === '2026-01-01T00:00:00.000Z' && row?.defaults?.mode === 'silent');
  ok('list mode passes no server_id', seen[0] === undefined);

  const one = await post({ server_id: 'g1' });
  ok('server_id mode answers one server in full', one.status === 200 && one.json?.server?.id === 'g1' && one.json?.server?.member_count === 3 && !one.json?.servers);
  ok('server_id reaches describeServers', seen[1] === 'g1');

  const bad = await post({ server_id: 'nope' });
  ok('a refusal answers 403 with its own words', bad.status === 403 && /not in a server/.test(bad.json?.error));

  const getList = await fetch(base + '/api/list-servers', { headers: { authorization: 'Bearer bot-secret' } });
  const getJson: any = await getList.json().catch(() => null);
  ok('GET list mode answers the same shape', getList.status === 200 && getJson?.servers?.[0]?.member_count === 3 && getJson?.servers?.[0]?.channel_count === 7);
  const getNoAuth = await fetch(base + '/api/list-servers');
  ok('GET needs the bot secret', getNoAuth.status === 401 || getNoAuth.status === 403);

  const noAuth = await fetch(base + '/api/list-servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  ok('needs the bot secret', noAuth.status === 401 || noAuth.status === 403);

  srv.close();
}

run().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }).catch((e) => { console.error(e); process.exit(1); });
