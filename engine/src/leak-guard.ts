// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * LEAK GUARD — TypeScript twin of sanctum/src/leak-guard.js (Sanctum full sight,
 * specs/2026-09-30-sanctum-full-sight.md). The presence engine calls the models itself with a
 * prepared prompt, so it must run the same check Sanctum runs on its own replies: a draft that
 * shares any run of 8 consecutive words with a PRIVATE recall item is a leak and is never posted.
 * Change both files together.
 */
export const LEAK_NGRAM = 8;

// Every Unicode "default ignorable" code point (zero-width, bidi marks, tag characters U+E0000…)
// — the official property, not a hand-picked list (Codex 30 Sep: U+E0061 slipped a hand list).
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;
const JSON_ESC: Record<string, string> = { b: ' ', f: ' ', n: ' ', r: ' ', t: ' ', '"': '"', '/': '/', '\\': '\\' };

export function normWords(text: string): string[] {
  let t = String(text || '');
  // JSON-escaped text (the presence judge returns JSON): decode every JSON escape first
  t = t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
       .replace(/\\(["\\/bfnrt])/g, (_, c) => JSON_ESC[c] ?? ' ');
  t = t.normalize('NFKC').replace(IGNORABLE, '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** What Discord DISPLAYS: masked links show only their label, custom emoji / mentions / :codes:
 * show as pictures or names, not words — so strip them, or a link can hide inside an 8-word run
 * (Codex 30 Sep: "one two three [four](https://x) five six seven eight"). */
export function discordDisplay(t: string): string {
  return String(t || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')          // [label](url) → label
    .replace(/<a?:\w+:\d+>/g, ' ')                        // <:emoji:id> / <a:emoji:id>
    .replace(/<[@#][!&]?\d+>/g, ' ')                      // <@user> <#channel> <@&role>
    .replace(/<(https?:[^>]+)>/g, ' ')                     // <autolink>
    .replace(/:[a-z0-9_+-]+:/gi, ' ')                      // :shortcode:
    .replace(/[*_~`|]+/g, '');                             // **bold** _it_ ~~s~~ `code` ||spoiler|| — even mid-word
}

/** The text as written, plus — when a draft IS JSON — every string inside it, decoded. */
function candidates(reply: string): string[] {
  const out = [String(reply || '')];
  const s = out[0].trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      const walk = (v: unknown): void => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
      walk(JSON.parse(s));
    } catch { /* not JSON — the raw text is still checked */ }
  }
  return [...out, ...out.map(discordDisplay)];
}

function ngrams(words: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

/** Returns the first leaked phrase, or null. */
export function findLeak(reply: string, privateSnippets: unknown, n = LEAK_NGRAM): string | null {
  if (!Array.isArray(privateSnippets) || privateSnippets.length === 0) return null;
  const replyGrams = new Set<string>();
  for (const c of candidates(reply)) for (const g of ngrams(normWords(c), n)) replyGrams.add(g);
  if (!replyGrams.size) return null;
  // symmetric: the private side is checked in every form too (raw, JSON strings, Discord display)
  for (const snip of privateSnippets) {
    for (const c of candidates(String(snip))) {
      for (const g of ngrams(normWords(c), n)) {
        if (replyGrams.has(g)) return g;
      }
    }
  }
  return null;
}
