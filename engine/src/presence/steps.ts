// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * steps.ts — the ONE ladder for how much the bot talks (specs/2026-10-17-discord-one-ladder.md).
 *
 * Six steps, used at three levels (the big dial, a server, a channel). A step sets how willing the bot
 * is to speak, never how light it sounds. No imports: house-config, servers and posture all read it.
 *
 *   silent     doesn't speak here, except to answer the owner
 *   reply_only answers when mentioned, never starts
 *   reserved / balanced / sociable / chatty   ambient, from rare to free
 */

export type Step = 'silent' | 'reply_only' | 'reserved' | 'balanced' | 'sociable' | 'chatty';
export type AmbientStep = 'reserved' | 'balanced' | 'sociable' | 'chatty';

export const STEPS: readonly Step[] = ['silent', 'reply_only', 'reserved', 'balanced', 'sociable', 'chatty'];
export const AMBIENT_STEPS: readonly AmbientStep[] = ['reserved', 'balanced', 'sociable', 'chatty'];

const STEP_SET = new Set<string>(STEPS);
export function isStep(v: unknown): v is Step {
  return typeof v === 'string' && STEP_SET.has(v);
}

/** The old dial (0-4) as a step: 0 still answered mentions, so it is reply_only. */
const LEVEL_STEPS: readonly Step[] = ['reply_only', 'reserved', 'balanced', 'sociable', 'chatty'];
export function stepFromLevel(level: unknown): Step | undefined {
  return Number.isInteger(level) && (level as number) >= 0 && (level as number) <= 4 ? LEVEL_STEPS[level as number] : undefined;
}

/**
 * Legacy channel words, read as steps. gentle/moderate/high/full all became reserved: the gates that
 * actually bound (12-minute stale window, no re-engage) were level-driven, so every ambient room behaved
 * as Reserved already (checked live 17 Oct).
 */
const LEGACY_STEPS: Record<string, Step> = {
  off: 'silent', reactive: 'reply_only', gentle: 'reserved', moderate: 'reserved', high: 'reserved', full: 'reserved',
};

/** A stored channel value (a step, or an old posture word) as a step; undefined for anything else. */
export function normalizeStep(v: unknown): Step | undefined {
  if (isStep(v)) return v;
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_STEPS, v) ? LEGACY_STEPS[v] : undefined;
}

/** Whether the step lets the bot start a conversation. */
export function isAmbientStep(s: Step | undefined): s is AmbientStep {
  return s === 'reserved' || s === 'balanced' || s === 'sociable' || s === 'chatty';
}

/** The old 1-4 level an ambient step stood for (the gates that read a level read this). */
export function ambientLevelOf(s: AmbientStep): number {
  return AMBIENT_STEPS.indexOf(s) + 1;
}

/** Rate caps per ambient step. The hourly cap rarely binds (the 30-minute sweep does); it is the backstop. */
export const RATE: Record<AmbientStep, { maxPerHour: number; minGapMs: number }> = {
  reserved: { maxPerHour: 2,  minGapMs: 20 * 60_000 },
  balanced: { maxPerHour: 4,  minGapMs: 12 * 60_000 },
  sociable: { maxPerHour: 6,  minGapMs: 8 * 60_000 },
  chatty:   { maxPerHour: 12, minGapMs: 4 * 60_000 },
};
