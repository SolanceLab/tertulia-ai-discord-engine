// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * away-tracker.ts — who has already heard that the owner is away, and where.
 *
 * Owner, 2026-10-03: the away notice (curfew counts as away) was telling the
 * same person the same thing every time they replied to her, and telling a
 * channel again an hour later. The old guard was a per-channel 30-minute
 * cooldown, so once it lapsed the line fired again. Her rule, in her words:
 * "if you already fired to the person or already said in the channel, you
 * don't fire again."
 *
 *   1. Mara mentions her in guest hall    → notice (Mara told, guest hall told)
 *   2. Mara mentions her in venting room  → silent (Mara already told)
 *   3. Teo mentions her in guest hall   → silent (guest hall already told)
 *   4. Teo mentions her in venting room → notice (neither told yet)
 *
 * A skipped reach marks nothing — Teo in step 3 was not told, so step 4
 * still reaches her.
 *
 * The memory lasts one AWAY STRETCH. A stretch is identified by what the
 * away-status says (source, status, reason, return time): when that changes,
 * or a read says she is not away, the tracker starts clean. Because tonight's
 * curfew reads exactly like tomorrow night's, a stretch also ends after
 * STRETCH_MAX_MS, so the next night begins fresh. In-memory only: a bot
 * restart forgets the stretch, which at worst repeats one notice.
 */

/** Longest one away stretch is remembered — longer than any curfew, shorter than a day. */
export const STRETCH_MAX_MS = 16 * 60 * 60_000;

/** The parts of an away-status read that identify one stretch. */
export interface StretchSignature {
  source: string;
  status: string;
  reason: string;
  untilLabel: string;
  /**
   * Whether her reason may be said. NOT part of the stretch key — flipping
   * "keep my reason private" is not a new stretch and re-tells nobody — but a
   * slow read may act only if its privacy bit matches the current one, so a
   * stale read can never put a reason she just made private into a reply.
   */
  shareable?: boolean;
}

/** Proof of one claim, tied to the stretch it was made in. */
export interface NoticeClaim { readonly epoch: number }

export interface AwayNoticeTracker {
  /**
   * Number an away-status read BEFORE awaiting it. Reads finish out of order;
   * `observe` drops any read older than one already applied, so a slow
   * "still away" can never undo a newer "she's back".
   */
  beginRead(): number;
  /**
   * Record what an away-status read said. A different stretch (or a stale
   * one) clears everything; `null` means not away, which also clears.
   * Returns whether the caller may act on its read: true when the read was
   * applied, or when a newer read already applied the SAME stretch (a slow
   * reach of the same night must still be answered — her step 4). False when
   * a newer read disagrees: the caller must say nothing.
   */
  observe(stretch: StretchSignature | null, readSeq?: number): boolean;
  /** True while the claim's stretch is still the current one — re-checked right before sending. */
  holds(claim: NoticeClaim): boolean;
  /**
   * Claim the notice for this guest in this channel. A claim = nobody has told
   * this guest, and nobody has spoken in this channel, during this stretch —
   * both are now marked. Null = one of them was already told; nothing marked.
   */
  tryClaim(guestId: string, channelId: string): NoticeClaim | null;
  /**
   * Undo a claim whose notice never reached the room (no clean draft, send
   * failed, or something threw). A no-op once the stretch has moved on, so a
   * late failure can never erase a newer stretch's marks.
   */
  release(guestId: string, channelId: string, claim: NoticeClaim): void;
  /** For logs and tests: what this stretch has covered so far. */
  snapshot(): { guests: string[]; channels: string[] };
}

export function stretchKey(s: StretchSignature): string {
  return [s.source, s.status, s.reason, s.untilLabel].map((p) => p ?? '').join('␟');
}

export function createAwayNoticeTracker(now: () => number = Date.now): AwayNoticeTracker {
  let key: string | null = null;
  let startedAt = 0;
  let epoch = 0;
  let nextRead = 0;
  let lastApplied = -1;
  let shareable: boolean | undefined;
  const guests = new Set<string>();
  const channels = new Set<string>();

  const reset = (next: string | null) => {
    key = next;
    startedAt = now();
    epoch++;
    guests.clear();
    channels.clear();
  };

  return {
    beginRead() {
      return nextRead++;
    },
    observe(stretch, readSeq) {
      if (readSeq !== undefined) {
        if (readSeq < lastApplied) {
          // A newer read already spoke. Act on this one only if it agrees —
          // same stretch, same privacy bit, stretch not yet past its age cap.
          // A stale read never writes.
          return stretch !== null && key !== null && stretchKey(stretch) === key
            && stretch.shareable === shareable
            && now() - startedAt <= STRETCH_MAX_MS;
        }
        lastApplied = readSeq;
      }
      if (!stretch) {
        if (key !== null) reset(null);
        shareable = undefined;
        return true;
      }
      const next = stretchKey(stretch);
      if (next !== key || now() - startedAt > STRETCH_MAX_MS) reset(next);
      shareable = stretch.shareable;
      return true;
    },
    holds(claim) {
      return claim.epoch === epoch;
    },
    tryClaim(guestId, channelId) {
      if (guests.has(guestId) || channels.has(channelId)) return null;
      guests.add(guestId);
      channels.add(channelId);
      return { epoch };
    },
    release(guestId, channelId, claim) {
      if (claim.epoch !== epoch) return;
      guests.delete(guestId);
      channels.delete(channelId);
    },
    snapshot() {
      return { guests: [...guests], channels: [...channels] };
    },
  };
}
