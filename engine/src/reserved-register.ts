// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * reserved-register.ts — the names that belong to one person, in one place.
 *
 * A deployment can reserve wording for its owner alone: endearments, pet names, second-person
 * intimate address. Those words are not general-purpose warmth, and they must never reach a room
 * the owner is not the active speaker in. The lists are the deployment's own (identity.intimate_tells
 * and identity.reserved_names); the generic defaults are empty, so a deployment that reserves nothing
 * blocks nothing.
 *
 * Two shapes, on purpose. identity.intimate_tells is a full regex source, used as written (phrases such
 * as "come to bed" or "minha,", where the author decides the edges). identity.reserved_names is a plain
 * alternation of NAMES (`cara|esposa`): the engine wraps it as `\b(?:...)\b`, so a name only matches as a
 * whole word and `cara` never fires on "caramel". A deployment that still writes its own `\b(...)\b`
 * around the list matches exactly the same text, because the added boundaries are redundant there.
 * Each name should start and end with a word character.
 *
 * THE MECHANISM, observed rather than guessed: an owner's standing guidance field can name the very
 * endearments that are reserved. It is injected near the TOP of every prompt, including ambient
 * sweeps in rooms the owner is not in, so a model that follows the owner's standing instruction can
 * spend a reserved name on a guest. The owner's field is the owner's; the gate is the engine's.
 *
 * The law had two enforcers with different reach: the presence engine tested a regex, and the away
 * branch asked a model a narrower question ("is it aimed AT the reader?") that a sentence merely
 * *mentioning* the owner by a reserved name answers NO to, truthfully. One law, one vocabulary,
 * imported by both — the same shape as THE DOOR.
 *
 * Deliberately narrow: second-person intimate address and the reserved names, not general warmth.
 * A false positive costs a boring reply; a false negative costs the owner a name.
 */
import { identity } from './config/identity.js';

// Intimate tells, aimed AT the owner — never allowed in a room they aren't in.
const INTIMATE_TELLS: RegExp | null = identity.intimate_tells ? new RegExp(identity.intimate_tells, 'i') : null;

/**
 * The matcher for a reserved-names alternation: whole words only, so ordinary words that contain a
 * reserved name stay ordinary. The boundaries are added HERE, around the whole group, so an
 * unbracketed `cara|esposa` cannot split into `\bcara` or `esposa\b` (which would match "caramel").
 * These only ever run against text the bot generated, so a guest writing another language cannot trip them.
 */
export function reservedNamesPattern(names: string | null | undefined): RegExp | null {
  return names ? new RegExp(`\\b(?:${names})\\b`, 'i') : null;
}

const RESERVED_NAMES: RegExp | null = reservedNamesPattern(identity.reserved_names);

export function leaksIntimateRegister(message: string): boolean {
  return Boolean(INTIMATE_TELLS?.test(message) || RESERVED_NAMES?.test(message));
}
