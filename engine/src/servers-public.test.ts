// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Per-server resolution with no House layer present: what any deployment gets.
 * Run: npx tsx src/servers-public.test.ts
 */
import { resolveServer, type ServerMap } from './presence/servers.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

const MINE = '700000000000000101', FRIEND = '700000000000000102', NEW = '700000000000000103';

// A never-seen server: Silent, quiet hours on, focus off, away off.
const fresh = resolveServer(NEW, { servers: {} }, null);
ok('a server with no settings starts on the silent step', fresh.step === 'silent');
ok('a new server: quiet hours on, focus off, away off', fresh.rules.curfew === true && fresh.rules.flag === false && fresh.rules.away === 'off');
ok('a new server uses the global memory level', fresh.context_log === null);
ok('no guild (a DM) resolves to the defaults', resolveServer(null, { servers: {} }, null).step === 'silent');

// Saved settings win, field by field.
const saved: ServerMap = {
  [MINE]: { step: 'balanced', rules: { curfew: true, flag: true, away: 'channel' } },
  [FRIEND]: { step: 'reserved', rules: { away: 'owner_dm' } },
};
const mine = resolveServer(MINE, { servers: saved }, null);
ok('a saved server resolves with its step and rules', mine.step === 'balanced' && mine.rules.flag === true && mine.rules.away === 'channel');
const friend = resolveServer(FRIEND, { servers: saved }, null);
ok('a partial entry keeps the defaults for the missing rules', friend.step === 'reserved' && friend.rules.away === 'owner_dm' && friend.rules.curfew === true && friend.rules.flag === false);
ok('an old Guest mode with no step reads as reply_only', resolveServer(FRIEND, { servers: { [FRIEND]: { mode: 'guest' } } }, null).step === 'reply_only');
ok('"Same as House" (step null) is kept as null', resolveServer(FRIEND, { servers: { [FRIEND]: { step: null } } }, null).step === null);

// A seed (a deployment's own settings file) sits under the saved settings.
const seed: ServerMap = { [FRIEND]: { step: 'chatty', context_log: 'mentions_only' } };
const seeded = resolveServer(FRIEND, { servers: saved }, seed);
ok('saved settings override the seed', seeded.step === 'reserved');
ok('the seed fills what the saved settings leave out', seeded.context_log === 'mentions_only');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
