// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * copy-to-owner.ts — the per-server rule `copy_to_owner` (DECISIONS 2026-10-16).
 *
 * After the bot has posted in a guild channel, and that server's rule is on, the owner gets a DM
 * copy of what was said. Best-effort and silent on failure: the channel send is already done.
 * Skipped when the message being answered is the owner's own (the owner already read it).
 * Each sent message id is copied once.
 */

export interface CopyDeps {
  ownerUserId: string;
  copyEnabled(guildId: string): boolean;
  sendDM(userId: string, text: string): Promise<unknown>;
  log(message: string, data?: Record<string, unknown>): void;
}

export interface CopyInput {
  guildId: string | null | undefined;
  guildName?: string;
  channelId: string;
  channelName?: string;
  sentId: string;
  text?: string | null;
  stickerNames?: string[];
  /** Files attached to the post: name and URL. */
  attachments?: Array<{ name?: string; url?: string }>;
  /** The message being answered, when there is one. */
  trigger?: { authorId: string; authorName?: string; text?: string | null } | null;
}

const SEEN_CAP = 500;
const DM_LIMIT = 2000;

export function createCopyToOwner(deps: CopyDeps) {
  const seen = new Set<string>();
  return async function copyToOwner(i: CopyInput): Promise<boolean> {
    try {
      if (!deps.ownerUserId || !i.guildId || !deps.copyEnabled(i.guildId)) return false;
      if (i.trigger && i.trigger.authorId === deps.ownerUserId) return false;
      if (seen.has(i.sentId)) return false;
      seen.add(i.sentId);
      if (seen.size > SEEN_CAP) seen.delete(seen.values().next().value as string);

      let body = (i.text ?? '').trim();
      if (!body && i.stickerNames?.length) body = i.stickerNames.map((n) => `[sticker ${n}]`).join(' ');
      const files = (i.attachments ?? []).filter((a) => a && (a.name || a.url)).map((a) => `[attachment ${[a.name, a.url].filter(Boolean).join(' ')}]`);
      if (files.length) body = body ? `${body}\n${files.join('\n')}` : files.join('\n');
      if (!body) return false;

      const quote = i.trigger
        ? `${i.trigger.authorName ?? 'someone'}: ${(i.trigger.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)}`
        : '(no trigger)';
      const link = `https://discord.com/channels/${i.guildId}/${i.channelId}/${i.sentId}`;
      const head = `**Copy · ${i.guildName ?? i.guildId} #${i.channelName ?? i.channelId}**`;
      const frame = `${head}\n> ${quote}\n\n${link}`;
      const room = Math.max(0, DM_LIMIT - frame.length);
      if (body.length > room) body = room > 3 ? body.slice(0, room - 3) + '...' : '';
      const res = await deps.sendDM(deps.ownerUserId, `${head}\n> ${quote}\n${body}\n${link}`.slice(0, DM_LIMIT));
      if (!res) deps.log('copy-to-owner DM not delivered', { guild: i.guildId, channel: i.channelId, message: i.sentId });
      return Boolean(res);
    } catch (err: any) {
      deps.log('copy-to-owner threw', { guild: i.guildId, channel: i.channelId, message: i.sentId, error: err?.message });
      return false;
    }
  };
}
