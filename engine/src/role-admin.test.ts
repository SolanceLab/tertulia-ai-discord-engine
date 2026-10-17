// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/role-admin.test.ts */
import './test-env.js';
import { PermissionFlagsBits } from 'discord.js';
import {
  assertNoAdministratorGrant,
  applyRolePermEdit,
  keyedSerializer,
  assertHosMutation,
  parsePermissionNames,
  namesFromBits,
  mergeOverwrite,
} from './role-admin.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// Real HoS server ID, so the guard is checked against reality rather than a stub.
const OTHER_SERVER_ID = '700000000000000999';
const HOS_SERVER_ID = '700000000000000001';

async function run() {
  // ── parsePermissionNames ─────────────────────────────────────────────────
  {
    ok('maps a single known name to its bit',
      parsePermissionNames(['ManageMessages']) === PermissionFlagsBits.ManageMessages);

    ok('ORs several known names together',
      parsePermissionNames(['ViewChannel', 'ManageMessages']) ===
        (PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ManageMessages));

    ok('the empty list is the empty bitfield', parsePermissionNames([]) === 0n);

    let threw = false;
    let message = '';
    try {
      parsePermissionNames(['ViewChannel', 'NotARealPermission']);
    } catch (error) {
      threw = true;
      message = error instanceof Error ? error.message : String(error);
    }
    ok('an unknown permission name throws', threw);
    ok('the error names the unknown permission', message.includes('NotARealPermission'));
  }

  // ── namesFromBits ─────────────────────────────────────────────────────────
  {
    const bits = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ManageMessages;
    const names = namesFromBits(bits);
    ok('recovers both names that were set', names.includes('ViewChannel') && names.includes('ManageMessages'));
    ok('does not recover a name that was not set', !names.includes('Administrator'));
    ok('the empty bitfield recovers no names', namesFromBits(0n).length === 0);
  }

  // ── assertHosMutation ─────────────────────────────────────────────────────
  {
    let threw = false;
    try { assertHosMutation(HOS_SERVER_ID); } catch { threw = true; }
    ok('accepts the House of Solance server id', !threw);

    threw = false;
    try { assertHosMutation(OTHER_SERVER_ID); } catch { threw = true; }
    ok('rejects any other server id', threw);
  }

  // ── assertNoAdministratorGrant ────────────────────────────────────────────
  {
    let threw = false;
    try { assertNoAdministratorGrant(PermissionFlagsBits.ManageMessages); } catch { threw = true; }
    ok('accepts a bitfield without Administrator', !threw);

    threw = false;
    try {
      assertNoAdministratorGrant(PermissionFlagsBits.ManageMessages | PermissionFlagsBits.Administrator);
    } catch { threw = true; }
    ok('rejects a bitfield that includes Administrator', threw);

    threw = false;
    try { assertNoAdministratorGrant(PermissionFlagsBits.Administrator); } catch { threw = true; }
    ok('rejects Administrator alone', threw);
  }

  // ── mergeOverwrite ────────────────────────────────────────────────────────
  {
    const VIEW = PermissionFlagsBits.ViewChannel;
    const SEND = PermissionFlagsBits.SendMessages;
    const MANAGE = PermissionFlagsBits.ManageMessages;

    // Neutral clears a bit from both allow and deny.
    {
      const current = { allow: VIEW, deny: 0n };
      const result = mergeOverwrite(current, { allow: 0n, deny: 0n, neutral: VIEW });
      ok('neutral clears an allowed bit', (result.allow & VIEW) === 0n && (result.deny & VIEW) === 0n);
    }
    {
      const current = { allow: 0n, deny: VIEW };
      const result = mergeOverwrite(current, { allow: 0n, deny: 0n, neutral: VIEW });
      ok('neutral clears a denied bit', (result.allow & VIEW) === 0n && (result.deny & VIEW) === 0n);
    }

    // Allow removes the same bit from deny.
    {
      const current = { allow: 0n, deny: SEND };
      const result = mergeOverwrite(current, { allow: SEND, deny: 0n, neutral: 0n });
      ok('allow removes the bit from deny', (result.allow & SEND) === SEND && (result.deny & SEND) === 0n);
    }

    // Deny removes the same bit from allow.
    {
      const current = { allow: SEND, deny: 0n };
      const result = mergeOverwrite(current, { allow: 0n, deny: SEND, neutral: 0n });
      ok('deny removes the bit from allow', (result.deny & SEND) === SEND && (result.allow & SEND) === 0n);
    }

    // Untouched bits are preserved.
    {
      const current = { allow: VIEW, deny: MANAGE };
      const result = mergeOverwrite(current, { allow: SEND, deny: 0n, neutral: 0n });
      ok('an untouched allowed bit survives', (result.allow & VIEW) === VIEW);
      ok('an untouched denied bit survives', (result.deny & MANAGE) === MANAGE);
      ok('the newly allowed bit is present', (result.allow & SEND) === SEND);
    }
  }

  // ── applyRolePermEdit ─────────────────────────────────────────────────────
  {
    const VIEW = PermissionFlagsBits.ViewChannel;
    const SEND = PermissionFlagsBits.SendMessages;
    const MANAGE = PermissionFlagsBits.ManageMessages;

    ok('adds a new bit to the current set',
      (applyRolePermEdit(VIEW, SEND, 0n) & SEND) === SEND);

    ok('keeps the current bit that was not touched',
      (applyRolePermEdit(VIEW, SEND, 0n) & VIEW) === VIEW);

    ok('removes a bit from the current set',
      (applyRolePermEdit(VIEW | SEND, 0n, SEND) & SEND) === 0n);

    ok('remove wins when a bit is both added and removed in the same edit',
      (applyRolePermEdit(0n, MANAGE, MANAGE) & MANAGE) === 0n);

    ok('a no-op edit returns the current set unchanged',
      applyRolePermEdit(VIEW | SEND, 0n, 0n) === (VIEW | SEND));
  }

  // keyedSerializer — the back-to-back regression (Codex, 26 Sep): two
  // read-merge-write edits on one channel+target must not interleave, or the
  // second reads the pre-first state and drops the first edit's deny.
  {
    const serial = keyedSerializer();
    let stored = { allow: 0n, deny: 0n };
    const VIEW = PermissionFlagsBits.ViewChannel, SEND = PermissionFlagsBits.SendMessages;
    const edit = (deny: bigint) => serial('chan:role', async () => {
      const before = stored;                       // read
      await new Promise(r => setTimeout(r, 5));    // the REST round-trip
      stored = mergeOverwrite(before, { allow: 0n, deny, neutral: 0n }); // write
    });
    await Promise.all([edit(VIEW), edit(SEND)]);
    ok('back-to-back edits on one key keep BOTH denies',
      (stored.deny & VIEW) === VIEW && (stored.deny & SEND) === SEND);

    const order: string[] = [];
    const s2 = keyedSerializer();
    const failing = s2('k', async () => { order.push('a'); throw new Error('boom'); });
    const next = s2('k', async () => { order.push('b'); return 'b'; });
    let threw = false; try { await failing; } catch { threw = true; }
    ok('a failed job rejects to its own caller', threw);
    ok('a failed job does not block the next one on the same key', (await next) === 'b' && order.join() === 'a,b');

    const s3 = keyedSerializer();
    const seen: string[] = [];
    await Promise.all([
      s3('x', async () => { await new Promise(r => setTimeout(r, 10)); seen.push('x'); }),
      s3('y', async () => { seen.push('y'); }),
    ]);
    ok('different keys do not wait on each other', seen[0] === 'y');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
