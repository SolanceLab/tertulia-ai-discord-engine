// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import {
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
import { assertNoAdministratorGrant, applyRolePermEdit, assertHosMutation, parsePermissionNames, namesFromBits, mergeOverwrite } from '../role-admin.js';
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

export async function editMessage(client: Client, botUserId: string | null, channelId: string, messageId: string, newContent: string): Promise<boolean> {
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

    await message.edit(newContent);
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
