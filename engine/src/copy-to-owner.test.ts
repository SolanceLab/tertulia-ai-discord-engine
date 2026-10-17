// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** copy-to-owner.test.ts — Run: npx tsx src/copy-to-owner.test.ts */
import './test-env.js';
import { createCopyToOwner } from './copy-to-owner.js';
import { resolveServer } from './presence/servers.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } }

const OWNER = '111111111111111111', GUEST = '222222222222222222';
const HOME = '700000000000000201', FRIEND = '700000000000000202';
const seed = { [HOME]: { rules: { copy_to_owner: false } }, [FRIEND]: { rules: { copy_to_owner: true } } };

function mk(sendDM: (u: string, t: string) => Promise<unknown> = async () => ({})) {
  const dms: Array<[string, string]> = []; const logs: string[] = [];
  const f = createCopyToOwner({
    ownerUserId: OWNER,
    copyEnabled: (g) => resolveServer(g, {}, seed as any).rules.copy_to_owner,
    sendDM: async (u, t) => { dms.push([u, t]); return sendDM(u, t); },
    log: (m) => logs.push(m),
  });
  return { f, dms, logs };
}
const base = { guildName: 'Lunethis', channelId: '333333333333333333', channelName: 'chat', sentId: 's1', text: 'hello there' };

async function run() {
  let t = mk();
  ok('fires for a guest-server reply to a guest', await t.f({ ...base, guildId: FRIEND, trigger: { authorId: GUEST, authorName: 'Sam', text: 'hi there bot' } }) && t.dms.length === 1
    && t.dms[0][0] === OWNER && t.dms[0][1].includes('**Copy · Lunethis #chat**') && t.dms[0][1].includes('> Sam: hi there bot') && t.dms[0][1].includes('hello there') && t.dms[0][1].endsWith(`/${FRIEND}/333333333333333333/s1`));
  ok('no trigger is labelled', (await (async () => { const x = mk(); await x.f({ ...base, guildId: FRIEND }); return x.dms[0][1]; })()).includes('(no trigger)'));
  t = mk(); await t.f({ ...base, guildId: HOME, trigger: { authorId: GUEST } });
  ok('not for HoS (seed false)', t.dms.length === 0);
  t = mk(); await t.f({ ...base, guildId: FRIEND, trigger: { authorId: OWNER } });
  ok('not when answering the owner', t.dms.length === 0);
  t = mk(); await t.f({ ...base, guildId: FRIEND }); await t.f({ ...base, guildId: FRIEND });
  ok('once per message', t.dms.length === 1);
  t = mk(async () => { throw new Error('boom'); });
  let threw = false; try { await t.f({ ...base, guildId: FRIEND }); } catch { threw = true; }
  ok('DM failure does not throw, is logged', !threw && t.logs.length === 1);
  t = mk(async () => null); await t.f({ ...base, sentId: 's9', guildId: FRIEND });
  ok('DM null result is logged', t.logs.length === 1);
  t = mk(); await t.f({ ...base, guildId: FRIEND, text: '', stickerNames: ['wave'] });
  ok('sticker-only copies as [sticker name]', t.dms[0][1].includes('[sticker wave]'));
  t = mk(); await t.f({ ...base, guildId: FRIEND, text: 'x'.repeat(3000) });
  ok('body capped', t.dms[0][1].length <= 2000);
  t = mk(); await t.f({ ...base, guildId: FRIEND, text: 'x'.repeat(3000), trigger: { authorId: GUEST, authorName: 'S'.repeat(50), text: 'q'.repeat(500) } });
  ok('total with long quote capped at 2000 and keeps link', t.dms[0][1].length <= 2000 && t.dms[0][1].endsWith('/s1'));
  t = mk(); await t.f({ ...base, guildId: null });
  ok('DMs are not servers', t.dms.length === 0);
  t = mk(); await t.f({ ...base, guildId: FRIEND, text: '', attachments: [{ name: 'a.png', url: 'https://cdn.example/a.png' }] });
  ok('attachment-only copies name and url', t.dms.length === 1 && t.dms[0][1].includes('a.png') && t.dms[0][1].includes('https://cdn.example/a.png'));
  t = mk(); await t.f({ ...base, guildId: FRIEND, text: 'look', attachments: [{ name: 'b.pdf', url: 'https://cdn.example/b.pdf' }] });
  ok('text plus attachment keeps both', t.dms[0][1].includes('look') && t.dms[0][1].includes('b.pdf'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run();
