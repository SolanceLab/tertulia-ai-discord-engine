// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Reactions in the room. A small in-memory store of live messageReactionAdd/Remove events (who reacted with
 * what, on which message), capped and least-recently-used, plus the helpers that turn a discord.js message's
 * reaction cache into the compact `reactions` list a transcript line carries, and that validate the single
 * emoji the model may answer with. Nothing here is persisted and nothing here triggers a reply: a reaction
 * is only ever READ, in the next window (never a real-time loop).
 */
import { identity } from './config/identity.js';
import { isIgnoredAuthor } from './presence-config.js';
import { safeMentionName } from './presence/window.js';
import type { WindowReaction } from './presence/window.js';

export const REACTION_STORE_CAP = 2000;
export const MAX_REACTION_NAMES = 3;

interface Reactor { id: string; name: string }

export class ReactionStore {
  // message id -> emoji -> user id -> display name. Map insertion order is the LRU order.
  private readonly byMessage = new Map<string, Map<string, Map<string, string>>>();
  constructor(private readonly cap = REACTION_STORE_CAP) {}

  private touch(messageId: string): Map<string, Map<string, string>> {
    let emojis = this.byMessage.get(messageId);
    if (emojis) this.byMessage.delete(messageId);
    else emojis = new Map();
    this.byMessage.set(messageId, emojis);
    while (this.byMessage.size > this.cap) {
      const oldest = this.byMessage.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.byMessage.delete(oldest);
    }
    return emojis;
  }

  add(messageId: string, emoji: string, userId: string, name: string): void {
    if (!messageId || !emoji || !userId) return;
    const emojis = this.touch(messageId);
    let users = emojis.get(emoji);
    if (!users) { users = new Map(); emojis.set(emoji, users); }
    users.set(userId, name);
  }

  remove(messageId: string, emoji: string, userId: string): void {
    const emojis = this.byMessage.get(messageId);
    const users = emojis?.get(emoji);
    if (!emojis || !users) return;
    users.delete(userId);
    if (users.size === 0) emojis.delete(emoji);
    if (emojis.size === 0) this.byMessage.delete(messageId);
  }

  /** All reactions on a message were cleared (or one emoji's, when `emoji` is given). */
  clear(messageId: string, emoji?: string): void {
    if (emoji === undefined) { this.byMessage.delete(messageId); return; }
    const emojis = this.byMessage.get(messageId);
    emojis?.delete(emoji);
    if (emojis && emojis.size === 0) this.byMessage.delete(messageId);
  }

  /** Read-only: does not refresh recency. */
  users(messageId: string, emoji: string): Reactor[] {
    const users = this.byMessage.get(messageId)?.get(emoji);
    return users ? [...users].map(([id, name]) => ({ id, name })) : [];
  }

  get size(): number { return this.byMessage.size; }
}

export const reactionStore = new ReactionStore();

/** The label an emoji carries in the transcript: custom `<:name:id>` becomes `:name:`. */
export function displayEmoji(emoji: string): string {
  const custom = emoji.match(/^<a?:(\w{2,32}):\d{15,25}>$/);
  return custom ? `:${custom[1]}:` : emoji;
}

export interface ReactionContext {
  isOwner: (userId: string) => boolean;
  botId?: string | null;
  /** Hidden authors: their reactions are dropped (names and counts), where known. */
  ignored?: string[];
  store?: ReactionStore;
}

/**
 * discord.js Message.reactions.cache (counts, no extra API call) merged with the store's names.
 * Returns undefined when the message carries no visible reactions, so a window without reactions renders
 * byte-for-byte as before.
 */
export function buildReactions(msg: any, ctx: ReactionContext): WindowReaction[] | undefined {
  const cache = msg?.reactions?.cache;
  if (!cache || typeof cache.values !== 'function') return undefined;
  const store = ctx.store ?? reactionStore;
  const ignored = ctx.ignored ?? [];
  const out: WindowReaction[] = [];
  for (const r of cache.values()) {
    const key = String(r?.emoji?.toString?.() ?? '');
    if (!key) continue;
    const known = msg?.id ? store.users(String(msg.id), key) : [];
    const hidden = known.filter((u) => isIgnoredAuthor(u.id, ignored));
    const shown = known.filter((u) => !isIgnoredAuthor(u.id, ignored));
    const cached = Number(r.count ?? 0);
    // Reactors the store never saw (made before startup, while disconnected, or after LRU eviction) could be
    // ignored users, so with an ignore list active only identified reactors are counted.
    const incomplete = ignored.length > 0 && known.length < cached;
    const count = incomplete ? shown.length : cached - hidden.length;
    if (count <= 0) continue;
    const byOwner = shown.some((u) => ctx.isOwner(u.id));
    const labels = [
      ...(byOwner ? [identity.owner_label] : []),
      ...shown
        .filter((u) => !ctx.isOwner(u.id))
        .map((u) => (ctx.botId && u.id === ctx.botId ? 'you' : safeMentionName(u.name)))
        .filter(Boolean),
    ];
    out.push({ emoji: displayEmoji(key), count, byOwner, names: labels.slice(0, MAX_REACTION_NAMES) });
  }
  return out.length ? out : undefined;
}

const KEYCAP = /^[0-9#*]️?⃣$/u;

/**
 * One emoji or null. Accepts a single unicode emoji (one grapheme), a custom emoji tag `<:name:id>`, or a
 * `:name:` shortcode (resolved against the bot's usable server emojis at the send site). Anything else,
 * including text, several emoji or the word "null", is null.
 */
export function normalizeReactionEmoji(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.toLowerCase() === 'null') return null;
  if (/^<a?:\w{2,32}:\d{15,25}>$/.test(s) || /^:\w{2,32}:$/.test(s)) return s;
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)];
  if (graphemes.length !== 1) return null;
  return KEYCAP.test(s) || /\p{Extended_Pictographic}/u.test(s) ? s : null;
}

/**
 * How an owner-mention reply counts: any text is a reply; no text but a reaction that landed is a success
 * (nothing to post, no failure alert); no text and no landed reaction is a failure.
 */
export function mentionReplyOutcome(r: { text?: string | null; reactionLanded: boolean }): 'text' | 'reaction' | 'failure' {
  if (r.text) return 'text';
  return r.reactionLanded ? 'reaction' : 'failure';
}
