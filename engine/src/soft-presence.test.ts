// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * soft-presence.test.ts — Plan 2b Task 4 (§8.2 soft-mention presence) + the
 * §0.A single-speaker lock. Run: npx tsx src/soft-presence.test.ts
 */
import './test-env.js';
import { type ConsiderChannelOpts, type SoftPresenceEvent, type SoftPresenceDeps, createJudgeDebounce, handleSoftPresence } from './soft-presence.js';
import { createSpeakerLock } from './speaker-lock.js';
import { addressesOwner, classifyRefs } from './classify.js';
import type { Step } from './presence/steps.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const OWNER_ID = 'owen-id-123';
const GUEST_ID = 'guest-456';

function makeEvent(overrides: Partial<SoftPresenceEvent> = {}): SoftPresenceEvent {
  return {
    channelId: 'chan-1',
    channelName: 'guest-hall',
    messageId: 'msg-1',
    authorId: GUEST_ID,
    content: 'anyone seen bram?',
    timestampMs: 1_000_000,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SoftPresenceDeps> = {}): SoftPresenceDeps & {
  calls: { channelId: string; channelName: string; opts: ConsiderChannelOpts }[];
} {
  const calls: { channelId: string; channelName: string; opts: ConsiderChannelOpts }[] = [];
  const base: SoftPresenceDeps = {
    stepFor: (_channelId: string, _channelName: string) => 'balanced' as Step,
    tryClaimJudgeDebounce: () => true,
    considerChannel: async (channelId, channelName, opts) => {
      calls.push({ channelId, channelName, opts });
    },
    isOwner: (authorId: string) => authorId === OWNER_ID,
  };
  return { ...base, ...overrides, calls };
}

async function run() {
  // ── Cheap gates, zero Sanctum calls ─────────────────────────────────────
  // ── One ladder (specs/2026-10-17-discord-one-ladder.md): only an ambient step wakes the judge ──
  for (const step of ['reserved', 'balanced', 'sociable', 'chatty'] as Step[]) {
    const deps = makeDeps({ stepFor: () => step });
    await handleSoftPresence(makeEvent(), deps);
    ok(`${step} → considerChannel IS invoked`, deps.calls.length === 1);
  }
  for (const step of ['silent', 'reply_only'] as Step[]) {
    const deps = makeDeps({ stepFor: () => step });
    await handleSoftPresence(makeEvent(), deps);
    ok(`${step} → considerChannel (and therefore any judge/Sanctum call) never invoked`, deps.calls.length === 0);
  }
  {
    // The step is asked for THIS channel by id and name (the caller resolves channel ?? server ?? House).
    const asked: string[] = [];
    const deps = makeDeps({ stepFor: (id, name) => { asked.push(`${id}/${name}`); return 'balanced' as Step; } });
    await handleSoftPresence(makeEvent(), deps);
    ok('stepFor is asked about the event\'s channel id and name', asked.join() === 'chan-1/guest-hall');
  }

  // ── Triggering-message payload merged in as a WindowMessage ─────────────
  {
    const deps = makeDeps();
    const event = makeEvent({ messageId: 'trigger-msg', content: 'her bram is around', authorId: GUEST_ID, timestampMs: 42 });
    await handleSoftPresence(event, deps);
    const call = deps.calls[0];
    ok('considerChannel called with the triggering message merged in', call.opts.triggerMessage?.id === 'trigger-msg');
    ok('triggering message content carried through', call.opts.triggerMessage?.content === 'her bram is around');
    ok('triggering message timestamp carried through', call.opts.triggerMessage?.timestampMs === 42);
    ok('triggering message isFromOwner resolved via isOwner(authorId)', call.opts.triggerMessage?.isFromOwner === false);
    ok('claimMessageId passed through so the send site can lock it', call.opts.claimMessageId === 'trigger-msg');
  }
  {
    // Owen saying "bram" — botSoft from Owen is fine; isFromOwner on the
    // merged trigger message reflects that (isOwner(authorId) === true).
    const deps = makeDeps();
    const event = makeEvent({ authorId: OWNER_ID, content: 'bram, come here' });
    await handleSoftPresence(event, deps);
    ok('Owen-authored trigger message resolves isFromOwner true on the merged entry', deps.calls[0].opts.triggerMessage?.isFromOwner === true);
  }

  {
    // An ineligible (silent) name-drop must not burn the debounce window.
    const debounce = createJudgeDebounce();
    const offDeps = makeDeps({ tryClaimJudgeDebounce: debounce.tryClaim, stepFor: () => 'silent' as Step });
    await handleSoftPresence(makeEvent({}), offDeps);
    ok('silent channel → judge not woken', offDeps.calls.length === 0);
    ok('silent suppression does not claim the debounce', debounce.tryClaim('chan-1') === true);
  }
  // ── Judge-execution debounce (§0.D) — a burst runs the judge AT MOST once ─
  {
    const debounce = createJudgeDebounce();
    const deps = makeDeps({ tryClaimJudgeDebounce: debounce.tryClaim });
    for (let i = 0; i < 10; i++) {
      await handleSoftPresence(makeEvent({ messageId: `burst-${i}` }), deps);
    }
    ok('60s debounce: 10 rapid soft-mentions in one channel → considerChannel invoked at most once', deps.calls.length === 1);
  }
  {
    // A different channel is NOT suppressed by another channel's debounce claim.
    const debounce = createJudgeDebounce();
    const deps = makeDeps({ tryClaimJudgeDebounce: debounce.tryClaim });
    await handleSoftPresence(makeEvent({ channelId: 'chan-a' }), deps);
    await handleSoftPresence(makeEvent({ channelId: 'chan-b' }), deps);
    ok('debounce is per-channel — a second channel still runs', deps.calls.length === 2);
  }
  {
    // Injectable clock: past the debounce window, a second run is allowed.
    let clock = 0;
    const debounce = createJudgeDebounce(() => clock);
    const deps = makeDeps({ tryClaimJudgeDebounce: debounce.tryClaim });
    await handleSoftPresence(makeEvent({ messageId: 'a' }), deps);
    clock += 61_000;
    await handleSoftPresence(makeEvent({ messageId: 'b' }), deps);
    ok('debounce: past the 60s window → a second judge run is allowed', deps.calls.length === 2);
  }
  {
    // A debounced second call does not wake the judge again.
    const debounce = createJudgeDebounce();
    const deps = makeDeps({ tryClaimJudgeDebounce: debounce.tryClaim });
    await handleSoftPresence(makeEvent({ messageId: 'first' }), deps);
    await handleSoftPresence(makeEvent({ messageId: 'second' }), deps);
    ok('debounced second call does not wake the judge again', deps.calls.length === 1);
  }

  // ── Routing: soft-presence classification (Task 2 Step 2 / classifyRefs) ─
  {
    const triggers = { owner: ['owen'], bot: ['bram', 'bramley'] };
    const mentions = { has: () => false };

    const guestBot = classifyRefs('her bram is nice', mentions, OWNER_ID, GUEST_ID, triggers);
    ok('guest saying "bram" → botSoft true (would route to soft-presence)', guestBot.botSoft === true);

    const botFromOwner = classifyRefs('bram, come here', mentions, OWNER_ID, OWNER_ID, triggers);
    ok('Owen saying "bram" → botSoft true, isFromOwner true (soft-presence still fires — botSoft from Owen is fine)',
      botFromOwner.botSoft === true && botFromOwner.isFromOwner === true);

    const ownerOwner = classifyRefs('owen is tired today', mentions, OWNER_ID, OWNER_ID, triggers);
    ok('Owen naming herself ("owen") → the !isFromOwner guard means this must NOT route to soft-presence',
      ownerOwner.ownerSoft === true && ownerOwner.isFromOwner === true);
    // The routing predicate itself (mirrors discord-client.ts's else-if):
    const wouldRouteSoft = ownerOwner.botSoft || (ownerOwner.ownerSoft && !ownerOwner.isFromOwner);
    ok('routing predicate confirms Owen\'s own bare "owen" does not wake soft-presence', wouldRouteSoft === false);

    const guestOwner = classifyRefs('owen is tired today', mentions, OWNER_ID, GUEST_ID, triggers);
    const guestWouldRouteSoft = guestOwner.botSoft || (guestOwner.ownerSoft && !guestOwner.isFromOwner);
    ok('a guest saying a bare, non-reaching "owen" DOES wake soft-presence', guestWouldRouteSoft === true);
  }

  // ── Away-claimed message does not ALSO emit soft-presence (mutual exclusion) ─
  {
    // Mirrors discord-client.ts's if/else-if EXACTLY (including the else-if
    // only being reached when the away branch didn't fire) — a guest @-hard-
    // mentioning Owen routes to away, and because it's an else-if (not two
    // independent ifs), soft-presence is structurally unreachable for that
    // same message even though ownerSoft also happens to be true here (the
    // literal word "Owen" appears in "@Owen where are you" too).
    const triggers = { owner: ['owen'], bot: ['bram', 'bramley'] };
    const mentions = { has: (id: string) => id === OWNER_ID };
    const content = '@Owen where are you';
    const refs = classifyRefs(content, mentions, OWNER_ID, GUEST_ID, triggers);
    ok('sanity: ownerSoft is ALSO true on this message (the word "Owen" appears)', refs.ownerSoft === true);

    let route: 'away' | 'soft' | 'none' = 'none';
    if (!refs.isFromOwner && addressesOwner(refs, content)) {
      route = 'away';
    } else if (refs.botSoft || (refs.ownerSoft && !refs.isFromOwner)) {
      route = 'soft';
    }
    ok('an away-routed message (ownerHard) never ALSO routes to soft-presence — the else-if makes them mutually exclusive',
      route === 'away');
  }

  // ── Single-speaker lock (§0.A) ──────────────────────────────────────────
  {
    const lock = createSpeakerLock();
    ok('first claim for a messageId → true', lock.tryClaimSpeaker('m1') === true);
    ok('second claim for the SAME messageId → false', lock.tryClaimSpeaker('m1') === false);
    ok('a different messageId is unaffected', lock.tryClaimSpeaker('m2') === true);
    // releaseClaim (codex P1, 2026-07-12 escalation): a failed send must free
    // the claim so another path can deliver — no TTL-long blackhole.
    lock.releaseClaim('m1');
    ok('after releaseClaim the messageId is claimable again', lock.tryClaimSpeaker('m1') === true);
    lock.releaseClaim('never-claimed');
    ok('releaseClaim on an unclaimed id is a harmless no-op', lock.tryClaimSpeaker('never-claimed') === true);
  }
  {
    // Pruning: injectable clock, TTL of 1000ms for a fast test.
    let clock = 0;
    const lock = createSpeakerLock(() => clock, 1_000);
    ok('claim before TTL expiry', lock.tryClaimSpeaker('m1') === true);
    ok('re-claim before TTL expiry still blocked', lock.tryClaimSpeaker('m1') === false);
    clock += 1_001;
    ok('after TTL expiry, the same messageId can be claimed again (pruned)', lock.tryClaimSpeaker('m1') === true);
  }
  {
    // Bounded map: exceeding maxEntries evicts the oldest claim.
    let clock = 0;
    const lock = createSpeakerLock(() => clock, 5 * 60_000, 3);
    ok('claim 1', lock.tryClaimSpeaker('a') === true);
    ok('claim 2', lock.tryClaimSpeaker('b') === true);
    ok('claim 3', lock.tryClaimSpeaker('c') === true);
    ok('claim 4 (exceeds bound, evicts oldest "a")', lock.tryClaimSpeaker('d') === true);
    ok('"a" was evicted — can be re-claimed even though its TTL had not elapsed', lock.tryClaimSpeaker('a') === true);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
run();
