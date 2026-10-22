// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * The owner's DM when a server adds or removes the bot.
 * Run: npx tsx src/server-join.test.ts
 */
import './test-env.js';
import { serverJoinedNotice, serverLeftNotice } from './discord-client.js';
import { resolveServer } from './presence/servers.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } }

const j = serverJoinedNotice('Moonlight Café', 41);
ok('the join note names the server and its size', j.includes('`Moonlight Café`') && j.includes('(41 members)'));
ok('the join note says the bot is Silent there until the owner chooses', j.includes("I'm Silent there"));
ok('a server name cannot break out of the bold or carry markup', !serverJoinedNotice('a**b\n<@&1>', 3).includes('\n') && !serverJoinedNotice('x<@&1>', 3).includes('<@'));
ok('a masked-link server name stays inert text', serverJoinedNotice('[Free Nitro](https://x.example)', 3).includes('`[Free Nitro](https://x.example)`') && !serverJoinedNotice('a`]`(x)', 3).includes('``'));
ok('no member count when Discord gives none', !serverJoinedNotice('Quiet', null).includes('members'));
ok('the leave note names the server', serverLeftNotice('Moonlight Café').includes('`Moonlight Café`'));
ok('a server the bot never saw before really is Silent', resolveServer('700000000000000999', { servers: {} }, null).step === 'silent');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
