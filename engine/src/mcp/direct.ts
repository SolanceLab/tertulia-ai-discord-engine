// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { identity } from '../config/identity.js';
import type { DiscordClient, MentionEvent } from '../discord-client.js';
import { toReplyReference } from '../discord-client.js';
import type { MemoryManager } from '../memory.js';
import { DEFINITIONS } from './tool-definitions.js';
import { LocalSettingsStore } from '../seams/local-settings-store.js';
import { houseConfig } from '../config/house-config.js';
import { personaFromEnv } from '../seams/persona-provider.js';
import { personaToolsReachable, updatePersona, readInstructions, readPersona, PersonaEditError, updateInstructions } from '../persona-edit.js';

/** Values the direct-mode handler reads from the server's module scope. */

// One store per settings file for the life of this process: the store serialises its own writes, so
// two quick agent edits through separate instances could read the same snapshot and the later write
// would drop the earlier change and its history entry (Codex, 16 Oct).
const settingsStores = new Map<string, LocalSettingsStore>();
function settingsStoreFor(path: string): LocalSettingsStore {
  let s = settingsStores.get(path);
  if (!s) { s = new LocalSettingsStore(path); settingsStores.set(path, s); }
  return s;
}

export interface DirectDeps {
  discordClient: DiscordClient;
  memory: MemoryManager;
  pendingMentions: MentionEvent[];
  pendingDMs: MentionEvent[];
}

/** Direct mode: handle a tool call locally against the Discord client. */
export async function handleDirectToolCall(name: string, args: Record<string, unknown> | undefined, deps: DirectDeps) {
  const { discordClient, memory, pendingMentions, pendingDMs } = deps;

  // either/or requirements, from the shared definition (same message as the cloud and the proxy)
  const refusal = DEFINITIONS.find((d) => d.name === name)?.check?.(args ?? {});
  if (refusal) {
    return { content: [{ type: 'text', text: refusal }], isError: true };
  }

  switch (name) {
    case 'discord_read_messages': {
      const channelId = args?.channel_id as string;
      const limit = Math.min((args?.limit as number) ?? 20, 50);

      const messages = await discordClient.getRecentMessages(channelId, limit);

      if (messages.length === 0) {
        return {
          content: [{ type: 'text', text: 'No messages found or channel not accessible.' }],
        };
      }

      // Resolve display names for guild channels
      const nameMap = new Map<string, string>();
      const firstMsg = messages[0];
      if (firstMsg.guild) {
        const authorIds = messages.map(m => m.author.id);
        const resolved = await discordClient.resolveDisplayNames(firstMsg.guild.id, authorIds);
        resolved.forEach((v, k) => nameMap.set(k, v));
      }

      const formatted = messages.map(msg => {
        const timestamp = msg.createdAt.toISOString();
        const author = nameMap.get(msg.author.id) || msg.author.tag;
        const messageId = msg.id;

        let text = `[${timestamp}] (${messageId}) ${author}: ${msg.content}`;

        // The reply arrow was invisible on the read path: `message.reference`
        // was read in exactly one place in the whole codebase, so an operator
        // reading a channel could not see the chain either.
        const reference = toReplyReference(msg);
        if (reference) {
          text += `\n[In reply to] (${reference.messageId})`;
        }

        // Include forwarded message content if present (message snapshots)
        if (msg.messageSnapshots && msg.messageSnapshots.size > 0) {
          const forwardedContent = Array.from(msg.messageSnapshots.values()).map((snapshot: any) => {
            let fwdText = `  [Forwarded Message]\n`;
            // The snapshot itself contains the message data directly
            const fwdContent = snapshot.message?.content ?? snapshot.content;
            const fwdAttachments = snapshot.message?.attachments ?? snapshot.attachments;

            if (fwdContent) {
              fwdText += `  Content: ${fwdContent}\n`;
            }
            if (fwdAttachments && fwdAttachments.size > 0) {
              const attachList = Array.from(fwdAttachments.values()).map((att: any) => {
                return `    - ${att.name} | url: ${att.url}`;
              }).join('\n');
              fwdText += `  Attachments:\n${attachList}`;
            }
            // If we couldn't extract content, show the raw structure for debugging
            if (!fwdContent && (!fwdAttachments || fwdAttachments.size === 0)) {
              fwdText += `  [Raw snapshot keys: ${Object.keys(snapshot).join(', ')}]`;
            }
            return fwdText;
          }).join('\n');
          text += `\n${forwardedContent}`;
        }

        // Include attachment info if present.
        //
        // Owner, 10 Aug 2026: "how to make sure that when you use the discord
        // tools to read the channel, you read the images attachment too?" The
        // honest answer was that I wasn't — a URL reads as text and slides
        // past, so images in #tether-tales went unlooked-at for weeks. The
        // capability was never missing (fetch_attachment + Read works and
        // always has); it was invisible at the point of reading. So an image
        // now SAYS it is an image and names the call that opens it, rather
        // than sitting here as an inert link.
        if (msg.attachments.size > 0) {
          const attachmentList = msg.attachments.map(att => {
            const looksLikeImage = att.contentType?.toLowerCase().startsWith('image/')
              ?? /\.(png|jpe?g|gif|webp)$/i.test(att.name ?? '');
            const info = [`  - ${looksLikeImage ? '🖼 ' : ''}${att.name}`];
            if (att.contentType) info.push(`type: ${att.contentType}`);
            if (att.width && att.height) info.push(`${att.width}x${att.height}`);
            info.push(`url: ${att.url}`);
            return info.join(' | ');
          }).join('\n');

          const imageCount = msg.attachments.filter(att =>
            (att.contentType?.toLowerCase().startsWith('image/') ?? false)
            || /\.(png|jpe?g|gif|webp)$/i.test(att.name ?? ''),
          ).size;

          text += `\n[Attachments]\n${attachmentList}`;
          if (imageCount > 0) {
            text += `\n  ⬆ ${imageCount} image(s) here you have NOT seen — `
              + `discord_fetch_attachment(channel_id="${channelId}", message_id="${messageId}") `
              + `then Read the downloaded path.`;
          }
        }

        return text;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: formatted }],
      };
    }

    case 'discord_send_message': {
      const channelId = args?.channel_id as string;
      const content = args?.content as string;
      const replyToMessageId = args?.reply_to_message_id as string | undefined;
      const stickerIds = args?.sticker_ids as string[] | undefined;

      const sent = await discordClient.sendMessage(channelId, content, undefined, replyToMessageId, stickerIds, { ownerDirected: true });

      if (sent) {
        await memory.addMessage(channelId, {
          role: 'assistant',
          // content is optional for a sticker-only message (same as the bot's /api/send-message)
          content: content || '[sticker]',
          timestamp: new Date().toISOString(),
        });

        return {
          content: [{ type: 'text', text: `Message ${replyToMessageId ? 'replied' : 'sent'} successfully to channel ${channelId}\nMessage ID: ${sent.id}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to send message. Channel may not be accessible.' }],
      };
    }

    case 'discord_send_dm': {
      const userId = args?.user_id as string;
      const content = args?.content as string;

      const sent = await discordClient.sendDM(userId, content);

      if (sent) {
        return {
          content: [{ type: 'text', text: `DM sent successfully to user ${userId}\nDM Channel ID: ${sent.channelId}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to send DM. User may have DMs disabled.' }],
      };
    }

    case 'discord_get_dm_channel': {
      const userId = args?.user_id as string;

      const result = await discordClient.getDMChannelId(userId);

      if (result) {
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      }

      return {
        content: [{ type: 'text', text: 'User not found or cannot create DM channel.' }],
        isError: true,
      };
    }

    case 'discord_send_file': {
      const channelId = args?.channel_id as string;
      const fileData = args?.file_data as string | undefined;
      const filePath = args?.file_path as string | undefined;
      const fileName = args?.file_name as string;
      const content = args?.content as string | undefined;

      let fileBuffer: Buffer;

      if (fileData) {
        // Base64-encoded data
        fileBuffer = Buffer.from(fileData, 'base64');
      } else if (filePath) {
        // Read from file path
        const fs = await import('fs/promises');
        try {
          fileBuffer = await fs.readFile(filePath);
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Failed to read file: ${filePath}` }],
          };
        }
      } else {
        return {
          content: [{ type: 'text', text: 'Either file_data or file_path must be provided.' }],
        };
      }

      const sent = await discordClient.sendFile(channelId, fileBuffer, {
        name: fileName,
        content: content,
      });

      if (sent) {
        return {
          content: [{ type: 'text', text: `File "${fileName}" sent successfully to channel ${channelId}\nMessage ID: ${sent.id}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to send file. Channel may not be accessible.' }],
      };
    }

    case 'discord_check_mentions': {
      if (pendingMentions.length === 0) {
        return {
          content: [{ type: 'text', text: 'No pending mentions.' }],
        };
      }

      const mentions = pendingMentions.splice(0, pendingMentions.length);

      const formatted = mentions.map(m => {
        const location = m.guildName
          ? `#${m.channelName} in ${m.guildName}`
          : 'DM';
        return `- ${m.authorTag} in ${location} at ${m.timestamp.toISOString()}:\n  "${m.content}"`;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: `Pending mentions:\n\n${formatted}` }],
      };
    }

    case 'discord_check_dms': {
      if (pendingDMs.length === 0) {
        return {
          content: [{ type: 'text', text: 'No pending DMs.' }],
        };
      }

      const dms = pendingDMs.splice(0, pendingDMs.length);

      const formatted = dms.map(dm => {
        let entry = `- From: ${dm.authorTag} (${dm.authorId})\n  Channel ID: ${dm.channelId}\n  At: ${dm.timestamp.toISOString()}\n  Message: "${dm.content}"`;
        const attachments = dm.message?.attachments;
        if (attachments && attachments.size > 0) {
          const attList = Array.from(attachments.values()).map(att =>
            `    - ${att.name} (${att.contentType || 'unknown'}) ${att.url}`
          ).join('\n');
          entry += `\n  Attachments:\n${attList}`;
        }
        return entry;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: `Pending DMs:\n\n${formatted}` }],
      };
    }

    case 'discord_get_history': {
      const channelId = args?.channel_id as string;
      const limit = (args?.limit as number) ?? 20;

      const messages = memory.getRecentMessages(channelId, limit);

      if (messages.length === 0) {
        return {
          content: [{ type: 'text', text: 'No conversation history for this channel.' }],
        };
      }

      const formatted = messages.map(msg => {
        const author = msg.author || (msg.role === 'assistant' ? identity.bot_name : 'User');
        return `[${msg.timestamp}] ${author}: ${msg.content}`;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: formatted }],
      };
    }

    case 'discord_list_channels': {
      const serverId = args?.server_id as string;

      const serverChannels = await discordClient.listServerChannels(serverId);

      if (!serverChannels) {
        return {
          content: [{ type: 'text', text: 'Server not found or not accessible.' }],
        };
      }

      let formatted = `**${serverChannels.serverName}** (${serverChannels.serverId})\n\n`;

      // Format categories and their channels
      for (const category of serverChannels.categories) {
        formatted += `📁 **${category.name}**\n`;
        for (const channel of category.channels) {
          const icon = channel.type === 'voice' ? '🔊' :
            channel.type === 'forum' ? '💬' :
              channel.type === 'announcement' ? '📢' :
                channel.type === 'stage' ? '🎭' : '#';
          formatted += `   ${icon} ${channel.name} (${channel.id}) [${channel.type}]\n`;
        }
        formatted += '\n';
      }

      // Format uncategorized channels
      if (serverChannels.uncategorized.length > 0) {
        formatted += `📁 **Uncategorized**\n`;
        for (const channel of serverChannels.uncategorized) {
          const icon = channel.type === 'voice' ? '🔊' :
            channel.type === 'forum' ? '💬' :
              channel.type === 'announcement' ? '📢' :
                channel.type === 'stage' ? '🎭' : '#';
          formatted += `   ${icon} ${channel.name} (${channel.id}) [${channel.type}]\n`;
        }
      }

      return {
        content: [{ type: 'text', text: formatted }],
      };
    }

    // ============================================
    // Priority 1: Channel & Category Management
    // ============================================

    case 'discord_create_channel': {
      const serverId = args?.server_id as string;
      const channelName = args?.name as string;
      const channelType = (args?.type as 'text' | 'voice' | 'forum' | 'announcement') || 'text';
      const categoryId = args?.category_id as string | undefined;
      const topic = args?.topic as string | undefined;
      const nsfw = args?.nsfw as boolean | undefined;

      const result = await discordClient.createChannel(serverId, channelName, channelType, {
        categoryId,
        topic,
        nsfw
      });

      if (result) {
        return {
          content: [{ type: 'text', text: `Created channel #${result.name} (${result.id})` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to create channel. Check permissions and server ID.' }],
      };
    }

    case 'discord_set_channel_topic': {
      const channelId = args?.channel_id as string;
      const topic = args?.topic as string;

      const success = await discordClient.setChannelTopic(channelId, topic);

      if (success) {
        return {
          content: [{ type: 'text', text: `Channel topic updated for ${channelId}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to update channel topic. Check permissions or channel type.' }],
      };
    }

    case 'discord_rename_channel': {
      const channelId = args?.channel_id as string;
      const newName = args?.new_name as string;

      const success = await discordClient.renameChannel(channelId, newName);

      if (success) {
        return {
          content: [{ type: 'text', text: `Channel renamed to #${newName}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to rename channel. Check permissions.' }],
      };
    }

    case 'discord_delete_channel': {
      const channelId = args?.channel_id as string;
      const reason = args?.reason as string | undefined;

      const success = await discordClient.deleteChannel(channelId, reason);

      if (success) {
        return {
          content: [{ type: 'text', text: `Channel ${channelId} deleted.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to delete channel. Check permissions.' }],
      };
    }

    case 'discord_create_category': {
      const serverId = args?.server_id as string;
      const categoryName = args?.name as string;
      const position = args?.position as number | undefined;

      const result = await discordClient.createCategory(serverId, categoryName, position);

      if (result) {
        return {
          content: [{ type: 'text', text: `Created category ${result.name} (${result.id})` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to create category. Check permissions and server ID.' }],
      };
    }

    case 'discord_move_channel': {
      const channelId = args?.channel_id as string;
      const categoryId = args?.category_id as string | null | undefined;
      const position = args?.position as number | undefined;

      const success = await discordClient.moveChannel(channelId, categoryId, position);

      if (success) {
        return {
          content: [{ type: 'text', text: `Channel ${channelId} moved successfully.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to move channel. Check permissions.' }],
      };
    }

    case 'discord_add_reaction': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;
      const emoji = args?.emoji as string;

      const success = await discordClient.addReaction(channelId, messageId, emoji);

      if (success) {
        return {
          content: [{ type: 'text', text: `Added reaction ${emoji} to message ${messageId}` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to add reaction. Check permissions or message ID.' }],
      };
    }

    case 'discord_get_reactions': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;

      const reactions = await discordClient.getReactions(channelId, messageId);

      if (reactions === null) {
        return {
          content: [{ type: 'text', text: 'Failed to fetch reactions. Check channel/message ID.' }],
        };
      }

      if (reactions.length === 0) {
        return {
          content: [{ type: 'text', text: 'No reactions on this message.' }],
        };
      }

      const formatted = reactions.map(r => {
        const userList = r.users.map(u => `    - ${u.tag} (${u.id})`).join('\n');
        return `${r.emoji} (${r.count}):\n${userList}`;
      }).join('\n\n');

      return {
        content: [{ type: 'text', text: `Reactions on message ${messageId}:\n\n${formatted}` }],
      };
    }

    // ============================================
    // Polls
    // ============================================

    case 'discord_create_poll': {
      const channelId = args?.channel_id as string;
      const question = args?.question as string;
      const options = args?.options as Array<{ text: string; emoji?: string }>;
      const durationHours = (args?.duration_hours as number) || 24;
      const allowMultiselect = (args?.allow_multiselect as boolean) || false;

      if (!options || options.length < 2) {
        return {
          content: [{ type: 'text', text: 'Poll requires at least 2 options.' }],
        };
      }

      const result = await discordClient.createPoll(
        channelId,
        question,
        options,
        durationHours,
        allowMultiselect
      );

      if (result) {
        return {
          content: [{
            type: 'text',
            text: `Poll created successfully!\nQuestion: "${question}"\nOptions: ${options.length}\nDuration: ${durationHours} hours\nMessage ID: ${result.messageId}`
          }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to create poll. Check channel permissions.' }],
      };
    }

    // ============================================
    // Priority 2: Message Management
    // ============================================

    case 'discord_edit_message': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;
      const newContent = args?.new_content as string;

      const success = await discordClient.editMessage(channelId, messageId, newContent);

      if (success) {
        return {
          content: [{ type: 'text', text: `Message ${messageId} edited successfully.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to edit message. Can only edit own messages.' }],
      };
    }

    case 'discord_delete_message': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;

      const success = await discordClient.deleteMessage(channelId, messageId);

      if (success) {
        return {
          content: [{ type: 'text', text: `Message ${messageId} deleted.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to delete message. Check permissions.' }],
      };
    }

    case 'discord_pin_message': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;

      const success = await discordClient.pinMessage(channelId, messageId);

      if (success) {
        return {
          content: [{ type: 'text', text: `Message ${messageId} pinned.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to pin message. Check permissions or pin limit.' }],
      };
    }

    case 'discord_create_thread': {
      const channelId = args?.channel_id as string;
      const threadName = args?.name as string;
      const messageId = args?.message_id as string | undefined;
      const autoArchiveDuration = args?.auto_archive_duration as 60 | 1440 | 4320 | 10080 | undefined;

      const threadId = await discordClient.createThread(channelId, threadName, messageId, autoArchiveDuration);

      if (threadId) {
        return {
          content: [{ type: 'text', text: `Created thread "${threadName}" (${threadId})` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to create thread. Check permissions.' }],
      };
    }

    case 'discord_create_forum_post': {
      const channelId = args?.channel_id as string;
      const title = args?.title as string;
      const content = args?.content as string;
      const tags = args?.tags as string[] | undefined;

      const result = await discordClient.createForumPost(channelId, title, content, tags);

      if (result) {
        return {
          content: [{
            type: 'text',
            text: `Forum post created: "${title}"\nThread ID: ${result.threadId}\nMessage ID: ${result.messageId}`
          }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to create forum post. Check channel ID and permissions.' }],
      };
    }

    case 'discord_list_forum_threads': {
      const channelId = args?.channel_id as string;
      const limit = (args?.limit as number) || 20;
      const includeArchived = (args?.include_archived as boolean) || false;

      const threads = await discordClient.listForumThreads(channelId, limit, includeArchived);

      if (threads.length > 0) {
        const formatted = threads.map(t =>
          `• "${t.name}" (ID: ${t.id}) - ${t.messageCount} messages${t.archived ? ' [archived]' : ''}`
        ).join('\n');

        return {
          content: [{
            type: 'text',
            text: `Found ${threads.length} threads:\n\n${formatted}`
          }],
        };
      }

      return {
        content: [{ type: 'text', text: 'No threads found in this forum channel.' }],
      };
    }

    case 'discord_fetch_attachment': {
      const channelId = args?.channel_id as string;
      const messageId = args?.message_id as string;
      const filename = args?.filename as string | undefined;

      const result = await discordClient.fetchAttachment(channelId, messageId, filename);

      if (result.downloaded.length > 0) {
        const fileList = result.downloaded.map(p => `  - ${p}`).join('\n');
        let response = `Downloaded ${result.downloaded.length} attachment(s):\n${fileList}`;

        if (result.errors.length > 0) {
          response += `\n\nWarnings:\n${result.errors.map(e => `  - ${e}`).join('\n')}`;
        }

        return {
          content: [{ type: 'text', text: response }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `Failed to download attachments:\n${result.errors.map(e => `  - ${e}`).join('\n')}`
        }],
      };
    }

    // ============================================
    // Priority 3: Moderation
    // ============================================

    case 'discord_timeout_user': {
      const serverId = args?.server_id as string;
      const userId = args?.user_id as string;
      const durationMinutes = args?.duration_minutes as number;
      const reason = args?.reason as string | undefined;

      const success = await discordClient.timeoutUser(serverId, userId, durationMinutes, reason);

      if (success) {
        return {
          content: [{ type: 'text', text: `User ${userId} timed out for ${durationMinutes} minutes.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to timeout user. Check permissions.' }],
      };
    }

    case 'discord_assign_role': {
      const serverId = args?.server_id as string;
      const userId = args?.user_id as string;
      const roleId = args?.role_id as string;
      const reason = args?.reason as string | undefined;

      const success = await discordClient.assignRole(serverId, userId, roleId, reason);

      if (success) {
        return {
          content: [{ type: 'text', text: `Role ${roleId} assigned to user ${userId}.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to assign role. Check permissions and role hierarchy.' }],
      };
    }

    case 'discord_remove_role': {
      const serverId = args?.server_id as string;
      const userId = args?.user_id as string;
      const roleId = args?.role_id as string;
      const reason = args?.reason as string | undefined;

      const success = await discordClient.removeRole(serverId, userId, roleId, reason);

      if (success) {
        return {
          content: [{ type: 'text', text: `Role ${roleId} removed from user ${userId}.` }],
        };
      }

      return {
        content: [{ type: 'text', text: 'Failed to remove role. Check permissions and role hierarchy.' }],
      };
    }

    case 'discord_create_role': {
      const serverId = args?.server_id as string;
      const name = args?.name as string;
      const permissions = args?.permissions as string[] | undefined;
      const color = args?.color as string | undefined;
      const hoist = args?.hoist as boolean | undefined;
      const mentionable = args?.mentionable as boolean | undefined;
      const reason = args?.reason as string | undefined;

      const result = await discordClient.createRole(serverId, { name, permissions, color, hoist, mentionable }, reason);

      if (result.ok) {
        return {
          content: [{ type: 'text', text: `Role ${result.name} created (${result.role_id}). Permissions: ${(result.permissions ?? []).join(', ') || 'none'}.` }],
        };
      }

      return {
        content: [{ type: 'text', text: `Failed to create role: ${result.error}` }],
      };
    }

    case 'discord_edit_role': {
      const serverId = args?.server_id as string;
      const roleId = args?.role_id as string;
      const name = args?.name as string | undefined;
      const color = args?.color as string | undefined;
      const add = args?.add as string[] | undefined;
      const remove = args?.remove as string[] | undefined;
      const hoist = args?.hoist as boolean | undefined;
      const mentionable = args?.mentionable as boolean | undefined;
      const reason = args?.reason as string | undefined;

      const result = await discordClient.editRole(serverId, roleId, { name, color, add, remove, hoist, mentionable }, reason);

      if (result.ok) {
        return {
          content: [{ type: 'text', text: `Role ${result.role_id} updated. Permissions: ${(result.permissions ?? []).join(', ') || 'none'}.` }],
        };
      }

      return {
        content: [{ type: 'text', text: `Failed to edit role: ${result.error}` }],
      };
    }

    case 'discord_set_channel_permission': {
      const serverId = args?.server_id as string;
      const channelId = args?.channel_id as string;
      const targetId = args?.target_id as string;
      const targetType = args?.target_type as 'role' | 'member';
      const allow = args?.allow as string[] | undefined;
      const deny = args?.deny as string[] | undefined;
      const neutral = args?.neutral as string[] | undefined;
      const clear = args?.clear as boolean | undefined;
      const reason = args?.reason as string | undefined;

      const result = await discordClient.setChannelPermission(
        serverId,
        channelId,
        targetId,
        targetType,
        { allow, deny, neutral, clear },
        reason
      );

      if (result.ok) {
        return {
          content: [{ type: 'text', text: `Channel permission set for ${result.target_id}. Allow: ${(result.allow ?? []).join(', ') || 'none'}. Deny: ${(result.deny ?? []).join(', ') || 'none'}.` }],
        };
      }

      return {
        content: [{ type: 'text', text: `Failed to set channel permission: ${result.error}` }],
      };
    }

    // ============================================
    // Priority 4: Awareness
    // ============================================

    case 'discord_list_members': {
      const serverId = args?.server_id as string;
      const limit = (args?.limit as number) || 100;

      const members = await discordClient.listMembers(serverId, limit);

      if (!members) {
        return {
          content: [{ type: 'text', text: 'Server not found or not accessible.' }],
        };
      }

      const formatted = members.map(m =>
        `- ${m.tag} (${m.id})\n  Roles: ${m.roles.join(', ') || 'None'}`
      ).join('\n\n');

      return {
        content: [{ type: 'text', text: `Members (${members.length}):\n\n${formatted}` }],
      };
    }

    case 'discord_get_user_info': {
      const serverId = args?.server_id as string;
      const userId = args?.user_id as string;

      const userInfo = await discordClient.getUserInfo(serverId, userId);

      if (!userInfo) {
        return {
          content: [{ type: 'text', text: 'User not found or not accessible.' }],
        };
      }

      const roles = userInfo.roles.map(r => r.name).join(', ') || 'None';
      const formatted = `**${userInfo.displayName}** (${userInfo.tag})
ID: ${userInfo.id}
Status: ${userInfo.status} (${userInfo.isOnline ? 'online' : 'offline'})
Joined: ${userInfo.joinedAt || 'Unknown'}
Roles: ${roles}`;

      return {
        content: [{ type: 'text', text: formatted }],
      };
    }

    case 'discord_list_roles': {
      const serverId = args?.server_id as string;

      const roles = await discordClient.listRoles(serverId);

      if (!roles) {
        return {
          content: [{ type: 'text', text: 'Server not found or not accessible.' }],
        };
      }

      const formatted = roles.map(r =>
        `- ${r.name} (${r.id}) [${r.color}] Position: ${r.position}`
      ).join('\n');

      return {
        content: [{ type: 'text', text: `Roles (${roles.length}):\n\n${formatted}` }],
      };
    }

    case 'discord_list_stickers': {
      const serverId = args?.server_id as string;

      const stickers = await discordClient.listStickers(serverId);

      if (!stickers) {
        return {
          content: [{ type: 'text', text: 'Server not found or not accessible.' }],
        };
      }

      if (stickers.length === 0) {
        return {
          content: [{ type: 'text', text: 'No stickers found in this server.' }],
        };
      }

      const formatted = stickers.map(s =>
        `- ${s.name} (${s.id})${s.tags ? ` [${s.tags}]` : ''}${s.description ? `: ${s.description}` : ''}`
      ).join('\n');

      return {
        content: [{ type: 'text', text: `Stickers (${stickers.length}):\n\n${formatted}` }],
      };
    }

    case 'discord_find_message': {
      const messageId = args?.message_id as string;
      const serverId = args?.server_id as string | undefined;

      const result = await discordClient.findMessage(messageId, serverId);

      if (result.error) {
        return { content: [{ type: 'text', text: result.error }] };
      }
      if (!result.found) {
        // Say what WAS looked at. "Not found" with no scope is indistinguishable
        // from "I did not really look", and the creation time is still a real
        // fact recovered from the ID itself.
        return {
          content: [{
            type: 'text',
            text: `No message ${messageId} found. Searched ${result.channelsSearched} channel(s), skipped ${result.channelsSkipped} created after it.`
              + (result.createdAt ? ` The ID itself decodes to ${result.createdAt} — if that looks wrong, it may be a CHANNEL id, not a message id.` : ''),
          }],
        };
      }

      const m = result.message!;
      const lines = [
        `Found in #${m.channelName} (${m.guildName})`,
        `channel_id: ${m.channelId}`,
        `${m.author} at ${m.timestamp}`,
        m.url,
        '',
        m.content || '(no text content)',
      ];
      if (m.attachments.length > 0) {
        lines.push('', `[Attachments] ${m.attachments.length}`);
        for (const a of m.attachments) lines.push(`  - ${a.name}${a.contentType ? ` | ${a.contentType}` : ''}`);
        lines.push(`  \u2b06 fetch with discord_fetch_attachment(channel_id="${m.channelId}", message_id="${m.id}") then Read the path.`);
      }
      lines.push('', `(searched ${result.channelsSearched}, skipped ${result.channelsSkipped} by creation date)`);

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    case 'discord_search_messages': {
      const channelId = args?.channel_id as string;
      const authorId = args?.author_id as string | undefined;
      const keyword = args?.keyword as string | undefined;
      const before = args?.before as string | undefined;
      const after = args?.after as string | undefined;
      const hasAttachment = args?.has_attachment as boolean | undefined;
      const limit = Math.min((args?.limit as number) ?? 20, 50);
      const scanDepth = Math.min((args?.scan_depth as number) ?? 200, 500);

      // Require at least one filter
      if (!authorId && !keyword && !before && !after && hasAttachment === undefined) {
        return {
          content: [{ type: 'text', text: 'At least one filter (author_id, keyword, before, after, has_attachment) is required alongside channel_id.' }],
          isError: true,
        };
      }

      const result = await discordClient.searchMessages(
        channelId,
        { authorId, keyword, before, after, hasAttachment },
        limit,
        scanDepth
      );

      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    // Persona + extra instructions: read and written through the same settings file the bot uses,
    // recorded as the agent's (the owner sees them in the page history and can undo them).
    case 'discord_persona_read':
    case 'discord_persona_update':
    case 'discord_instructions_read':
    case 'discord_instructions_update': {
      // Only the local settings file + direct model are reachable from here. Under any other plug the running
      // bot reads its persona elsewhere, so a "successful" write would go to a file nobody reads: refuse.
      if (!personaToolsReachable(houseConfig.plugs)) {
        return { content: [{ type: 'text', text: 'Persona tools are not available with this configuration: the persona is not held in the local settings here.' }], isError: true };
      }
      const store = settingsStoreFor(process.env.SETTINGS_PATH || './data/settings.json');
      try {
        const provider = personaFromEnv(process.env, () => store.peekPersona());
        const result =
          name === 'discord_persona_read' ? await readPersona(store, provider)
          : name === 'discord_persona_update' ? await updatePersona(store, provider, Object.fromEntries(['text', 'name', 'voice'].filter((k) => args?.[k] !== undefined).map((k) => [k, args![k]])), 'agent')
          : name === 'discord_instructions_read' ? await readInstructions(store)
          : await updateInstructions(store, args?.text, 'agent');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const msg = err instanceof PersonaEditError ? err.message : 'persona request failed';
        return { content: [{ type: 'text', text: msg }], isError: true };
      }
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
}
