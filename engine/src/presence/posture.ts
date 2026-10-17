// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { HOS_SERVER_ID, CHANNEL_POSTURE } from './house.js';
import { isAmbientStep, type Step, normalizeStep, RATE, type AmbientStep } from './steps.js';
import type { ResolvedServer } from './servers.js';

// ── One ladder (Owner, 2026-10-17; specs/2026-10-17-discord-one-ladder.md) ───
// How much the bot talks is one step, set at three levels: the House dial, a server, a channel.
//   silent | reply_only | reserved | balanced | sociable | chatty
// The effective step of a channel is: channel ?? server ?? House dial. Old channel words
// (off/reactive/gentle/moderate/high/full) are read as steps by normalizeStep, never rewritten.
export type { Step, AmbientStep };
export { RATE };
/** Kept as an alias: the per-channel value IS a step now. */
export type Posture = Step;
export type ChannelSetting = Step;
export type AmbientLevel = AmbientStep;

export { HOS_SERVER_ID, CHANNEL_POSTURE };

/**
 * The channel's OWN live step, or undefined for "same as server". Keys: the channel id (the current
 * hos-app save shape), then the channel name (legacy). Old words are read as steps; a junk value is
 * skipped, so it falls through exactly as if the key were absent and can never poison a room.
 */
export function liveChannelSetting(
  channelId: string,
  channelName: string | undefined,
  cfg?: { posture?: Record<string, string> },
): Step | undefined {
  const live = cfg?.posture;
  if (!live) return undefined;
  const byId = normalizeStep(live[channelId]);
  if (byId) return byId;
  if (channelName !== undefined) {
    const byName = normalizeStep(live[channelName]);
    if (byName) return byName;
  }
  return undefined;
}

/** Same answer as liveChannelSetting, kept under its old name for the callers that inject their own fallback. */
export const livePostureOverride = liveChannelSetting;

/**
 * resolvePosture — the channel's own step, live key first, then the House seed map (CHANNEL_POSTURE,
 * legacy words read as steps), else reply_only (a channel nobody set up is mentioned-only, never ambient).
 * The server and the House dial sit BELOW this layer: see effectiveStep.
 */
export function resolvePosture(
  channelId: string,
  channelName: string | undefined,
  cfg?: { posture?: Record<string, string> },
): Step {
  return channelSeedStep(channelId, channelName, cfg) ?? 'reply_only';
}

/** The channel layer alone: live key, else the House seed map; undefined = nothing says. */
export function channelSeedStep(
  channelId: string,
  channelName: string | undefined,
  cfg?: { posture?: Record<string, string> },
): Step | undefined {
  return liveChannelSetting(channelId, channelName, cfg) ?? normalizeStep(CHANNEL_POSTURE[channelId]);
}

/** The House dial as a step: `step` wins; the old 0-4 `presence_level` was already mapped when the config was parsed. */
export function houseStep(cfg: { step: Step }): Step {
  return cfg.step;
}

/**
 * effectiveStep — the ONE answer to "how much does he talk in this channel?":
 * channel (live key, else the House seed map) ?? server ?? House dial.
 */
export function effectiveStep(
  channelId: string,
  channelName: string | undefined,
  cfg: { posture?: Record<string, string>; step: Step },
  server: Pick<ResolvedServer, 'step'> | null | undefined,
): Step {
  return channelSeedStep(channelId, channelName, cfg) ?? server?.step ?? houseStep(cfg);
}

/**
 * channelBehaviour — what a step lets the bot do:
 *   silent     -> nothing: no ambient, no answer to others (the owner's own mention is handled elsewhere);
 *   reply_only -> mentions answered, never starts;
 *   ambient    -> that step, plus mentions answered.
 */
export function channelBehaviour(step: Step): { ambient: false | AmbientStep; answerMentions: boolean } {
  if (step === 'silent') return { ambient: false, answerMentions: false };
  if (isAmbientStep(step)) return { ambient: step, answerMentions: true };
  return { ambient: false, answerMentions: true };
}

// Channels with no explicit step default to reply_only here — I do not drift into a
// room I haven't been told to be present in. Implemented in terms of resolvePosture (no config in
// hand) so the two can never drift apart.
export function postureFor(channelId: string): Step {
  return resolvePosture(channelId, undefined, undefined);
}

/**
 * Whether an image posted in this room may be sent to a third-party model.
 *
 * THE OWNER'S RULING (2026-08-29, verbatim): "I dont want to stop you from seeing
 * attachment, period, whatever the level of activity / reactivity you are.
 * What I want is to determine how chatty are you." Posture governs CHATTINESS
 * only — it has NO bearing on sight, at any posture, in any mapped or
 * unmapped room. The only thing that still gates image egress is the guild:
 *
 *  - Other guilds are never in scope. This bot account is a guest in servers
 *    that are not ours (Algorithm Atelier, Arcadia). Their members' images are
 *    not ours to forward anywhere.
 *  - Every room inside the House is in scope, mapped or not, at every
 *    step, silent included. The bot reads and answers both the words
 *    and the pictures in a support room, same as anywhere else in the
 *    House.
 */
export function imageEgressAllowed(guildId: string | null | undefined, channelId: string): boolean {
  return guildId === HOS_SERVER_ID;
}

// Whether the ambient heartbeat should even consider a channel: only an ambient step is swept.
// Called with no name/cfg this reads the House seed map alone (servers and the dial are not in hand).
export function ambientEligible(
  channelId: string,
  channelName?: string,
  cfg?: { posture?: Record<string, string> },
): boolean {
  return isAmbientStep(resolvePosture(channelId, channelName, cfg));
}
