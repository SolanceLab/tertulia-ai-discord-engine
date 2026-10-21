// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * The one mapping from Discord messages to the plain objects the read tools return
 * (discord_read_messages, discord_list_pins): author, content, timestamp, attachments,
 * reply reference and embeds.
 */
import type { Message } from 'discord.js';
import type { DiscordClient } from '../discord-client.js';
import { toReplyReference } from '../discord-client.js';
import { embedsOf } from './embeds.js';

export async function mapMessagesForApi(discordClient: DiscordClient, messages: Message[]) {
  // Resolve display names for guild channels
  const nameMap = new Map<string, string>();
  if (messages.length > 0 && messages[0].guild) {
    const authorIds = messages.map(m => m.author.id);
    const resolved = await discordClient.resolveDisplayNames(messages[0].guild.id, authorIds);
    resolved.forEach((v, k) => nameMap.set(k, v));
  }

  return messages.map(msg => {
    const reference = toReplyReference(msg);
    return {
      id: msg.id,
      author: nameMap.get(msg.author.id) || msg.author.tag,
      authorId: msg.author.id,
      content: msg.content,
      timestamp: msg.createdAt.toISOString(),
      attachments: msg.attachments.map(att => ({
        name: att.name,
        url: att.url,
        contentType: att.contentType,
        width: att.width,
        height: att.height,
      })),
      // Discord's reply pointer, additive: the key is absent entirely for a
      // non-reply, so the cloud worker's existing consumption is untouched.
      // Additive, like reference: absent for a message with no embeds.
      ...(embedsOf(msg).length ? { embeds: embedsOf(msg) } : {}),
      ...(reference ? { reference } : {}),
    };
  });
}
