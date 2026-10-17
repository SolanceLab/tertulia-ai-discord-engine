// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/classify.test.ts */
import './test-env.js';
import { addressesOwner, classifyRefs, type NameTriggers, isOwner, buildPreCheckPattern } from './classify.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const OTHER_ID = 'guest-id-456';
const OWNER_ID = 'owen-id-123';
const TRIGGERS: NameTriggers = { owner: ['owen'], bot: ['bram', 'bramley'] };

function stubMentions(hasOwner: boolean) {
  return { has: (id: string) => hasOwner && id === OWNER_ID };
}

function run() {
  // --- classifyRefs ---

  ok(
    '@Owen → ownerHard',
    classifyRefs('hey @Owen', stubMentions(true), OWNER_ID, OTHER_ID, TRIGGERS).ownerHard === true,
  );

  ok(
    "where's owen → ownerSoft",
    classifyRefs("where's owen", stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS).ownerSoft === true,
  );

  ok(
    'her bram → botSoft',
    classifyRefs('her bram', stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS).botSoft === true,
  );

  {
    const refs = classifyRefs('detached', stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS);
    ok('detached → NOT botSoft (word boundary)', refs.botSoft === false);
  }
  {
    const refs = classifyRefs('and', stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS);
    ok('and → NOT ownerSoft (word boundary)', refs.ownerSoft === false);
  }

  {
    const metaTriggers: NameTriggers = { owner: ['a.e'], bot: [] };
    let threw = false;
    let refs: ReturnType<typeof classifyRefs> | null = null;
    try {
      refs = classifyRefs('completely unrelated text', stubMentions(false), OWNER_ID, OTHER_ID, metaTriggers);
    } catch {
      threw = true;
    }
    ok('regex-metachar trigger does not throw', !threw);
    ok('regex-metachar trigger does not over-match unrelated text', refs !== null && refs.ownerSoft === false);

    const literalHit = classifyRefs('the a.e value', stubMentions(false), OWNER_ID, OTHER_ID, metaTriggers);
    ok('regex-metachar trigger still matches its literal text', literalHit.ownerSoft === true);
  }

  ok(
    'message from Owen → isFromOwner true',
    classifyRefs('hi', stubMentions(false), OWNER_ID, OWNER_ID, TRIGGERS).isFromOwner === true,
  );
  ok(
    'message from a guest → isFromOwner false',
    classifyRefs('hi', stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS).isFromOwner === false,
  );

  // NAME-COLLISION negatives — word-boundary must exclude "owen" glued inside another name ("Bowen" ends in the trigger).
  for (const content of ['LeeOwen is here', 'LeeOwenK Flameheart', 'Bowen left']) {
    const refs = classifyRefs(content, stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS);
    ok(`"${content}" → NOT ownerSoft (name collision)`, refs.ownerSoft === false);
  }

  // empty content / code-block content / multi-trigger sanity
  ok('empty content → no soft hits', classifyRefs('', stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS).ownerSoft === false);
  ok(
    'code-block content containing bram → still word-boundary matched',
    classifyRefs('```\nbram\n```', stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS).botSoft === true,
  );
  ok(
    'multi-trigger: bramley matches bram family',
    classifyRefs('hey bramley', stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS).botSoft === true,
  );

  // --- addressesOwner ---

  const TRUE_CASES = ['where is owen', 'owen, come here', 'has anyone seen owen', 'is owen around'];
  for (const content of TRUE_CASES) {
    const refs = classifyRefs(content, stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS);
    ok(`addressesOwner("${content}") → true`, addressesOwner(refs, content) === true);
  }

  const FALSE_CASES = [
    "owen's asleep lol",
    'owen is the healthier one',
    'Did Owen write this?',
    "I spoke with owen, she's fine",
    'Who is this owen?',
    "she is owen's friend",
  ];
  for (const content of FALSE_CASES) {
    const refs = classifyRefs(content, stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS);
    ok(`addressesOwner("${content}") → false`, addressesOwner(refs, content) === false);
  }

  // ownerHard always addresses her, regardless of content shape
  {
    const refs = classifyRefs('random unrelated text', stubMentions(true), OWNER_ID, OTHER_ID, TRIGGERS);
    ok('addressesOwner true on ownerHard even without a reach pattern', addressesOwner(refs, 'random unrelated text') === true);
  }

  // no ownerSoft at all → never a reach
  {
    const refs = classifyRefs('nothing relevant here', stubMentions(false), OWNER_ID, OTHER_ID, TRIGGERS);
    ok('addressesOwner false with no ownerSoft/ownerHard', addressesOwner(refs, 'nothing relevant here') === false);
  }

  // --- isOwner ---

  ok('isOwner exact string match → true', isOwner(OWNER_ID, OWNER_ID) === true);
  ok('isOwner null → false', isOwner(null, OWNER_ID) === false);
  ok('isOwner undefined → false', isOwner(undefined, OWNER_ID) === false);
  ok("isOwner '' → false", isOwner('', OWNER_ID) === false);
  ok('isOwner a different id → false', isOwner(OTHER_ID, OWNER_ID) === false);

  // canonical string compare — never numeric/loose equality
  ok("isOwner('007','7') → false (not numeric equality)", isOwner('007', '7') === false);

  // whitespace-only id → false (never coerces/trims to a match)
  ok("isOwner('   ', OWNER_ID) → false (whitespace-only id)", isOwner('   ', OWNER_ID) === false);

  // case differs → false (strict compare, never case-insensitive)
  ok(
    'isOwner(ownerId.toUpperCase(), ownerId) → false (strict compare, case differs)',
    isOwner(OWNER_ID.toUpperCase(), OWNER_ID) === false,
  );

  // non-string author id (e.g. a numeric snowflake that slipped through as a number) → false
  ok('isOwner(123 as any, OWNER_ID) → false (non-string author id)', isOwner(123 as any, OWNER_ID) === false);

  // --- buildPreCheckPattern (P1 fix, 2026-07-12 review) ---
  // The hardcoded /owen|bram/i messageCreate pre-check silently dropped any
  // configured custom trigger; buildPreCheckPattern must be built from the
  // SAME live triggers classifyRefs uses so a custom name is never invisible
  // to the hot-path gate.

  {
    const customTriggers: NameTriggers = { owner: ['owen'], bot: ['bram', 'bramley', 'fable'] };
    const pattern = buildPreCheckPattern(customTriggers);
    ok('custom trigger "fable" alone matches the pre-check pattern', pattern.test('is fable around?'));
    ok('default "owen" still matches the pre-check pattern', pattern.test("where's owen"));
    ok('default "bram" still matches the pre-check pattern', pattern.test('her bram'));
    ok('unrelated text does not match the pre-check pattern', !pattern.test('completely unrelated text'));
  }

  {
    // Regex-metachar custom trigger must never throw when building the pattern.
    const metaTriggers: NameTriggers = { owner: [], bot: ['a.b*c'] };
    let threw = false;
    let pattern: RegExp | null = null;
    try {
      pattern = buildPreCheckPattern(metaTriggers);
    } catch {
      threw = true;
    }
    ok('regex-metachar custom trigger does not throw building the pre-check pattern', !threw);
    ok('regex-metachar custom trigger matches its literal text', pattern !== null && pattern.test('saw a.b*c today'));
  }

  {
    // Both families empty → falls back to the hardcoded owen|bram pattern
    // (never a dead-end gate on a fully-cleared config).
    const emptyTriggers: NameTriggers = { owner: [], bot: [] };
    const pattern = buildPreCheckPattern(emptyTriggers);
    ok('empty trigger config falls back to matching "owen"', pattern.test('owen is here'));
    ok('empty trigger config falls back to matching "bram"', pattern.test('bram is here'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();
