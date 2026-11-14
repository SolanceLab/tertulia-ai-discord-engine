// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/profile-tools.test.ts — display picture, banner, server bio: data-URI checks, account vs server routing, clears, auth, refusals. */
import './test-env.js';
import type { AddressInfo } from 'node:net';
import { logger } from './logger.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } }
for (const k of ['info', 'warn', 'error', 'debug'] as const) (logger as any)[k] = () => {};

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const png = `data:image/png;base64,${PNG.toString('base64')}`;
const refused = (fn: () => unknown, status = 400) => { try { fn(); return false; } catch (e: any) { return e?.name === 'Error' && e.status === status; } };

async function run() {
  const { cleanImage, buildPatch, readProfile, setProfile, plainReason, withLocalImages, IMAGE_MAX_BYTES, PROFILE_BODY_LIMIT_BYTES } = await import('./profile-edit.js');
  const { createHttpServer } = await import('./http-server.js');
  const { buildToolDefinitions } = await import('./mcp/shared/definitions.js');
  const { z } = await import('zod');

  // data URIs: kinds, size, never a link
  ok('png data URI accepted', cleanImage(png, 'avatar') === png);
  ok('null clears', cleanImage(null, 'avatar') === null);
  ok('a URL is refused', refused(() => cleanImage('https://example.test/a.png', 'avatar')));
  ok('a file: or path string is refused', refused(() => cleanImage('/etc/hosts', 'avatar')));
  ok('svg is refused', refused(() => cleanImage('data:image/svg+xml;base64,PHN2Zz4=', 'avatar')));
  ok('bytes that are not the named type are refused', refused(() => cleanImage('data:image/gif;base64,' + PNG.toString('base64'), 'avatar')));
  ok('over 8 MB decoded is refused', refused(() => cleanImage('data:image/png;base64,' + Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES)]).toString('base64'), 'banner')));
  ok('a number is refused', refused(() => cleanImage(5, 'avatar')));

  // routing: account vs server, bio only with a server
  ok('no server_id: account patch', buildPatch({ avatar: png }).server_id === null);
  ok('server_id: server patch', buildPatch({ banner: png, server_id: '1234567890' }).server_id === '1234567890');
  ok('bio without server_id is refused', refused(() => buildPatch({ bio: 'hi' })));
  ok('empty request is refused', refused(() => buildPatch({})));
  ok('bad server_id is refused', refused(() => buildPatch({ avatar: png, server_id: '../x' })));
  ok('null avatar and bio stay in the patch as null', (() => { const b = buildPatch({ avatar: null, bio: null, server_id: '1234567890' }).body; return b.avatar === null && b.bio === null; })());

  // Discord calls: the right route, the right body, a plain reason on refusal
  const calls: Array<{ m: string; route: string; body?: any }> = [];
  let fail429 = false;
  const rest: any = {
    get: async (route: string) => { calls.push({ m: 'GET', route }); if (route !== '/users/@me' && route !== '/guilds/1234567890/members/77') throw new Error('unexpected GET ' + route); return route.startsWith('/guilds') ? { user: { id: '77' }, avatar: 'abc', banner: null, bio: 'hello' } : { id: '77', avatar: 'a_x', banner: 'bb' }; },
    patch: async (route: string, o: any) => {
      calls.push({ m: 'PATCH', route, body: o.body });
      if (fail429) throw Object.assign(new Error('You are being rate limited.'), { status: 429 });
      return route.startsWith('/guilds') ? { user: { id: '77' }, avatar: null, banner: 'bb' } : { id: '77', avatar: 'h1', banner: null };
    },
  };
  let v = await setProfile(rest, { avatar: png });
  ok('whole account: PATCH /users/@me with the image', calls.at(-1)!.route === '/users/@me' && calls.at(-1)!.body.avatar === png && v.server_id === null);
  ok('the answer carries the new picture link', v.avatar_url === 'https://cdn.discordapp.com/avatars/77/h1.png');
  v = await setProfile(rest, { banner: png, bio: 'Hi', server_id: '1234567890' });
  ok('one server: PATCH /guilds/{id}/members/@me', calls.at(-1)!.route === '/guilds/1234567890/members/@me' && calls.at(-1)!.body.bio === 'Hi' && v.bio_sent === 'Hi');
  await setProfile(rest, { banner: null });
  ok('null clears on the wire', calls.at(-1)!.body.banner === null);
  v = await readProfile(rest);
  ok('read account: animated hash gives a gif link, no bio', v.avatar_url === 'https://cdn.discordapp.com/avatars/77/a_x.gif' && v.banner_url === 'https://cdn.discordapp.com/banners/77/bb.png' && !('bio' in v));
  v = await readProfile(rest, '1234567890');
  ok('read server: server links, no bio claimed (Discord returns none)', v.avatar_url === 'https://cdn.discordapp.com/guilds/1234567890/users/77/avatars/abc.png' && !('bio' in v) && !('bio_sent' in v));
  ok('read server uses the bot-token route GET /guilds/{id}/members/{botUserId}', calls.at(-1)!.m === 'GET' && calls.at(-1)!.route === '/guilds/1234567890/members/77' && !calls.some(c => c.route.includes('/users/@me/guilds')));
  ok('read account uses GET /users/@me', calls.some(c => c.m === 'GET' && c.route === '/users/@me'));
  // size boundary: a max-size image passes, one byte more is refused, and avatar + banner at max fit the profile body limit
  const atMax = Buffer.concat([PNG, Buffer.alloc(IMAGE_MAX_BYTES - PNG.length)]);
  const uriMax = 'data:image/png;base64,' + atMax.toString('base64');
  ok('exactly the cap is accepted', cleanImage(uriMax, 'avatar') === uriMax);
  ok('one byte over the cap is refused', refused(() => cleanImage('data:image/png;base64,' + Buffer.concat([atMax, Buffer.alloc(1)]).toString('base64'), 'avatar')));
  ok('two max-size images as JSON fit the profile route body limit', Buffer.byteLength(JSON.stringify({ avatar_base64: uriMax, banner_base64: uriMax })) < PROFILE_BODY_LIMIT_BYTES);
  fail429 = true;
  let err: any; try { await setProfile(rest, { avatar: png }); } catch (e) { err = e; }
  ok('a 429 comes back as a plain reason', err?.status === 429 && /rate limiting/.test(err.message));
  ok('an invalid image from Discord is a plain 400', plainReason({ status: 400, message: 'Invalid Form Body' }).message.includes('Invalid Form Body'));

  // local files (local files): path becomes base64, both forms refused, oversize refused
  let r: any = await withLocalImages({ avatar_path: '/x.png', bio: 'k' }, async () => PNG);
  ok('avatar_path is read into avatar_base64', r.args.avatar_base64 === PNG.toString('base64') && !('avatar_path' in r.args) && r.args.bio === 'k');
  r = await withLocalImages({ avatar_path: '/x.png', avatar_base64: 'zz' }, async () => PNG);
  ok('path and base64 together are refused', typeof r.refusal === 'string');
  r = await withLocalImages({ banner_path: '/nope' }, async () => { throw new Error('ENOENT'); });
  ok('unreadable file is a plain refusal', /Could not read/.test(r.refusal));
  r = await withLocalImages({ banner_path: '/big' }, async () => Buffer.alloc(IMAGE_MAX_BYTES + 1));
  ok('oversize file is refused before encoding', /too large/.test(r.refusal));

  // tool definition: base64 becomes a typed data URI; cloud shape has no paths
  const def = buildToolDefinitions(z).find((d: any) => d.name === 'discord_profile_set')!;
  const body: any = def.toBody!({ avatar_base64: PNG.toString('base64'), banner_base64: null, server_id: '1234567890' });
  ok('toBody wraps raw base64 by its first bytes and keeps null', body.avatar === png && body.banner === null && body.server_id === '1234567890');
  ok('cloud shape never offers a path', !('avatar_path' in def.shape) && 'avatar_path' in (def.localShape ?? {}));
  ok('check refuses bio without server and an empty call', !!def.check!({ bio: 'x' }) && !!def.check!({}) && def.check!({ avatar_base64: 'x' }) === null);

  // routes: auth, routing through the client's REST, plain reasons
  const fake: any = { rest };
  const srv: any = createHttpServer(fake, {} as any, 'bot-secret', 0);
  await new Promise((res) => srv.listening ? res(null) : srv.once('listening', res));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = async (p: string, b: unknown = {}, auth = 'bot-secret') => {
    const x = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` }, body: JSON.stringify(b) });
    return { status: x.status, json: await x.json().catch(() => null) as any };
  };
  fail429 = false;
  ok('profile routes need the bot secret', (await post('/api/profile-read', {}, 'wrong')).status === 403 && (await post('/api/profile-update', { avatar: png }, 'wrong')).status === 403);
  let res = await post('/api/profile-update', { avatar: png });
  ok('profile-update changes the account', res.status === 200 && calls.at(-1)!.route === '/users/@me');
  res = await post('/api/profile-update', { avatar: 'https://example.test/a.png' });
  ok('a URL is a 400 and never reaches Discord', res.status === 400 && !calls.some((c) => c.body?.avatar === 'https://example.test/a.png'));
  res = await post('/api/profile-update', { bio: 'x' });
  ok('bio without server_id is a 400 with a reason', res.status === 400 && /server_id/.test(res.json.error));
  fail429 = true;
  res = await post('/api/profile-update', { banner: png, server_id: '1234567890' });
  ok('a Discord 429 is reported as 429 with a reason', res.status === 429 && /rate limiting/.test(res.json.error));
  res = await post('/api/profile-read', { server_id: '1234567890' });
  ok('profile-read for a server', res.status === 200 && !('bio' in res.json));
  srv.close();
}

run().then(() => { console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, (e) => { console.error(e); process.exit(1); });
