// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * memory-wall.ts — the engine's own per-server wall and keyword filter for recalled memory.
 * Pure. Applied to whatever a MemoryProvider returns, before anything reaches a prompt.
 */
import type { MemoryItem } from '../seams/memory-provider.js';

export interface WallOptions {
  scope: 'server' | 'private';
  guildId: string | null;
  /** The bot's own channel cache: channel id → guild id (null/undefined = unknown). */
  channelGuildOf: (channelId: string) => string | null | undefined;
}

export function isDiscordItem(it: MemoryItem): boolean {
  return (it.source ?? '').toLowerCase() === 'discord' || !!it.channel_id;
}

/** Item's server: its own server_id, else the guild its channel belongs to; null = unknown. */
export function itemGuild(it: MemoryItem, channelGuildOf: WallOptions['channelGuildOf']): string | null {
  if (it.server_id) return String(it.server_id);
  if (it.channel_id) return channelGuildOf(String(it.channel_id)) ?? null;
  return null;
}

export function applyServerWall(items: MemoryItem[], o: WallOptions): MemoryItem[] {
  if (o.scope === 'private') return items;
  return items.filter((it) => {
    // A server_id tag is a wall regardless of source: another guild's item never passes.
    if (it.server_id) return !!o.guildId && String(it.server_id) === String(o.guildId);
    if (!isDiscordItem(it)) return true;
    if (!o.guildId) return false;
    const g = itemGuild(it, o.channelGuildOf);
    return g !== null && g === String(o.guildId);
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Drop any item containing a blocklisted word (case-insensitive, whole word / whole phrase). */
export function applyMemoryFilter(items: MemoryItem[], blocklist: string[]): MemoryItem[] {
  const res = blocklist.map((w) => w.trim()).filter(Boolean)
    .map((w) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(w)}(?![\\p{L}\\p{N}_])`, 'iu'));
  if (!res.length) return items;
  return items.filter((it) => !res.some((re) => re.test(it.text)));
}

export const MEMORY_MAX_ITEMS = 8;
export const MEMORY_MAX_CHARS = 4000;

export interface MemoryBlock {
  block: string;
  /** Texts of understood (non-quotable) items — handed to the leak guard. */
  privateSnippets: string[];
  count: number;
}

/** quotable = marked quotable, or a Discord item from this very server. Everything else is understood only. */
export function isQuotable(it: MemoryItem, o: WallOptions): boolean {
  if (it.server_id && (!o.guildId || String(it.server_id) !== String(o.guildId))) return false;
  if (it.quotable === true) return true;
  if (!isDiscordItem(it) || !o.guildId) return false;
  return itemGuild(it, o.channelGuildOf) === String(o.guildId);
}

export function buildMemoryBlock(items: MemoryItem[], o: WallOptions): MemoryBlock | null {
  const head = '# What you remember\n_Quotable items may be referred to. Understood items shape your understanding only: never quote or closely paraphrase them._';
  const lines: string[] = [];
  const privateSnippets: string[] = [];
  let used = head.length;
  for (const it of items) {
    if (lines.length >= MEMORY_MAX_ITEMS) break;
    const q = isQuotable(it, o);
    const meta = [it.date, it.source].filter(Boolean).join(', ');
    const text = it.text.replace(/\s+/g, ' ').trim();
    const line = `- [${q ? 'quotable' : 'understood'}]${meta ? ` (${meta})` : ''} ${text}`;
    if (used + line.length + 1 > MEMORY_MAX_CHARS) break;
    used += line.length + 1;
    lines.push(line);
    if (!q) privateSnippets.push(it.text);
  }
  if (!lines.length) return null;
  return { block: `${head}\n${lines.join('\n')}`, privateSnippets, count: lines.length };
}
