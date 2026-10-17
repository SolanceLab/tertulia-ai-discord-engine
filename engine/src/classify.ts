// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * classify.ts — pure message-reference detection helpers (Plan 2b Task 2).
 *
 * NO network, NO Discord client state, NO side effects — these are the
 * building blocks the messageCreate wiring (a later run) will call. Every
 * function here must be safe to unit-test in isolation with plain stubs.
 *
 * §0.B Rule 4 (fail-closed author check) + §0.A0 (addressesOwner) live here
 * because both are pure predicates over already-extracted data.
 */

import { identity } from './config/identity.js';

/** Shape-compatible with discord.js Message.mentions — a stub `{ has: (id) => bool }` is enough in tests. */
export interface MentionsLike {
  has(id: string): boolean;
}

/** §0.E — the two-list name-trigger shape (owner family, bot family) (see presence-config.ts for the live config coercion). */
export interface NameTriggers {
  owner: string[];
  bot: string[];
}

export interface RefFlags {
  ownerHard: boolean;
  ownerSoft: boolean;
  botSoft: boolean;
  isFromOwner: boolean;
}

/** Escape a trigger string so it can never throw or over-match as a regex fragment. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary, case-insensitive test — a trigger glued inside another word (a longer name that ends in the trigger, Marianne) never fires. */
function matchesTrigger(content: string, trigger: string): boolean {
  const t = trigger.trim();
  if (!t) return false;
  const pattern = new RegExp(`\\b${escapeRegExp(t)}\\b`, 'i');
  return pattern.test(content);
}

function matchesAnyTrigger(content: string, triggers: string[]): boolean {
  return triggers.some((t) => matchesTrigger(content, t));
}

/**
 * buildPreCheckPattern — §0.C hot-path safety, P1 fix (2026-07-12 peer review).
 * The messageCreate cheap pre-check that gates whether classifyRefs runs at
 * all MUST be built from the SAME live `triggers` classifyRefs uses — the bug
 * caught in review was a hardcoded name pre-check that silently
 * ignored any configured custom trigger (e.g. a member added "fable"):
 * a message containing ONLY that custom trigger never reached classifyRefs,
 * so soft-presence never fired for it. Deliberately loose (plain substring,
 * no word-boundary, no escaping needed beyond regex-safety) — this only
 * decides whether the precise word-boundary classifyRefs runs; it is fine to
 * be over-inclusive. An empty/malformed trigger set (both families empty)
 * falls back to the deployment's fallback words (identity.precheck_fallback)
 * so the gate is never a dead end even on a fully-cleared config.
 */
/** The deployment's fallback words as a pattern; nothing configured → a pattern that never matches. */
export function fallbackPattern(): RegExp {
  const words = identity.precheck_fallback.map((w) => w.trim()).filter(Boolean);
  return words.length ? new RegExp(words.map(escapeRegExp).join('|'), 'i') : /(?!)/;
}

export function buildPreCheckPattern(triggers: NameTriggers): RegExp {
  const words = [...(triggers?.owner ?? []), ...(triggers?.bot ?? [])]
    .map((t) => String(t).trim())
    .filter(Boolean);
  if (words.length === 0) return fallbackPattern();
  return new RegExp(words.map(escapeRegExp).join('|'), 'i');
}

/**
 * classifyRefs — Task 2 Step 1. Pure classification of what a message references.
 * ownerHard = a real @mention of the owner. ownerSoft/botSoft = word-boundary name-drop matches.
 * isFromOwner = canonical string compare on author id.
 */
export function classifyRefs(
  content: string,
  mentions: MentionsLike,
  ownerUserId: string,
  authorId: string,
  triggers: NameTriggers,
): RefFlags {
  const text = content ?? '';
  return {
    ownerHard: mentions.has(ownerUserId),
    ownerSoft: matchesAnyTrigger(text, triggers.owner),
    botSoft: matchesAnyTrigger(text, triggers.bot),
    isFromOwner: authorId === ownerUserId,
  };
}

// §0.A0 reach/vocative patterns — a bare/declarative/incidental mention is NOT a reach.
// Vocative punctuation only (!, ?, ,) — NOT a bare trailing space, which would also
// match declarative openers like "the owner is the healthier one" (a mandated FALSE case).
const REACH_VERBS = "where('?s| is)?|get|fetch|tell|ask|call|need|want";
export function buildReachPatterns(names: string[] = identity.reach_names): RegExp[] {
  const alt = names.map((n) => n.trim()).filter(Boolean).map(escapeRegExp).join('|');
  if (!alt) return [];
  return [
    // Standalone `|is` deliberately removed (over-fires on declaratives like
    // "she is <name>'s friend"): `where('?s| is)?` already covers "where is <name>",
    // and the dedicated `is <name> (around|here|there)` pattern below covers
    // "is <name> around" — nothing is lost by dropping the bare `is\s+<name>` case.
    new RegExp(`\\b(${REACH_VERBS})\\s+(?:${alt})\\b`, 'i'),
    new RegExp(`^\\s*(?:${alt})[!?,]`, 'i'),
    new RegExp(`has anyone seen (?:${alt})`, 'i'),
    new RegExp(`is (?:${alt}) (around|here|there)`, 'i'),
  ];
}
const REACH_PATTERNS: RegExp[] = buildReachPatterns();

/**
 * addressesOwner — §0.A0. True ONLY for a message genuinely reaching for / summoning
 * The owner: ownerHard, or ownerSoft plus a reach/vocative pattern. Err HARD toward false.
 */
export function addressesOwner(refs: { ownerHard: boolean; ownerSoft: boolean }, content: string): boolean {
  if (refs.ownerHard) return true;
  if (!refs.ownerSoft) return false;
  const text = content ?? '';
  return REACH_PATTERNS.some((p) => p.test(text));
}

/**
 * isOwner — §0.B Rule 4. The register gate. FAIL-CLOSED: canonical STRING compare only
 * (never numeric/loose), false for null/undefined/empty/malformed authorId. When unsure, false.
 */
export function isOwner(authorId: string | null | undefined, ownerUserId: string): boolean {
  if (typeof authorId !== 'string' || authorId.length === 0) return false;
  if (typeof ownerUserId !== 'string' || ownerUserId.length === 0) return false;
  return authorId === ownerUserId;
}
