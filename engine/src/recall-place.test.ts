// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Discord memory wall (2026-10-15): every Sanctum call that sends `recall` also says where the turn
 * happens: `guild_id` (the triggering message's real guild, null in a DM) and `scope` ('private' only
 * when the owner alone sees the reply, else 'server'). One test per path.
 * Run: npx tsx src/recall-place.test.ts
 */
import './test-env.js';
import { recallPlaceFor, PresenceEngine, recallFromLatest } from './presence-engine.js';
import type { WindowMessage } from './presence-engine.js';
import { recallFor } from './presence/window.js';
import { CurfewWatch } from './curfew-watch.js';
import { AsideMemory, handleAsideCommand } from './aside.js';
import { buildAwaySanctumBody } from './away-handler.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const clock = 1_000_000_000_000;
const msg = (over: Partial<WindowMessage> = {}): WindowMessage => ({
  authorId: 'u1', authorName: 'Mara', content: 'do you remember the deploy?', isFromOwner: false, isFromMe: false, timestampMs: clock, ...over,
});

// ── the pure helpers ──
ok('guild message → server scope + that guild', JSON.stringify(recallPlaceFor('G1')) === '{"guild_id":"G1","scope":"server"}');
ok('guild message from the owner is still server scope', recallPlaceFor('G1', true).scope === 'server' && recallPlaceFor('G1', true).guild_id === 'G1');
ok('owner DM → private + null', JSON.stringify(recallPlaceFor(null, true)) === '{"guild_id":null,"scope":"private"}');
ok('owner DM with undefined guild → private + null', recallPlaceFor(undefined, true).scope === 'private');
ok('guest DM → server + null', JSON.stringify(recallPlaceFor(null, false)) === '{"guild_id":null,"scope":"server"}');
ok('no place supplied → fails closed (server, null)', recallFor('hello')?.scope === 'server' && recallFor('hello')?.guild_id === null);
ok('blank text → no recall at all', recallFor('   ') === undefined && recallFromLatest([msg({ content: ' ' })]) === undefined);
ok('recallFromLatest carries the place', recallFromLatest([msg()], undefined, recallPlaceFor('G2'))?.guild_id === 'G2');

// ── the engine paths, through the real sanctumComplete/callModel with a mocked fetch ──
const realFetch = (globalThis as any).fetch;
const seen: any[] = [];
(globalThis as any).fetch = async (_url: string, init: any) => {
  const body = JSON.parse(init.body);
  seen.push(body);
  const isJudge = typeof body.system === 'string' && body.system.includes('deciding whether to SPEAK');
  const isAside = typeof body.system === 'string' && body.system.includes('NOTE:');
  return {
    ok: true, status: 200,
    json: async () => ({
      text: isJudge ? JSON.stringify({ speak: true, reason: 'x', message: 'Welcome in.' }) : isAside ? 'NOTE:\nok\nPROPOSED:\nNONE' : 'Hey.',
      system_prompt: body.system,
    }),
  };
};
try {
  const eng = new PresenceEngine('http://sanctum.test', 'dummy', 'PERSONA', () => clock, 'z-ai/glm-5.2');
  const recallOf = () => seen.find((b) => b.recall)?.recall;

  seen.length = 0;
  await eng.judge('700000000000000103', 'guest-hall', [msg()], undefined, [], undefined, recallPlaceFor('G1'));
  ok('judge in a guild → server + that guild', recallOf()?.scope === 'server' && recallOf()?.guild_id === 'G1' && recallOf()?.channel === 'discord');

  seen.length = 0;
  await eng.respond('guest-hall', [msg()], undefined, false, [], '700000000000000103', 'where were we?', recallPlaceFor('G2'));
  ok('respond in a guild → server + that guild', recallOf()?.scope === 'server' && recallOf()?.guild_id === 'G2' && recallOf()?.query === 'where were we?');

  seen.length = 0;
  await eng.respond('guest-hall', [msg()], undefined, false, [], '700000000000000103', undefined, recallPlaceFor('G2'));
  ok('respond without trigger text uses the window and still carries the place', recallOf()?.guild_id === 'G2' && recallOf()?.scope === 'server');

  seen.length = 0;
  await eng.respond('guest-hall', [msg()], undefined, false, [], '700000000000000103', 'hi');
  ok('respond with no place supplied fails closed (server, null)', recallOf()?.scope === 'server' && recallOf()?.guild_id === null);

  seen.length = 0;
  await eng.respond('DM', [msg()], undefined, false, [], undefined, 'hi', recallPlaceFor(null, false));
  ok('guest DM → server + null', recallOf()?.scope === 'server' && recallOf()?.guild_id === null);

  seen.length = 0;
  await eng.respond('DM', [msg({ isFromOwner: true })], undefined, true, [], undefined, 'hi', recallPlaceFor(null, true));
  ok('owner DM → private + null', recallOf()?.scope === 'private' && recallOf()?.guild_id === null);

  seen.length = 0;
  await eng.privateAside('guest-hall', [msg()], 'what do you make of this?', [], '700000000000000103', 'G3');
  ok('private aside → private + the guild it was asked from', recallOf()?.scope === 'private' && recallOf()?.guild_id === 'G3');

  seen.length = 0;
  await eng.privateAside('DM', [msg()], 'anything?', [], undefined, null);
  ok('private aside in a DM → private + null', recallOf()?.scope === 'private' && recallOf()?.guild_id === null);

  // The proposal is posted to the guild channel: it must be drafted under SERVER scope, never the aside's private pass.
  {
    const prior = (globalThis as any).fetch;
    (globalThis as any).fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      seen.push(body);
      const isNote = typeof body.system === 'string' && body.system.includes('NOTE:');
      return { ok: true, status: 200, json: async () => ({ text: isNote ? 'NOTE:\nprivate read\nPROPOSED:\nPRIVATE LEAK DRAFT' : 'Welcome in, all.', system_prompt: body.system }) };
    };
    seen.length = 0;
    const r = await eng.privateAside('guest-hall', [msg()], 'what should I say?', [{ question: 'q', note: 'SECRET NOTE', proposal: 'earlier line' }], '700000000000000103', 'G3');
    const recalls = seen.filter((b) => b.recall && b.messages);
    ok('aside with a proposal: two completions, private note then server proposal', recalls.length === 2 && recalls[0].recall.scope === 'private' && recalls[1].recall.scope === 'server' && recalls[1].recall.guild_id === 'G3');
    ok('aside proposal comes from the server-scope pass, not the private draft', r.proposal === 'Welcome in, all.' && r.note === 'private read');
    ok('server-scope proposal prompt carries no private notes', !String(recalls[1].system).includes('SECRET NOTE') && !String(recalls[1].system).includes('private read'));
    (globalThis as any).fetch = prior;
  }
} finally {
  (globalThis as any).fetch = realFetch;
}

// ── the aside command hands the interaction's guild to the engine ──
{
  const asked: any[] = [];
  const memory = new AsideMemory(() => clock);
  const OWNER = '100000000000000001';
  const it = {
    commandName: 'aside', user: { id: OWNER }, channelId: 'c1', guildId: 'G9',
    options: { getString: (n: string) => (n === 'to' ? null : 'should I answer?') },
    reply: async () => {}, deferReply: async () => {}, editReply: async () => {}, followUp: async () => {},
  };
  await handleAsideCommand(it as any, {
    commandName: 'aside', ownerUserId: OWNER, memory,
    readChannel: async () => ({ channelName: 'room', window: [] }),
    aside: async (_n: string, _w: unknown[], _q: string, _h: any[], channelId: string, guildId?: string | null) => { asked.push({ channelId, guildId }); return { note: 'x', proposal: null }; },
    newId: () => 'd1', log: () => {},
  });
  ok('the aside command passes the interaction guild through', asked[0]?.guildId === 'G9' && asked[0]?.channelId === 'c1');
}

// ── curfew: the nudge generator receives the place of the message that fired it ──
{
  const places: any[] = [];
  const t0 = Date.UTC(2026, 6, 11, 23, 30) - 7 * 3600_000;
  (globalThis as any).fetch = async () => ({ ok: true, json: async () => ({ curfew: { enabled: true, start: '23:00', end: '06:00' } }) });
  try {
    const w = new CurfewWatch('https://solance-api.test', 't', async (_l, _c, _w, _t, place) => { places.push(place); return 'line'; }, () => t0);
    await w.onOwnerMessage('c1', 'room', undefined, 'late', recallPlaceFor('G1'));
    ok('curfew nudge in a guild → server + that guild', places[0]?.scope === 'server' && places[0]?.guild_id === 'G1');
    const w2 = new CurfewWatch('https://solance-api.test', 't', async (_l, _c, _w, _t, place) => { places.push(place); return 'line'; }, () => t0);
    await w2.onOwnerMessage('c2', 'DM', undefined, 'late', recallPlaceFor(null, true));
    ok('curfew nudge in the owner DM → private + null', places[1]?.scope === 'private' && places[1]?.guild_id === null);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

// ── the away body still carries no recall ──
{
  const body = buildAwaySanctumBody({ system: 's', messages: [{ role: 'user', content: 'hi' }] } as any);
  ok('the away body carries no recall', !('recall' in body));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
