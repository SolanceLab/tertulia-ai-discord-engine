// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * author-notes.ts — "Who's here": one short note per person in a window, from the hooks file's `authorNotes`.
 *
 * Placement: PresenceEngine.judge() and respond() call `AuthorNotes.blockFor(window, ignored)` once per window,
 * AFTER the window passed the door (ignored and hidden people are gone from it), and put the returned text into the
 * prompt's peopleNotes slot. Input: the window's messages. Output: text, one line per person, or '' for none.
 *
 *  - The authors are the distinct (id, shown name) pairs in the window, the bot itself left out. A webhook post is
 *    its own author: its id is the webhook's, its shown name the persona's.
 *  - Each line is labelled the way the transcript labels the person: shown name (@username · id).
 *  - A person whose id is on the ignore list never reaches the hook, even if the window still held a message of theirs.
 *  - Notes are cached per id + shown name for a short time, so a busy channel does not call the hook every window.
 *  - No hook, a throwing hook, or no notes at all: the section is left out. A throw is logged once.
 */
import { hookAuthorNotes, hooksCanNoteAuthors, authorNoteKey, type AuthorInfo } from '../hooks.js';
import { isIgnoredAuthor } from '../presence-config.js';
import { transcriptSpeakerLabel, type WindowMessage } from './window.js';

export const AUTHOR_NOTE_TTL_MS = 5 * 60_000;
const NOTE_MAX_CHARS = 400;
const CACHE_MAX = 500;

/** One line, no markup that could pass for a prompt section, capped. */
function cleanNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_CHARS);
}

/** The distinct authors of a window, in order of first appearance, the bot left out. */
export function authorsOf(window: WindowMessage[], ignored: string[]): Array<{ info: AuthorInfo; sample: WindowMessage }> {
  const seen = new Set<string>();
  const out: Array<{ info: AuthorInfo; sample: WindowMessage }> = [];
  for (const m of window) {
    if (m.isFromMe || !m.authorId) continue;
    if (isIgnoredAuthor(m.authorId, ignored)) continue;
    const info: AuthorInfo = {
      id: m.authorId,
      shownName: m.authorName,
      username: m.authorUsername ?? '',
      isWebhook: m.isWebhook === true,
      isBot: m.isBot === true,
    };
    const key = authorNoteKey(info);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ info, sample: m });
  }
  return out;
}

export class AuthorNotes {
  private cache = new Map<string, { at: number; note: string }>();
  constructor(private now: () => number = () => Date.now(), private ttlMs = AUTHOR_NOTE_TTL_MS) {}

  async blockFor(window: WindowMessage[], ignored: string[]): Promise<string> {
    if (!hooksCanNoteAuthors()) return '';
    const authors = authorsOf(window, ignored);
    if (!authors.length) return '';
    const t = this.now();
    const fresh = (k: string) => { const c = this.cache.get(k); return c && t - c.at < this.ttlMs ? c : null; };
    const missing = authors.filter((a) => !fresh(authorNoteKey(a.info)));
    if (missing.length) {
      const notes = await hookAuthorNotes(missing.map((a) => a.info));
      if (notes === null) {
        // A hook that failed: leave the section out for this window; what was cached before still counts.
        if (!authors.some((a) => fresh(authorNoteKey(a.info)))) return '';
      } else {
        for (const a of missing) {
          const key = authorNoteKey(a.info);
          this.cache.set(key, { at: t, note: cleanNote(notes[key]) });
        }
        if (this.cache.size > CACHE_MAX) for (const [k, v] of this.cache) if (t - v.at >= this.ttlMs) this.cache.delete(k);
      }
    }
    const lines: string[] = [];
    for (const a of authors) {
      const note = fresh(authorNoteKey(a.info))?.note ?? '';
      if (note) lines.push(`${transcriptSpeakerLabel(a.sample)}: ${note}`);
    }
    return lines.join('\n');
  }
}
