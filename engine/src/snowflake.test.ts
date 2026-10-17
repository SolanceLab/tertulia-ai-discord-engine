// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/snowflake.test.ts */
import './test-env.js';
import {
  channelCouldHoldMessage,
  DISCORD_EPOCH,
  orderBySearchLikelihood,
  isSnowflake,
  snowflakeToDate,
} from './snowflake.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// Synthetic ids built from Discord's epoch (not any real server's), so the arithmetic is checked
// against a known date rather than against itself.
const CHARTER_MESSAGE   = '1535905470873600000'; // posted 9 Aug 2026, 07:00 UTC
const TETHER_TALES      = '650000000000000001';
const GENTLEMENS_LOUNGE = '700000000000000102';

function run() {
  // ── isSnowflake ───────────────────────────────────────────────────────────
  {
    ok('accepts a real channel ID', isSnowflake(GENTLEMENS_LOUNGE));
    ok('rejects a non-numeric string', isSnowflake('not-an-id') === false);
    ok('rejects the empty string', isSnowflake('') === false);
    ok('rejects a too-short number', isSnowflake('12345') === false);
    ok('rejects a number type (IDs are strings — 64-bit precision)',
      isSnowflake(1535905470873600000 as unknown as string) === false);
    ok('rejects null/undefined', isSnowflake(null) === false && isSnowflake(undefined) === false);
  }

  // ── snowflakeToDate ───────────────────────────────────────────────────────
  {
    const d = snowflakeToDate(CHARTER_MESSAGE);
    ok('decodes a known message to its real posting time', !!d
      && d.toISOString().startsWith('2026-08-09T07:00'));

    ok('the epoch constant is Discord\'s, not Unix\'s',
      new Date(Number(DISCORD_EPOCH)).toISOString() === '2015-01-01T00:00:00.000Z');

    ok('returns null on junk rather than a 1970 date', snowflakeToDate('nonsense') === null);

    // Ordering sanity: the Charter was posted long after the lounge was made.
    const ch = snowflakeToDate(GENTLEMENS_LOUNGE)!;
    ok('a channel predates a message posted in it', ch.getTime() < d!.getTime());
  }

  // ── channelCouldHoldMessage — the pruning rule ────────────────────────────
  {
    ok('a channel older than the message is searchable',
      channelCouldHoldMessage(GENTLEMENS_LOUNGE, CHARTER_MESSAGE) === true);

    // The message is older than a channel created later — impossible, skip it.
    ok('a channel created AFTER the message is skipped',
      channelCouldHoldMessage(CHARTER_MESSAGE, TETHER_TALES) === false);

    ok('an ID equal to itself is searchable (boundary, not excluded)',
      channelCouldHoldMessage(CHARTER_MESSAGE, CHARTER_MESSAGE) === true);

    // Pruning must never be the reason a real message is declared missing.
    ok('junk channel ID is searched anyway rather than silently skipped',
      channelCouldHoldMessage('garbage', CHARTER_MESSAGE) === true);
    ok('junk message ID searches everything rather than nothing',
      channelCouldHoldMessage(GENTLEMENS_LOUNGE, 'garbage') === true);

    // 64-bit correctness: these differ only in the low bits, which is exactly
    // where Number() would lose precision and invert the comparison.
    const a = '1535905470873600000';
    const b = '1535905470873600001';
    ok('comparison is exact at 64 bits (Number() would round these together)',
      channelCouldHoldMessage(a, b) === true && channelCouldHoldMessage(b, a) === false);
  }

  // ── orderBySearchLikelihood ───────────────────────────────────────────────
  {
    const channels = [
      { id: TETHER_TALES },        // oldest
      { id: GENTLEMENS_LOUNGE },   // created nearest the Charter
    ];
    const ordered = orderBySearchLikelihood(channels, CHARTER_MESSAGE);
    ok('the channel created nearest the message is tried first',
      ordered[0]!.id === GENTLEMENS_LOUNGE);
    ok('ordering keeps every channel (it sorts, never filters)',
      ordered.length === channels.length);

    const input = [{ id: TETHER_TALES }, { id: GENTLEMENS_LOUNGE }];
    orderBySearchLikelihood(input, CHARTER_MESSAGE);
    ok('the caller\'s array is not mutated', input[0]!.id === TETHER_TALES);

    ok('a junk message ID still returns every channel',
      orderBySearchLikelihood(channels, 'garbage').length === 2);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
