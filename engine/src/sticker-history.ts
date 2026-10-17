// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * StickerHistory — per-channel memory of recently-sent sticker IDs.
 *
 * Used to stop the bot repeating the same sticker back-to-back in a channel
 * (ambient, replies, away, curfew — all paths share one instance). Pure,
 * standalone module: no imports from other src files, no network, no I/O.
 *
 * - Per channel, remembers the last `capacity` sticker ids with timestamps.
 * - Entries older than `ttlMs` are pruned lazily, on access.
 * - The number of tracked CHANNELS is capped at `maxChannels`; the
 *   least-recently-touched channel is evicted when a new channel would
 *   push the count over the cap (LRU by last `record()`), so a
 *   long-running process can't leak memory across churns of channels.
 * - Clock is injectable (`now`) so tests never depend on real time.
 */

const DEFAULT_CAPACITY = 3;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const DEFAULT_MAX_CHANNELS = 50;

interface StickerEntry {
  id: string;
  ts: number;
}

interface ChannelRecord {
  entries: StickerEntry[];
}

export interface StickerHistoryOptions {
  capacity?: number;
  ttlMs?: number;
  maxChannels?: number;
  now?: () => number;
}

export class StickerHistory {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly maxChannels: number;
  private readonly now: () => number;
  // Map insertion order doubles as LRU order: re-inserting a key (delete
  // then set) on every touch moves it to the "most recently touched" end;
  // the key at the front (Map iteration start) is the LRU eviction victim.
  private readonly channels = new Map<string, ChannelRecord>();

  constructor(opts: StickerHistoryOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxChannels = opts.maxChannels ?? DEFAULT_MAX_CHANNELS;
    this.now = opts.now ?? Date.now;
  }

  /** Record that `stickerId` was just sent in `channelId`. */
  record(channelId: string, stickerId: string): void {
    const t = this.now();
    const existing = this.channels.get(channelId);
    // Touch: remove then re-add so this channel becomes most-recently-used.
    if (existing) this.channels.delete(channelId);

    const entries = (existing ? existing.entries : []).filter(
      (e) => t - e.ts < this.ttlMs
    );
    entries.push({ id: stickerId, ts: t });
    while (entries.length > this.capacity) entries.shift(); // drop oldest excess

    this.channels.set(channelId, { entries });

    // LRU-evict the least-recently-touched channel if over the cap.
    if (this.channels.size > this.maxChannels) {
      const oldestKey = this.channels.keys().next().value;
      if (oldestKey !== undefined) this.channels.delete(oldestKey);
    }
  }

  /** True if `stickerId` was sent in `channelId` within the TTL window. */
  recentlyUsed(channelId: string, stickerId: string): boolean {
    const ch = this.channels.get(channelId);
    if (!ch) return false;

    const t = this.now();
    const fresh = ch.entries.filter((e) => t - e.ts < this.ttlMs);

    if (fresh.length === 0) {
      this.channels.delete(channelId);
      return false;
    }
    if (fresh.length !== ch.entries.length) {
      this.channels.set(channelId, { entries: fresh });
    }

    return fresh.some((e) => e.id === stickerId);
  }
}
