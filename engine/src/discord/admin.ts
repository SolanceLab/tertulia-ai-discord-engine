// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import {
  AuditLogEvent,
  GuildChannel,
  OverwriteType,
  DMChannel,
  ForumChannel,
  ChannelType,
  TextChannel,
  Client,
  ThreadChannel,
} from 'discord.js';
import type { HexColorString } from 'discord.js';
import { assertNoAdministratorGrant, applyRolePermEdit, assertHosMutation, ToolRefusal, assertHomeServerOnly, parsePermissionNames, namesFromBits, mergeOverwrite } from '../role-admin.js';
import { HOS_SERVER_ID } from '../presence-engine.js';
import type { ChannelInfo, ServerChannels, CategoryInfo } from './helpers.js';

/**
 * Permissions that grant power over the SERVER or over other PEOPLE, as
 * opposed to ordinary participation. Surfaced by name on every role so a
 * permission audit is one call instead of a raw bitfield nobody reads.
 * (the owner asked for exactly this audit on 13 Aug 2026 and the tool could not
 * answer it — it returned name/colour/position and dropped `permissions`.)
 */
const SENSITIVE_PERMISSIONS = [
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels',
  'ManageWebhooks', 'BanMembers', 'KickMembers', 'ModerateMembers',
  'ManageMessages', 'MentionEveryone', 'ManageNicknames', 'ManageThreads',
  'ViewAuditLog', 'ManageGuildExpressions', 'ManageEvents', 'SendTTSMessages',
] as const;

/** Every server the bot is in, for the settings page's Servers section. */
export function listServers(client: Client): Array<{ id: string; name: string; icon: string | null; channel_count: number; joined_at: string | null }> {
  return Array.from(client.guilds.cache.values()).map((g) => ({
    id: g.id,
    name: g.name,
    icon: g.iconURL?.() ?? null,
    channel_count: g.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).size,
    joined_at: g.joinedAt ? g.joinedAt.toISOString() : null,
  }));
}

export async function listServerChannels(client: Client, serverId: string): Promise<ServerChannels | null> {
  try {
    const guild = await client.guilds.fetch(serverId);
    if (!guild) {
      console.error(`[Discord] Server ${serverId} not found`);
      return null;
    }

    // Fetch all channels
    const channels = await guild.channels.fetch();

    // Map channel type to readable string
    const getChannelType = (type: ChannelType): string => {
      switch (type) {
        case ChannelType.GuildText: return 'text';
        case ChannelType.GuildVoice: return 'voice';
        case ChannelType.GuildCategory: return 'category';
        case ChannelType.GuildAnnouncement: return 'announcement';
        case ChannelType.GuildForum: return 'forum';
        case ChannelType.GuildStageVoice: return 'stage';
        default: return 'other';
      }
    };

    // Organize by category
    const categories: Map<string, CategoryInfo> = new Map();
    const uncategorized: ChannelInfo[] = [];

    // First pass: collect categories
    channels.forEach(channel => {
      if (channel && channel.type === ChannelType.GuildCategory) {
        categories.set(channel.id, {
          id: channel.id,
          name: channel.name,
          position: channel.position,
          channels: []
        });
      }
    });

    // Second pass: assign channels to categories
    channels.forEach(channel => {
      if (!channel || channel.type === ChannelType.GuildCategory) return;

      const channelInfo: ChannelInfo = {
        id: channel.id,
        name: channel.name,
        type: getChannelType(channel.type),
        position: 'position' in channel ? channel.position : 0
      };

      const parentId = 'parentId' in channel ? channel.parentId : null;

      if (parentId && categories.has(parentId)) {
        categories.get(parentId)!.channels.push(channelInfo);
      } else {
        uncategorized.push(channelInfo);
      }
    });

    // Sort categories and their channels by position
    const sortedCategories = Array.from(categories.values())
      .sort((a, b) => a.position - b.position)
      .map(cat => ({
        ...cat,
        channels: cat.channels.sort((a, b) => a.position - b.position).map(ch => ({ ...ch, category_position: cat.position }))
      }));

    uncategorized.sort((a, b) => a.position - b.position);

    return {
      serverName: guild.name,
      serverId: guild.id,
      categories: sortedCategories,
      uncategorized
    };
  } catch (error) {
    console.error(`[Discord] Failed to list channels for server ${serverId}:`, error);
    return null;
  }
}

export async function createChannel(client: Client, 
    serverId: string,
    name: string,
    type: 'text' | 'voice' | 'forum' | 'announcement' = 'text',
    options?: { categoryId?: string; topic?: string; nsfw?: boolean }
): Promise<{ id: string; name: string } | null> {
  try {
    const guild = await client.guilds.fetch(serverId);
    if (!guild) return null;

    const channelTypeMap: Record<string, ChannelType.GuildText | ChannelType.GuildVoice | ChannelType.GuildForum | ChannelType.GuildAnnouncement> = {
      'text': ChannelType.GuildText,
      'voice': ChannelType.GuildVoice,
      'forum': ChannelType.GuildForum,
      'announcement': ChannelType.GuildAnnouncement
    };
    const channelType = channelTypeMap[type] ?? ChannelType.GuildText;

    const channel = await guild.channels.create({
      name: name,
      type: channelType,
      parent: options?.categoryId,
      topic: options?.topic,
      nsfw: options?.nsfw || false
    });

    console.error(`[Discord] Created channel #${channel.name} (${channel.id})`);
    return { id: channel.id, name: channel.name };
  } catch (error) {
    console.error(`[Discord] Failed to create channel:`, error);
    return null;
  }
}

export async function setChannelTopic(client: Client, channelId: string, topic: string): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('setTopic' in channel)) return false;

    await (channel as TextChannel).setTopic(topic);
    console.error(`[Discord] Set topic for channel ${channelId}`);
    return true;
  } catch (error) {
    console.error(`[Discord] Failed to set channel topic:`, error);
    return false;
  }
}

export async function renameChannel(client: Client, channelId: string, newName: string): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('setName' in channel)) return false;

    await (channel as GuildChannel).setName(newName);
    console.error(`[Discord] Renamed channel to #${newName}`);
    return true;
  } catch (error) {
    console.error(`[Discord] Failed to rename channel:`, error);
    return false;
  }
}

export async function deleteChannel(client: Client, channelId: string, reason?: string): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('delete' in channel)) return false;
    // Resolve the channel's own server first: a channel outside the home server (or a DM) is not ours to delete.
    const guildId = 'guildId' in channel ? channel.guildId : null;
    if (!guildId) return false;
    assertHosMutation(guildId);

    await (channel as GuildChannel).delete(reason);
    console.error(`[Discord] Deleted channel ${channelId}`);
    return true;
  } catch (error) {
    console.error(`[Discord] Failed to delete channel:`, error);
    return false;
  }
}

export async function createCategory(client: Client, 
    serverId: string,
    name: string,
    position?: number
): Promise<{ id: string; name: string } | null> {
  try {
    const guild = await client.guilds.fetch(serverId);
    if (!guild) return null;

    const category = await guild.channels.create({
      name: name,
      type: ChannelType.GuildCategory,
      position: position
    });

    console.error(`[Discord] Created category ${category.name} (${category.id})`);
    return { id: category.id, name: category.name };
  } catch (error) {
    console.error(`[Discord] Failed to create category:`, error);
    return null;
  }
}

export async function moveChannel(client: Client, 
    channelId: string,
    categoryId?: string | null,
    position?: number
): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('setParent' in channel)) return false;

    const guildChannel = channel as GuildChannel;

    if (categoryId !== undefined) {
      await guildChannel.setParent(categoryId);
    }

    if (position !== undefined) {
      await guildChannel.setPosition(position);
    }

    console.error(`[Discord] Moved channel ${channelId}`);
    return true;
  } catch (error) {
    console.error(`[Discord] Failed to move channel:`, error);
    return false;
  }
}

export async function addReaction(client: Client, channelId: string, messageId: string, emoji: string): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);

    // Allow text channels, DMs, and all thread types (including forum posts)
    const allowedTypes = [
      ChannelType.GuildText,
      ChannelType.DM,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ];

    if (!channel || !allowedTypes.includes(channel.type)) return false;

    const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
    const message = await textChannel.messages.fetch(messageId);
    await message.react(emoji);

    console.error(`[Discord] Added reaction ${emoji} to message ${messageId}`);
    return true;
  } catch (error) {
    console.error(`[Discord] Failed to add reaction:`, error);
    return false;
  }
}

export async function getReactions(client: Client, channelId: string, messageId: string): Promise<Array<{
    emoji: string;
    count: number;
    users: Array<{ id: string; tag: string }>;
  }> | null> {
  try {
    const channel = await client.channels.fetch(channelId);

    const allowedTypes = [
      ChannelType.GuildText,
      ChannelType.DM,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ];

    if (!channel || !allowedTypes.includes(channel.type)) return null;

    const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
    const message = await textChannel.messages.fetch(messageId);

    if (message.reactions.cache.size === 0) {
      return [];
    }

    const reactions: Array<{
      emoji: string;
      count: number;
      users: Array<{ id: string; tag: string }>;
    }> = [];

    for (const [, reaction] of message.reactions.cache) {
      // Fetch users who reacted (up to 100)
      const users = await reaction.users.fetch({ limit: 100 });

      reactions.push({
        emoji: reaction.emoji.name || reaction.emoji.toString(),
        count: reaction.count,
        users: Array.from(users.values()).map(user => ({
          id: user.id,
          tag: user.tag
        }))
      });
    }

    console.error(`[Discord] Fetched ${reactions.length} reaction types from message ${messageId}`);
    return reactions;
  } catch (error) {
    console.error(`[Discord] Failed to get reactions:`, error);
    return null;
  }
}

export async function createPoll(client: Client, 
    channelId: string,
    question: string,
    options: Array<{ text: string; emoji?: string }>,
    durationHours: number = 24,
    allowMultiselect: boolean = false
): Promise<{ messageId: string } | null> {
  try {
    const channel = await client.channels.fetch(channelId);

    const allowedTypes = [
      ChannelType.GuildText,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ];

    if (!channel || !allowedTypes.includes(channel.type)) {
      console.error(`[Discord] Channel ${channelId} does not support polls`);
      return null;
    }

    const textChannel = channel as TextChannel | ThreadChannel;

    // Build poll answers (max 10 options)
    const answers = options.slice(0, 10).map(opt => ({
      text: opt.text,
      emoji: opt.emoji ? opt.emoji : undefined
    }));

    const message = await textChannel.send({
      poll: {
        question: { text: question },
        answers: answers,
        duration: Math.min(Math.max(durationHours, 1), 768), // 1 hour to 32 days
        allowMultiselect: allowMultiselect
      }
    });

    console.error(`[Discord] Created poll in ${channelId}: "${question}"`);
    return { messageId: message.id };
  } catch (error) {
    console.error(`[Discord] Failed to create poll:`, error);
    return null;
  }
}

export async function editMessage(client: Client, botUserId: string | null, channelId: string, messageId: string, newContent?: string, embeds?: any[]): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);

    // Allow text channels, DMs, and all thread types (including forum posts)
    const allowedTypes = [
      ChannelType.GuildText,
      ChannelType.DM,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ];

    if (!channel || !allowedTypes.includes(channel.type)) return false;

    const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
    const message = await textChannel.messages.fetch(messageId);

    // Can only edit own messages
    if (message.author.id !== botUserId) {
      console.error(`[Discord] Cannot edit message - not authored by bot`);
      return false;
    }

    // Owner-directed, so no allowedMentions override (same as before). A field left out is left as it is.
    await message.edit({
      ...(newContent !== undefined ? { content: newContent } : {}),
      ...(embeds !== undefined ? { embeds } : {}),
    });
    console.error(`[Discord] Edited message ${messageId}`);
    return true;
  } catch (error) {
    console.error(`[Discord] Failed to edit message:`, error);
    return false;
  }
}

export async function deleteMessage(client: Client, channelId: string, messageId: string): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);

    // Allow text channels, DMs, and all thread types (including forum posts)
    const allowedTypes = [
      ChannelType.GuildText,
      ChannelType.DM,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ];

    if (!channel || !allowedTypes.includes(channel.type)) return false;

    const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
    const message = await textChannel.messages.fetch(messageId);

    // Other people's messages: only in the home server (when one is configured).
    // With no home server configured, or in DMs and other servers, only the bot's own.
    const own = message.author?.id === client.user?.id;
    const guildId = 'guildId' in textChannel ? (textChannel.guildId as string | null) : null;
    if (!own && !(HOS_SERVER_ID && guildId === HOS_SERVER_ID)) {
      console.error(`[Discord] Refusing to delete message ${messageId}: not the bot's own, and not in the home server.`);
      return false;
    }
    await message.delete();

    console.error(`[Discord] Deleted message ${messageId}`);
    return true;
  } catch (error) {
    console.error(`[Discord] Failed to delete message:`, error);
    return false;
  }
}

export async function pinMessage(client: Client, channelId: string, messageId: string): Promise<boolean> {
  try {
    const channel = await client.channels.fetch(channelId);

    // Allow text channels, DMs, and all thread types (including forum posts)
    const allowedTypes = [
      ChannelType.GuildText,
      ChannelType.DM,
      ChannelType.PublicThread,
      ChannelType.PrivateThread,
      ChannelType.AnnouncementThread,
    ];

    if (!channel || !allowedTypes.includes(channel.type)) return false;

    const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
    const message = await textChannel.messages.fetch(messageId);
    await message.pin();

    console.error(`[Discord] Pinned message ${messageId}`);
    return true;
  } catch (error) {
    console.error(`[Discord] Failed to pin message:`, error);
    return false;
  }
}

export async function createThread(client: Client, 
    channelId: string,
    name: string,
    messageId?: string,
    autoArchiveDuration?: 60 | 1440 | 4320 | 10080
): Promise<string | null> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) return null;

    const textChannel = channel as TextChannel;

    let thread: ThreadChannel;
    if (messageId) {
      const message = await textChannel.messages.fetch(messageId);
      thread = await message.startThread({
        name: name,
        autoArchiveDuration: autoArchiveDuration || 1440
      });
    } else {
      thread = await textChannel.threads.create({
        name: name,
        autoArchiveDuration: autoArchiveDuration || 1440
      });
    }

    console.error(`[Discord] Created thread ${thread.name} (${thread.id})`);
    return thread.id;
  } catch (error) {
    console.error(`[Discord] Failed to create thread:`, error);
    return null;
  }
}

export async function createForumPost(client: Client, 
    channelId: string,
    title: string,
    content: string,
    tags?: string[]
): Promise<{ threadId: string; messageId: string } | null> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      console.error(`[Discord] Channel ${channelId} is not a forum channel`);
      return null;
    }

    const forumChannel = channel as ForumChannel;
    const thread = await forumChannel.threads.create({
      name: title,
      message: { content: content },
      appliedTags: tags || []
    });

    console.error(`[Discord] Created forum post "${title}" (${thread.id})`);
    return {
      threadId: thread.id,
      messageId: thread.lastMessageId || thread.id
    };
  } catch (error) {
    console.error(`[Discord] Failed to create forum post:`, error);
    return null;
  }
}

export async function listForumThreads(client: Client, 
    channelId: string,
    limit: number = 20,
    archived: boolean = false
): Promise<Array<{
    id: string;
    name: string;
    createdAt: string;
    messageCount: number;
    archived: boolean;
  }>> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildForum) {
      console.error(`[Discord] Channel ${channelId} is not a forum channel`);
      return [];
    }

    const forumChannel = channel as ForumChannel;

    // Fetch active threads
    const activeThreads = await forumChannel.threads.fetchActive();

    // Optionally fetch archived threads
    let archivedThreads: ThreadChannel[] = [];
    if (archived) {
      const fetchedArchived = await forumChannel.threads.fetchArchived({ limit });
      archivedThreads = Array.from(fetchedArchived.threads.values());
    }

    // Combine and format
    const allThreads = [
      ...Array.from(activeThreads.threads.values()),
      ...archivedThreads
    ];

    const result = allThreads.slice(0, limit).map(thread => ({
      id: thread.id,
      name: thread.name,
      createdAt: thread.createdAt?.toISOString() || 'unknown',
      messageCount: thread.messageCount || 0,
      archived: thread.archived || false
    }));

    console.error(`[Discord] Found ${result.length} threads in forum ${channelId}`);
    return result;
  } catch (error) {
    console.error(`[Discord] Failed to list forum threads:`, error);
    return [];
  }
}

export async function timeoutUser(client: Client, 
    serverId: string,
    userId: string,
    durationMinutes: number,
    reason?: string
): Promise<boolean> {
  try {
    assertHosMutation(serverId);
    const guild = await client.guilds.fetch(serverId);
    if (!guild) return false;

    const member = await guild.members.fetch(userId);
    const duration = Math.min(durationMinutes, 40320) * 60 * 1000; // Convert to ms, max 28 days

    await member.timeout(duration, reason);
    console.error(`[Discord] Timed out user ${userId} for ${durationMinutes} minutes`);
    return true;
  } catch (error) {
    console.error(`[Discord] Failed to timeout user:`, error);
    return false;
  }
}

export async function assignRole(client: Client, serverId: string, userId: string, roleId: string, reason?: string): Promise<boolean> {
  try {
    assertHosMutation(serverId);
    const guild = await client.guilds.fetch(serverId);
    if (!guild) return false;

    // force: the role cache only refreshes on the gateway's GUILD_ROLE_UPDATE.
    const role = await guild.roles.fetch(roleId, { force: true });
    if (!role) return false;
    // Same floor as createRole/editRole: Administrator is never handed out through these tools.
    assertNoAdministratorGrant(role.permissions.bitfield);

    const member = await guild.members.fetch(userId);
    await member.roles.add(roleId, reason);

    console.error(`[Discord] Assigned role ${roleId} to user ${userId}`);
    return true;
  } catch (error) {
    console.error(`[Discord] Failed to assign role:`, error);
    return false;
  }
}

export async function removeRole(client: Client, serverId: string, userId: string, roleId: string, reason?: string): Promise<boolean> {
  try {
    assertHosMutation(serverId);
    const guild = await client.guilds.fetch(serverId);
    if (!guild) return false;

    const member = await guild.members.fetch(userId);
    await member.roles.remove(roleId, reason);

    console.error(`[Discord] Removed role ${roleId} from user ${userId}`);
    return true;
  } catch (error) {
    console.error(`[Discord] Failed to remove role:`, error);
    return false;
  }
}

export async function createRole(client: Client, 
    serverId: string,
    options: { name: string; permissions?: string[]; color?: string; hoist?: boolean; mentionable?: boolean },
    reason?: string
): Promise<{ ok: boolean; error?: string; role_id?: string; name?: string; permissions?: string[] }> {
  try {
    assertHosMutation(serverId);
    const bits = parsePermissionNames(options.permissions ?? []);
    assertNoAdministratorGrant(bits);

    const guild = await client.guilds.fetch(serverId);
    if (!guild) return { ok: false, error: 'Server not found.' };

    const role = await guild.roles.create({
      name: options.name,
      permissions: bits,
      color: options.color as HexColorString | undefined,
      hoist: options.hoist,
      mentionable: options.mentionable,
      reason,
    });

    console.error(`[Discord] Created role ${role.name} (${role.id})`);
    return { ok: true, role_id: role.id, name: role.name, permissions: role.permissions.toArray() as string[] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Discord] Failed to create role:`, error);
    return { ok: false, error: message };
  }
}

export async function editRole(client: Client, 
    serverId: string,
    roleId: string,
    options: { name?: string; color?: string; add?: string[]; remove?: string[]; hoist?: boolean; mentionable?: boolean },
    reason?: string
): Promise<{ ok: boolean; error?: string; role_id?: string; permissions?: string[] }> {
  try {
    assertHosMutation(serverId);
    const addBits = parsePermissionNames(options.add ?? []);
    const removeBits = parsePermissionNames(options.remove ?? []);
    assertNoAdministratorGrant(addBits);

    const guild = await client.guilds.fetch(serverId);
    if (!guild) return { ok: false, error: 'Server not found.' };

    // force: the role cache only refreshes on the gateway's GUILD_ROLE_UPDATE,
    // so a second edit landing before it would start from stale permissions
    // and silently undo the first.
    const role = await guild.roles.fetch(roleId, { force: true });
    if (!role) return { ok: false, error: 'Role not found.' };

    const newBits = applyRolePermEdit(role.permissions.bitfield, addBits, removeBits);

    const updated = await guild.roles.edit(role, {
      name: options.name,
      color: options.color as HexColorString | undefined,
      permissions: newBits,
      hoist: options.hoist,
      mentionable: options.mentionable,
      reason,
    });

    console.error(`[Discord] Edited role ${updated.name} (${updated.id})`);
    return { ok: true, role_id: updated.id, permissions: updated.permissions.toArray() as string[] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Discord] Failed to edit role:`, error);
    return { ok: false, error: message };
  }
}

export async function listMembers(client: Client, serverId: string, limit: number = 100): Promise<Array<{ id: string; tag: string; roles: string[] }> | null> {
  try {
    const guild = await client.guilds.fetch(serverId);
    if (!guild) return null;

    const members = await guild.members.fetch({ limit });

    return Array.from(members.values()).map(member => ({
      id: member.id,
      tag: member.user.tag,
      roles: member.roles.cache.map(role => role.name)
    }));
  } catch (error) {
    console.error(`[Discord] Failed to list members:`, error);
    return null;
  }
}

export async function getUserInfo(client: Client, serverId: string, userId: string): Promise<{
    id: string;
    tag: string;
    displayName: string;
    joinedAt: string | null;
    roles: Array<{ id: string; name: string }>;
    isOnline: boolean;
    status: string;
  } | null> {
  try {
    const guild = await client.guilds.fetch(serverId);
    if (!guild) return null;

    const member = await guild.members.fetch(userId);

    return {
      id: member.id,
      tag: member.user.tag,
      displayName: member.displayName,
      joinedAt: member.joinedAt?.toISOString() || null,
      roles: member.roles.cache.map(role => ({ id: role.id, name: role.name })),
      isOnline: member.presence?.status !== 'offline',
      status: member.presence?.status || 'offline'
    };
  } catch (error) {
    console.error(`[Discord] Failed to get user info:`, error);
    return null;
  }
}

export async function listRoles(client: Client, serverId: string): Promise<Array<{
    id: string; name: string; color: string; position: number;
    permissions: string; sensitive_permissions: string[]; is_administrator: boolean;
    managed: boolean; bot_id: string | null; member_count: number;
  }> | null> {
  try {
    const guild = await client.guilds.fetch(serverId);
    if (!guild) return null;

    const roles = await guild.roles.fetch();

    return Array.from(roles.values())
      .sort((a, b) => b.position - a.position)
      .map(role => {
        const named = role.permissions.toArray() as string[];
        return {
          id: role.id,
          name: role.name,
          color: role.hexColor,
          position: role.position,
          permissions: role.permissions.bitfield.toString(),
          // Administrator implies everything, so it is reported on its own
          // rather than hidden inside a list the reader has to reason about.
          sensitive_permissions: named.filter(p =>
            (SENSITIVE_PERMISSIONS as readonly string[]).includes(p)
          ),
          is_administrator: role.permissions.has('Administrator'),
          // `managed` marks an integration role Discord owns for a bot; those
          // cannot be edited by hand, which changes how you'd fix an over-grant.
          managed: role.managed,
          bot_id: role.tags?.botId ?? null,
          member_count: role.members.size,
        };
      });
  } catch (error) {
    console.error(`[Discord] Failed to list roles:`, error);
    return null;
  }
}

export async function listStickers(client: Client, serverId: string): Promise<Array<{ id: string; name: string; description: string | null; tags: string | null }> | null> {
  try {
    const guild = await client.guilds.fetch(serverId);
    if (!guild) return null;

    const stickers = await guild.stickers.fetch();

    return Array.from(stickers.values()).map(sticker => ({
      id: sticker.id,
      name: sticker.name,
      description: sticker.description || null,
      tags: sticker.tags || null,
    }));
  } catch (error) {
    console.error(`[Discord] Failed to list stickers:`, error);
    return null;
  }
}

export async function setChannelPermissionNow(client: Client, 
    serverId: string,
    channelId: string,
    targetId: string,
    targetType: 'role' | 'member',
    options: { allow?: string[]; deny?: string[]; neutral?: string[]; clear?: boolean },
    reason?: string
): Promise<{ ok: boolean; error?: string; channel_id?: string; target_id?: string; allow?: string[]; deny?: string[] }> {
  try {
    assertHosMutation(serverId);

    const guild = await client.guilds.fetch(serverId);
    if (!guild) return { ok: false, error: 'Server not found.' };

    // force: the overwrite cache only refreshes on the gateway's
    // CHANNEL_UPDATE, so without it a back-to-back edit merges against the
    // pre-write state and silently drops the first edit (Codex, 26 Sep:
    // deny ViewChannel then deny SendMessages left only SendMessages).
    const channel = await guild.channels.fetch(channelId, { force: true });
    if (!channel || channel.isThread() || !('permissionOverwrites' in channel)) {
      return { ok: false, error: 'Channel not found (threads inherit permissions from their parent — set them there instead).' };
    }

    const overwriteType = targetType === 'role' ? OverwriteType.Role : OverwriteType.Member;

    if (options.clear) {
      await channel.permissionOverwrites.delete(targetId, reason);
      console.error(`[Discord] Cleared channel permission overwrite for ${targetId} in #${channel.name}`);
      return { ok: true, channel_id: channel.id, target_id: targetId, allow: [], deny: [] };
    }

    const allowBits = parsePermissionNames(options.allow ?? []);
    const denyBits = parsePermissionNames(options.deny ?? []);
    const neutralBits = parsePermissionNames(options.neutral ?? []);
    assertNoAdministratorGrant(allowBits);

    const existing = channel.permissionOverwrites.cache.get(targetId);
    const current = { allow: existing?.allow.bitfield ?? 0n, deny: existing?.deny.bitfield ?? 0n };
    const merged = mergeOverwrite(current, { allow: allowBits, deny: denyBits, neutral: neutralBits });

    // Write the COMPLETE merged overwrite with create(), which replaces.
    // edit() would re-merge against the discord.js cache — the very state
    // that can be stale — so the merge happens once, above, on fresh data.
    const fullOptions: Record<string, boolean> = {};
    for (const name of namesFromBits(merged.allow)) fullOptions[name] = true;
    for (const name of namesFromBits(merged.deny)) fullOptions[name] = false;

    await channel.permissionOverwrites.create(targetId, fullOptions, { type: overwriteType, reason });

    console.error(`[Discord] Set channel permission for ${targetId} in #${channel.name}`);
    return {
      ok: true,
      channel_id: channel.id,
      target_id: targetId,
      allow: namesFromBits(merged.allow),
      deny: namesFromBits(merged.deny),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Discord] Failed to set channel permission:`, error);
    return { ok: false, error: message };
  }
}

// ============================================
// Tertúlia 1.2.0 tools. These throw ToolRefusal for a guard or a bad argument (the message is
// shown to the caller as written) and let a Discord failure through with Discord's own message.
// ============================================

const MESSAGE_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.DM,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
];

async function messageChannel(client: Client, channelId: string): Promise<TextChannel | DMChannel | ThreadChannel> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !MESSAGE_CHANNEL_TYPES.includes(channel.type)) {
    throw new ToolRefusal(`Channel ${channelId} was not found or does not hold messages.`);
  }
  return channel as TextChannel | DMChannel | ThreadChannel;
}

/** discord_list_servers: every server the bot is in, or one server in full. */
export async function describeServers(client: Client, serverId?: string): Promise<
  { servers: Array<{ id: string; name: string; member_count: number; icon_url: string | null; is_home: boolean }> } |
  { server: {
      id: string; name: string; description: string | null; owner_id: string; member_count: number;
      created_at: string; features: string[]; is_home: boolean; bot_roles: Array<{ id: string; name: string }>;
    } }
> {
  const isHome = (id: string) => !!HOS_SERVER_ID && id === HOS_SERVER_ID;
  if (serverId === undefined || serverId === '') {
    return {
      servers: Array.from(client.guilds.cache.values()).map((g) => ({
        id: g.id,
        name: g.name,
        member_count: g.memberCount,
        icon_url: g.iconURL?.() ?? null,
        is_home: isHome(g.id),
      })),
    };
  }
  let guild;
  try {
    guild = await client.guilds.fetch(serverId);
  } catch {
    guild = null;
  }
  if (!guild) throw new ToolRefusal(`The bot is not in a server with id ${serverId}.`);
  const me = guild.members.me ?? (client.user ? await guild.members.fetch(client.user.id).catch(() => null) : null);
  return {
    server: {
      id: guild.id,
      name: guild.name,
      description: guild.description ?? null,
      owner_id: guild.ownerId,
      member_count: guild.memberCount,
      created_at: guild.createdAt.toISOString(),
      features: [...guild.features].map(String),
      is_home: isHome(guild.id),
      bot_roles: me ? me.roles.cache.filter((r) => r.id !== guild.id).map((r) => ({ id: r.id, name: r.name })) : [],
    },
  };
}

/** discord_unpin_message: anywhere the bot may manage pins (Discord enforces the permission). */
export async function unpinMessage(client: Client, channelId: string, messageId: string): Promise<boolean> {
  const channel = await messageChannel(client, channelId);
  const message = await channel.messages.fetch(messageId);
  if (!message.pinned) throw new ToolRefusal(`Message ${messageId} is not pinned.`);
  await message.unpin();
  console.error(`[Discord] Unpinned message ${messageId}`);
  return true;
}

/** discord_list_pins: the pinned messages, newest pin first (raw messages; the caller maps them). */
export async function fetchPinnedMessages(client: Client, channelId: string, limit = 50): Promise<any[]> {
  const channel = await messageChannel(client, channelId);
  const n = Math.max(1, Math.min(Math.floor(Number.isFinite(limit) ? limit : 50), 50));
  const res = await (channel.messages as any).fetchPins({ limit: n });
  return (res.items as Array<{ message: any }>).map((i) => i.message).slice(0, n);
}

/** discord_remove_reaction: the bot's own reaction only. */
export async function removeOwnReaction(client: Client, channelId: string, messageId: string, emoji: string): Promise<boolean> {
  if (!emoji.trim()) throw new ToolRefusal('emoji is required.');
  const channel = await messageChannel(client, channelId);
  const message = await channel.messages.fetch(messageId);
  const custom = emoji.trim().match(/^<a?:(\w+):(\d+)>$/) ?? emoji.trim().match(/^(\w+):(\d+)$/);
  const reaction = message.reactions.cache.find((r) =>
    custom ? r.emoji.id === custom[2] : r.emoji.name === emoji.trim() || r.emoji.id === emoji.trim());
  if (!reaction) throw new ToolRefusal(`No ${emoji} reaction on message ${messageId}.`);
  if (!reaction.me) {
    throw new ToolRefusal(`The bot has not reacted with ${emoji} on message ${messageId}. This tool removes only the bot's own reaction.`);
  }
  await reaction.users.remove(client.user!.id);
  console.error(`[Discord] Removed own reaction ${emoji} from message ${messageId}`);
  return true;
}

const AUDIT_ACTIONS: Record<string, number> = Object.fromEntries(
  Object.entries(AuditLogEvent).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k.toLowerCase(), v as number]),
);
const clip = (v: unknown): unknown => {
  if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') return v ?? null;
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t.length > 200 ? t.slice(0, 200) + '...' : t;
};

/** discord_read_audit_log: home server only. */
export async function readAuditLog(client: Client, serverId: string, opts: { action?: string; userId?: string; limit?: number } = {}): Promise<{
  entries: Array<{
    id: string; action: string; executor_id: string | null; executor: string | null;
    target_id: string | null; target_type: string | null; reason: string | null; created_at: string;
    changes: Array<{ key: string; old: unknown; new: unknown }>;
  }>;
}> {
  assertHomeServerOnly(serverId, 'reading the audit log');
  let type: number | undefined;
  if (opts.action) {
    type = AUDIT_ACTIONS[opts.action.replace(/[\s_-]/g, '').toLowerCase()];
    if (type === undefined) {
      throw new ToolRefusal(`Unknown audit action ${opts.action}. Use Discord's name, for example MemberKick, MemberBanAdd, MessageDelete, RoleUpdate or ChannelCreate.`);
    }
  }
  const limit = Math.max(1, Math.min(Math.floor(opts.limit !== undefined && Number.isFinite(opts.limit) ? opts.limit : 25), 50));
  const guild = await client.guilds.fetch(serverId);
  const logs = await guild.fetchAuditLogs({ limit, ...(type !== undefined ? { type: type as AuditLogEvent } : {}), ...(opts.userId ? { user: opts.userId } : {}) });
  return {
    entries: Array.from(logs.entries.values()).map((e) => ({
      id: e.id,
      action: AuditLogEvent[e.action] ?? String(e.action),
      executor_id: e.executorId ?? null,
      executor: e.executor?.tag ?? null,
      target_id: e.targetId ?? null,
      target_type: e.targetType ?? null,
      reason: e.reason ?? null,
      created_at: e.createdAt.toISOString(),
      changes: (e.changes ?? []).map((c: any) => ({ key: String(c.key), old: clip(c.old), new: clip(c.new) })),
    })),
  };
}

const THREAD_ARCHIVE_MINUTES = [60, 1440, 4320, 10080];

async function fetchThread(client: Client, threadId: string): Promise<ThreadChannel> {
  const channel = await client.channels.fetch(threadId);
  if (!channel || !channel.isThread()) throw new ToolRefusal(`${threadId} is not a thread.`);
  return channel as ThreadChannel;
}

/** discord_edit_thread: rename/archive on the bot's own threads anywhere or any home-server thread; lock in the home server only. */
export async function editThread(client: Client, threadId: string, changes: {
  name?: string; archived?: boolean; locked?: boolean; autoArchiveMinutes?: number;
}): Promise<{ id: string; name: string; archived: boolean; locked: boolean; auto_archive_minutes: number | null }> {
  const { name, archived, locked, autoArchiveMinutes } = changes;
  if (name === undefined && archived === undefined && locked === undefined && autoArchiveMinutes === undefined) {
    throw new ToolRefusal('Give at least one change: name, archived, locked or auto_archive_minutes.');
  }
  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1 || name.length > 100)) {
    throw new ToolRefusal('name must be 1 to 100 characters.');
  }
  if (autoArchiveMinutes !== undefined && !THREAD_ARCHIVE_MINUTES.includes(autoArchiveMinutes)) {
    throw new ToolRefusal('auto_archive_minutes must be 60, 1440, 4320 or 10080.');
  }
  const thread = await fetchThread(client, threadId);
  const inHome = !!HOS_SERVER_ID && thread.guildId === HOS_SERVER_ID;
  if (locked !== undefined) assertHomeServerOnly(thread.guildId, 'locking or unlocking a thread');
  if (!inHome && thread.ownerId !== client.user?.id) {
    throw new ToolRefusal(`Refusing to edit thread ${threadId}: outside the home server the bot edits only threads it created.`);
  }
  const edited = await thread.edit({
    ...(name !== undefined ? { name: name.trim() } : {}),
    ...(archived !== undefined ? { archived } : {}),
    ...(locked !== undefined ? { locked } : {}),
    ...(autoArchiveMinutes !== undefined ? { autoArchiveDuration: autoArchiveMinutes as 60 | 1440 | 4320 | 10080 } : {}),
  });
  console.error(`[Discord] Edited thread ${threadId}`);
  return {
    id: edited.id,
    name: edited.name,
    archived: !!edited.archived,
    locked: !!edited.locked,
    auto_archive_minutes: edited.autoArchiveDuration ?? null,
  };
}

/** discord_thread_member: add or remove a member, home server only. */
export async function setThreadMember(client: Client, threadId: string, userId: string, action: string): Promise<boolean> {
  if (action !== 'add' && action !== 'remove') throw new ToolRefusal('action must be add or remove.');
  const thread = await fetchThread(client, threadId);
  assertHomeServerOnly(thread.guildId, 'changing thread members');
  if (action === 'add') await thread.members.add(userId);
  else await thread.members.remove(userId);
  console.error(`[Discord] Thread ${threadId}: ${action} ${userId}`);
  return true;
}
