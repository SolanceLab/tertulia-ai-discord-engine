// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * soft-presence.ts — Plan 2b Task 4, §8.2: a name-drop wakes the presence judge
 * in real time instead of waiting up to `sweep_minutes`.
 *
 * Fully dependency-injected (mirrors away-handler.ts) so the orchestration —
 * the judge-execution debounce (§0.D) + the cheap step gate
 * (zero Sanctum calls) + handing off to the SHARED `considerChannel` — unit-
 * tests without a live Discord client or Sanctum. discord-client.ts owns the
 * real `considerChannel` (fetch the window, merge the triggering message, run
 * `engine.judge()`, post + claim the single-speaker lock on speak); this
 * module never calls Discord or Sanctum directly.
 */
import type { WindowMessage } from './presence-engine.js';
import type { Step } from './presence/steps.js';
import { isAmbientStep } from './presence/steps.js';

/** Emitted by discord-client.ts's messageCreate classifier (Task 2 Step 2). */
export interface SoftPresenceEvent {
  channelId: string;
  channelName: string;
  messageId: string;
  authorId: string;
  content: string;
  timestampMs: number;
}

export interface ConsiderChannelOpts {
  triggerMessage?: WindowMessage;
  claimMessageId?: string;
}

export interface SoftPresenceDeps {
  /**
   * The channel's effective step (channel ?? server ?? House dial), resolved by the caller. The ONE
   * answer the sweep uses too (discord-client channelRules), so the two paths cannot disagree.
   */
  stepFor: (channelId: string, channelName: string) => Step;
  /** Judge-execution debounce (§0.D) — reserve BEFORE any gate/work; false = a run already claimed this channel within the window. */
  tryClaimJudgeDebounce: (channelId: string) => boolean;
  /** The SAME considerChannel the ambient sweep uses (discord-client.ts) — soft-presence can never bypass its gates. */
  considerChannel: (channelId: string, channelName: string, opts: ConsiderChannelOpts) => Promise<void>;
  isOwner: (authorId: string) => boolean;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * handleSoftPresence — Task 4 Step 2/3 orchestration. Order (§0.D + Step 3/4):
 * (a) the step check runs first, then the debounce is reserved before any other work; (b) the
 * rate and stale gates live inside the judge — ZERO Sanctum calls when they block; (c) only then
 * hand off to the shared `considerChannel` with the triggering message merged
 * in. Wakes the judge ONLY — never forces a reply, never shortcuts to respond().
 */
export async function handleSoftPresence(event: SoftPresenceEvent, deps: SoftPresenceDeps): Promise<void> {
  // Only an ambient step wakes the judge: silent and reply_only never start a conversation, and an
  // ineligible name-drop must not burn the debounce window.
  const step = deps.stepFor(event.channelId, event.channelName);
  if (!isAmbientStep(step)) {
    deps.log?.('soft-presence suppressed — step does not allow ambient', { channelId: event.channelId, step });
    return;
  }

  // (a) Judge-execution debounce — a thread typing "bot" ten times in a
  // minute runs the judge AT MOST once (§0.D). Claimed only AFTER the eligibility check, so an
  // ineligible name-drop never burns the window.
  if (!deps.tryClaimJudgeDebounce(event.channelId)) {
    deps.log?.('soft-presence debounced', { channelId: event.channelId });
    return;
  }

  // (c) Wake the judge via the SAME code path the ambient sweep uses, with the
  // triggering message merged in so the judge sees the name-drop that woke it
  // (a bare channel wake can otherwise race a window that doesn't yet contain
  // it — reviewer). The payload is deliberately thin (§0.C — no extra Discord
  // fetch on the message hot path), so the merged entry falls back to the raw
  // author id for its display name; considerChannel's own window fetch
  // supplies real display names for every other message in the transcript.
  const triggerMessage: WindowMessage = {
    id: event.messageId,
    authorId: event.authorId,
    authorName: event.authorId,
    content: event.content,
    isFromOwner: deps.isOwner(event.authorId),
    isFromMe: false,
    timestampMs: event.timestampMs,
  };

  await deps.considerChannel(event.channelId, event.channelName, {
    triggerMessage,
    claimMessageId: event.messageId,
  });
}

/**
 * createJudgeDebounce — §0.D judge-execution debounce factory. Bounded,
 * TTL-pruned, injectable clock so it unit-tests without waiting on the real
 * window. `tryClaim` returns true AT MOST once per channel per `windowMs`.
 */
export function createJudgeDebounce(
  now: () => number = () => Date.now(),
  windowMs = 60_000,
  maxEntries = 200,
) {
  const lastAt = new Map<string, number>();
  return {
    tryClaim(channelId: string): boolean {
      const nowMs = now();
      const last = lastAt.get(channelId);
      if (last !== undefined && nowMs - last < windowMs) return false;
      lastAt.set(channelId, nowMs);
      if (lastAt.size > maxEntries) {
        for (const [id, t] of lastAt) {
          if (nowMs - t >= windowMs) lastAt.delete(id);
        }
      }
      return true;
    },
  };
}
