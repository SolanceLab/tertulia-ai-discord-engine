// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { formatTranscriptMessage } from './window.js';
import type { WindowMessage } from './window.js';

// ── Sticker vocabulary (Owner, 2026-07-11) ───────────────────────────────────
// HoS server stickers may be used as vocabulary in normal Discord talk — the
// model chooses when, sparingly, like a person. A sticker is described to the
// model as {id, name, description}; the model only ever returns a NAME (never
// trust a raw id it invents), mapped case-insensitively against the roster.
export interface StickerInfo {
  id: string;
  name: string;
  description?: string | null;
}

/**
 * Remove only exact speaker-labelled transcript entries from the beginning of
 * a generated answer. References or quotations later in the answer survive.
 */
/**
 * The private aside's answer has two parts (Owner, 12 Oct): what I say to HER (never posted), and
 * an optional message proposed for the channel (posted only when she taps). Strict format:
 *   NOTE:\n<to the owner>\nPROPOSED:\n<channel message | NONE>
 * Anything unparseable becomes a note with NO proposal — a malformed answer can never post.
 */
export function parseAside(text: string): { note: string; proposal: string | null } {
  const raw = (text ?? '').trim();
  const m = raw.match(/^\s*NOTE:\s*([\s\S]*?)\n\s*PROPOSED:\s*([\s\S]*)$/i);
  if (!m) return { note: raw, proposal: null };
  const note = m[1].trim();
  const proposed = m[2].trim();
  const proposal = !proposed || /^none\.?$/i.test(proposed) ? null : proposed;
  return { note: note || (proposal ? '' : raw), proposal };
}

export function stripLeadingTranscriptEcho(text: string, window: WindowMessage[]): string {
  let reply = text.trim();
  const entries = window
    .filter((message) => message.content.trim())
    .map(formatTranscriptMessage)
    .sort((a, b) => b.length - a.length);

  while (reply) {
    const echoed = entries.find((entry) => (
      reply === entry
      || reply.startsWith(`${entry}\n`)
      || reply.startsWith(`${entry}\r\n`)
    ));
    if (!echoed) break;
    reply = reply.slice(echoed.length).replace(/^(?:[ \t]*\r?\n)+/, '').trimStart();
  }
  return reply.trim();
}

// Direct-reply skip contract (Owner, 2026-10-01). A passing mention used to force a reply, and
// on 26 Sep in Lunethis the model posted its own deliberation ("I don't see a message addressed
// to me… If she calls, I answer.") before its real line. The prompt now offers SILENT — that is
// the mechanism. This is the backstop: a reply that OPENS by reasoning about whether it was
// spoken to is contaminated as a whole, so the whole reply is dropped, not just the first
// paragraph (Codex, 1 Oct: the second paragraph of the real 26 Sep text was still deliberation).
// A phrase list can't promise "never"; it catches the shapes we've seen and their near kin.
const SILENT_TOKEN = /^[`*_"'\s]*SILENT[.!`*_"'\s]*$/i;
// High precision over recall (Codex rounds 2–3, 1 Oct): only explicitly META wording — "addressed /
// directed to me", "a message … addressed to me", "in passing", "not an address to me". Banter like
// "You weren't talking to me like that last night" or "He hasn't called your bluff" must survive;
// wrongly silencing a real reply is the bigger harm, and SILENT is the primary mechanism anyway.
const ADDRESS_DELIBERATION = new RegExp([
  String.raw`\b(?:wasn'?t|isn'?t|weren'?t|aren'?t|not)\s+(?:really\s+)?(?:addressed|directed)\s+(?:to|at)\s+me\b`,
  String.raw`\b(?:don'?t|do\s+not|didn'?t|can'?t)\s+see\s+(?:a|any)\s+(?:message|mention|question)\b[^.!?]{0,40}\b(?:addressed|directed)\s+(?:to|at)\s+me\b`,
  String.raw`\bno\s+(?:message|mention|question)\b[^.!?]{0,40}\b(?:addressed|directed)\s+(?:to|at)\s+me\b`,
  String.raw`\bmentioned\s+(?:my\s+name|me)\s+in\s+passing\b`,
  String.raw`\bnot\s+an\s+address\s+to\s+me\b`,
].join('|'), 'i');

export function stripAddressDeliberation(text: string): string {
  const trimmed = text.trim();
  if (SILENT_TOKEN.test(trimmed)) return '';
  const first = trimmed.split(/\r?\n\s*\r?\n/)[0] ?? '';
  if (ADDRESS_DELIBERATION.test(first)) return '';
  const lines = trimmed.split(/\r?\n/);
  if (lines.length && SILENT_TOKEN.test(lines[lines.length - 1])) return '';
  return trimmed;
}

// Maps a model-returned sticker NAME to a roster ID, case-insensitively.
// Unknown/absent/non-string names always resolve to null — the model never
// gets to hand back a raw id and have it trusted.
export function mapStickerName(name: unknown, stickers: StickerInfo[]): string | null {
  if (typeof name !== 'string') return null;
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const found = stickers.find((s) => s.name.toLowerCase() === needle);
  return found ? found.id : null;
}

/** Convert model-written custom-emoji markup into a real sticker selection.
 * The numeric id in the text is never trusted: only a case-insensitive name
 * match against Discord's freshly fetched sticker roster can select an id. */
export function extractInlineSticker(
  text: string,
  stickers: StickerInfo[],
): { text: string; stickerId: string | null } {
  let stickerId: string | null = null;
  const cleaned = text.replace(/<a?:([A-Za-z0-9_.-]+):\d{15,21}>/g, (markup, name: string) => {
    const resolved = mapStickerName(name, stickers);
    if (!resolved) return markup;
    if (!stickerId) stickerId = resolved;
    return '';
  }).replace(/[ \t]+\n/g, '\n').trim();
  return { text: cleaned, stickerId };
}
