// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * bot-spoke.ts — channel-level record of when the bot itself last spoke, so the hideMessage after-bot fact
 * holds even when the bot message is outside a 15-message window. In-process: it starts empty after a restart
 * and refills from the bot's own gateway events, sends and history fetches.
 */
const PER_CHANNEL = 64;
const MAX_CHANNELS = 1000;
const spoke = new Map<string, number[]>();

export function noteBotSpoke(channelId: string | null | undefined, ts: number | null | undefined): void {
  if (!channelId || typeof ts !== 'number' || !Number.isFinite(ts)) return;
  let list = spoke.get(channelId);
  if (!list) {
    if (spoke.size >= MAX_CHANNELS) {
      const oldest = spoke.keys().next().value;
      if (oldest !== undefined) spoke.delete(oldest);
    }
    list = [];
    spoke.set(channelId, list);
  }
  let i = list.length;
  while (i > 0 && list[i - 1] > ts) i--;
  if (i > 0 && list[i - 1] === ts) return;
  list.splice(i, 0, ts);
  if (list.length > PER_CHANNEL) list.splice(0, list.length - PER_CHANNEL);
}

/** The largest recorded bot timestamp <= ts in this channel, or null. */
export function lastBotSpokeAtOrBefore(channelId: string | null | undefined, ts: number): number | null {
  if (!channelId) return null;
  const list = spoke.get(channelId);
  if (!list) return null;
  for (let i = list.length - 1; i >= 0; i--) if (list[i] <= ts) return list[i];
  return null;
}

/**
 * Restart guard: the record is empty after a restart, so the first message seen in a channel hydrates it from
 * channel history once. One in-flight fetch per channel is shared; a failed fetch is forgotten so the next message retries.
 * shortcut: one history fetch of `limit` messages per channel per process start; a bot post older than that
 * is missed. Persist the clock if restarts inside busy channels ever matter.
 */
const hydration = new Map<string, Promise<void>>();

export function hydrateBotSpoke(channelId: string | null | undefined, load: () => Promise<number[]>): Promise<void> {
  if (!channelId) return Promise.resolve();
  const existing = hydration.get(channelId);
  if (existing) return existing;
  const p = load().then(
    (stamps) => { for (const t of stamps) noteBotSpoke(channelId, t); },
    (err) => { hydration.delete(channelId); console.error('[bot-spoke] hydrate failed, will retry on the next message:', err?.message ?? err); },
  );
  hydration.set(channelId, p);
  return p;
}

/** For tests. */
export function resetBotSpoke(): void {
  spoke.clear();
  hydration.clear();
}
