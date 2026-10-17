// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * discord/admin.ts guard parity: assignRole refuses an Administrator role and
 * assignRole / removeRole / timeoutUser / deleteChannel all call
 * assertHosMutation, like createRole / editRole / setChannelPermissionNow.
 *
 * Run: npx tsx src/admin-guards.test.ts
 */
import './test-env.js';
import { PermissionFlagsBits } from 'discord.js';
import { deleteChannel, timeoutUser, assignRole, removeRole } from './discord/admin.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const HOME = '700000000000000001';
const OTHER = '700000000000000999';

function fake(rolePerms: bigint, channelGuild: string | null = HOME) {
  const log: string[] = [];
  const member = {
    roles: { add: async () => { log.push('add'); }, remove: async () => { log.push('remove'); } },
    timeout: async () => { log.push('timeout'); },
  };
  const guild = {
    roles: { fetch: async () => ({ permissions: { bitfield: rolePerms } }) },
    members: { fetch: async () => member },
  };
  const channel = { guildId: channelGuild, delete: async () => { log.push('delete'); } };
  const client: any = {
    guilds: { fetch: async (id: string) => { log.push('guild:' + id); return guild; } },
    channels: { fetch: async () => channel },
  };
  return { client, log };
}

async function run() {
  {
    const { client, log } = fake(PermissionFlagsBits.SendMessages);
    ok('assignRole works for an ordinary role on the home server', await assignRole(client, HOME, 'u', 'r') === true && log.includes('add'));
  }
  {
    const { client, log } = fake(PermissionFlagsBits.Administrator | PermissionFlagsBits.SendMessages);
    ok('assignRole refuses a role holding Administrator', await assignRole(client, HOME, 'u', 'r') === false && !log.includes('add'));
  }
  {
    const { client, log } = fake(PermissionFlagsBits.SendMessages);
    ok('assignRole refuses a non-home server', await assignRole(client, OTHER, 'u', 'r') === false && log.length === 0);
    ok('removeRole refuses a non-home server', await removeRole(client, OTHER, 'u', 'r') === false && log.length === 0);
    ok('timeoutUser refuses a non-home server', await timeoutUser(client, OTHER, 'u', 5) === false && log.length === 0);
    ok('removeRole works on the home server', await removeRole(client, HOME, 'u', 'r') === true && log.includes('remove'));
    ok('timeoutUser works on the home server', await timeoutUser(client, HOME, 'u', 5) === true && log.includes('timeout'));
  }
  {
    const { client, log } = fake(0n, OTHER);
    ok('deleteChannel refuses a channel in a non-home server', await deleteChannel(client, 'c') === false && !log.includes('delete'));
  }
  {
    const { client, log } = fake(0n, null);
    ok('deleteChannel refuses a channel with no server (DM)', await deleteChannel(client, 'c') === false && !log.includes('delete'));
  }
  {
    const { client, log } = fake(0n, HOME);
    ok('deleteChannel works for a home-server channel', await deleteChannel(client, 'c') === true && log.includes('delete'));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run();
