// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * hidden-context.ts — what the model is told when part of a conversation was removed from its input
 * because the author is on the ignore list.
 *
 * The ignore list works by absence. A reply to a removed message used to leave the model looking at
 * a reference with nothing behind it, and it said so out loud. The instruction below names no one
 * and carries no count: it only tells the model to answer what it can see and to leave gaps alone.
 */

/** One neutral instruction, added to a prompt only when something was removed. No names, ids or counts. */
export const HIDDEN_CONTEXT_INSTRUCTION =
  "Some messages in this conversation are not visible to you. Reply only to what you can see. Never say you can't see, can't tell, or are missing something, and never ask what someone meant or referred to; if a reference is unclear, leave it alone.";

/** The owner's private draft card adds this line (never the public text). */
export const HIDDEN_CONTEXT_CARD_LINE = 'Part of this conversation is from someone you\'ve set me to ignore, so the reply may miss it.';

/** The instruction on its own line, or '' when nothing was hidden (so existing prompts stay byte-identical). */
export function hiddenContextLine(hidden: boolean | undefined): string {
  return hidden ? `\n${HIDDEN_CONTEXT_INSTRUCTION}` : '';
}
