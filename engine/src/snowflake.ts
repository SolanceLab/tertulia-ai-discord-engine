// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Discord snowflake arithmetic — used to find a message from its ID alone.
 *
 * Owner, 10 Aug 2026: *"I want the feature where the bot can sweep it based on
 * the message ID alone."*
 *
 * Discord has no "find this message anywhere" endpoint — every fetch is scoped
 * to a channel — so the only way to honour a bare message ID is to try it
 * against each channel until one answers. This module is what keeps that sweep
 * from being brute force.
 *
 * A snowflake is not a random identifier: its top 42 bits are a millisecond
 * timestamp since Discord's epoch, and IDs are monotonic across the platform.
 * Two facts fall out of that, and both are load-bearing:
 *
 *   1. A bare ID tells you WHEN it was created, with no lookup at all.
 *   2. A message cannot live in a channel that did not exist yet — so any
 *      channel whose own ID is NUMERICALLY GREATER than the message ID can be
 *      skipped without a request.
 *
 * ⚠️ What this canNOT do — the trap the Discord skill already records, which
 * cost a session on 25 Jul 2026: channel IDs and message IDs are structurally
 * IDENTICAL. Decoding one tells you nothing about which kind it is. Never use a
 * timestamp to decide "this must be a message" — that reads convincingly and
 * sends you hunting for something that was never there.
 */

/** Discord epoch: 2015-01-01T00:00:00Z, in ms. */
export const DISCORD_EPOCH = 1_420_070_400_000n;

/** Snowflakes are decimal digits only; anything else is not an ID. */
export function isSnowflake(id: unknown): id is string {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

/**
 * The creation time encoded in a snowflake.
 *
 * Returns null rather than throwing or guessing, so a caller handed junk
 * reports "not an ID" instead of a date in 1970.
 */
export function snowflakeToDate(id: string): Date | null {
  if (!isSnowflake(id)) return null;
  const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH;
  const asNumber = Number(ms);
  if (!Number.isFinite(asNumber)) return null;
  return new Date(asNumber);
}

/**
 * Could a message with this ID possibly live in this channel?
 *
 * False ONLY when the channel was created strictly after the message, which is
 * impossible. Everything else returns true — this prunes, it never decides.
 * Unparseable input returns true so a malformed channel ID is still searched
 * rather than silently skipped; a wasted request is much cheaper than a message
 * we swear does not exist.
 */
export function channelCouldHoldMessage(channelId: string, messageId: string): boolean {
  if (!isSnowflake(channelId) || !isSnowflake(messageId)) return true;
  return BigInt(channelId) <= BigInt(messageId);
}

/**
 * Order channels by how likely they are to hold the message.
 *
 * Nearest-created-first. A message is usually posted in a channel that existed
 * shortly before it rather than one created years earlier, so this tends to hit
 * early — and because the sweep stops on the first hit, ordering is the
 * difference between one request and thirty.
 */
export function orderBySearchLikelihood<T extends { id: string }>(
  channels: readonly T[],
  messageId: string,
): T[] {
  if (!isSnowflake(messageId)) return [...channels];
  const target = BigInt(messageId);
  return [...channels].sort((a, b) => {
    const da = isSnowflake(a.id) ? target - BigInt(a.id) : target;
    const db = isSnowflake(b.id) ? target - BigInt(b.id) : target;
    return da < db ? -1 : da > db ? 1 : 0;
  });
}
