// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * speaker-lock.ts — §0.A single-speaker lock. Every message gets AT MOST one
 * channel reply: a per-messageId claim, in-memory, TTL-pruned, bounded. Claimed
 * by whichever path actually SENDS — the away branch's reply (cloud-server.ts's
 * `on('away-inquiry', ...)` send site) and soft-presence's reply
 * (discord-client.ts's `considerChannel`, when a triggering message is
 * supplied) — a claimed message blocks the others. Routing between away and
 * soft-presence is already mutually exclusive by construction (Task 2 Step 2),
 * so this lock is defense-in-depth against a race, not the primary guard for
 * that pair. Also claimed by the curfew reflex's nudge send
 * (discord-client.ts's `handleCurfewCheck`, P1 fix 2026-07-12 review) —
 * curfew fires unconditionally for every the owner message and can race
 * soft-presence for a message that is both past-curfew and contains a
 * The bot-trigger word (botSoft fires regardless of who's speaking), with no
 * upstream mutual exclusion between the two, so for that pair the lock IS
 * the primary guard, not defense-in-depth.
 *
 * The mention/dm pipeline is untouched: it `return`s at the existing gate
 * BEFORE the classifier runs, so it never shares a messageId with either new
 * path and never needs this lock.
 */

const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 500;

export interface SpeakerLock {
  /** true = this call claimed the message (the caller may speak); false = someone already claimed it. */
  tryClaimSpeaker(messageId: string): boolean;
  /**
   * Release a claim after a FAILED send (codex P1, 2026-07-12 escalation):
   * without this, claim-then-failed-send blackholes the message for the full
   * TTL — a concurrent path that could have delivered is blocked and the
   * message gets no reply at all. Call ONLY when the claimed send did not
   * land; a successful send keeps its claim for the TTL.
   */
  releaseClaim(messageId: string): void;
  /** Read-only peek: has some path already claimed this message? Used to keep typing off a reply that will not come. */
  isClaimed(messageId: string): boolean;
}

/**
 * Factory (injectable clock) so the lock is directly unit-testable without
 * waiting on a real 5-minute TTL. Bounded: once the map exceeds `maxEntries`,
 * the oldest claim (by insertion order) is evicted so a long-running process
 * can't leak memory.
 */
export function createSpeakerLock(
  now: () => number = () => Date.now(),
  ttlMs = TTL_MS,
  maxEntries = MAX_ENTRIES,
): SpeakerLock {
  const claims = new Map<string, number>(); // messageId -> expiresAtMs

  function prune(nowMs: number): void {
    for (const [id, expiresAt] of claims) {
      if (expiresAt <= nowMs) claims.delete(id);
    }
  }

  return {
    tryClaimSpeaker(messageId: string): boolean {
      const nowMs = now();
      prune(nowMs);
      if (claims.has(messageId)) return false;
      claims.set(messageId, nowMs + ttlMs);
      if (claims.size > maxEntries) {
        const oldest = claims.keys().next().value;
        if (oldest !== undefined) claims.delete(oldest);
      }
      return true;
    },
    releaseClaim(messageId: string): void {
      claims.delete(messageId);
    },
    isClaimed(messageId: string): boolean {
      prune(now());
      return claims.has(messageId);
    },
  };
}

/**
 * ONE shared instance for the whole process — away's send site (cloud-server.ts)
 * and soft-presence's send site (discord-client.ts's considerChannel) must
 * arbitrate against the SAME lock, not two independent ones.
 */
export const speakerLock = createSpeakerLock();
