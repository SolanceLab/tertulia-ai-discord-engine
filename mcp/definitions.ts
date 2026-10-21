// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * The 42 Discord MCP tools: one definition, two servers.
 *
 * The cloud Worker (the claude.ai connector, mcp/worker) and the Mac stdio server
 * (bot/src/mcp-server.ts) used to keep their own copies, and they drifted: on
 * 12 Oct 2026 discord_send_file and discord_get_user_info had been sending bodies
 * the bot rejects. Both now read this file. The bot cannot import outside
 * bot/src, so bot/scripts/sync-shared.mjs copies it to bot/src/mcp/shared/.
 *
 * This file imports nothing. Each runtime passes its own zod in.
 *
 * Rules for editing:
 * - Names and list order are part of the MCP contract. Never rename; append new tools only.
 * - Every field in `shape` must be read by the bot route at `endpoint` (bot/src/http-server.ts).
 *   The parity tests (mcp/tests) check this.
 * - `localShape` is for what only the Mac can do (local file paths). It is merged over `shape`
 *   on the Mac server and never shown to the cloud connector.
 * - `endpoint: null` means the bot has no route for the tool; each runtime answers it itself.
 *   A runtime may still wrap a tool that has an endpoint with its own handler
 *   (fetch_attachment, view_attachment, find_message, send_file with file_path).
 * - No double quotes in any description: ChatGPT's connector drops parameters whose description holds them.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  /** zod raw shape, offered by both runtimes */
  shape: Record<string, any>;
  /** extra or relaxed fields only the Mac server offers */
  localShape?: Record<string, any>;
  /** bot HTTP route ('/api/...'), or null when the bot has no route for this tool */
  endpoint: string | null;
  /** only where the bot's body keys differ from the argument names */
  toBody?: (args: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Either/or requirements the schema cannot express (zod makes each field optional on its own).
   * Returns the error message to refuse the call with, or null when the arguments are fine.
   * Every runtime runs it before touching the bot, so the same call fails the same way everywhere.
   */
  check?: (args: Record<string, unknown>) => string | null;
}

export const TOOL_NAMES: readonly string[] = Object.freeze([
  'discord_read_messages',
  'discord_send_message',
  'discord_send_dm',
  'discord_get_dm_channel',
  'discord_send_file',
  'discord_check_mentions',
  'discord_check_dms',
  'discord_get_history',
  'discord_list_channels',
  'discord_create_channel',
  'discord_set_channel_topic',
  'discord_rename_channel',
  'discord_delete_channel',
  'discord_create_category',
  'discord_move_channel',
  'discord_add_reaction',
  'discord_get_reactions',
  'discord_create_poll',
  'discord_edit_message',
  'discord_delete_message',
  'discord_pin_message',
  'discord_create_thread',
  'discord_create_forum_post',
  'discord_list_forum_threads',
  'discord_fetch_attachment',
  'discord_view_attachment',
  'discord_timeout_user',
  'discord_assign_role',
  'discord_remove_role',
  'discord_create_role',
  'discord_edit_role',
  'discord_set_channel_permission',
  'discord_list_members',
  'discord_get_user_info',
  'discord_find_message',
  'discord_search_messages',
  'discord_list_roles',
  'discord_list_stickers',
  'discord_persona_read',
  'discord_persona_update',
  'discord_instructions_read',
  'discord_instructions_update',
]);

/** @param z the caller's zod (v3) */
export function buildToolDefinitions(z: any): ToolDefinition[] {
  const FILE_DATA_MAX = 9_500_000;
  // One embed, in the same shape the read tools return, so a read embed can be sent straight back.
  // Lengths are checked by the bot (with a plain error), not here.
  const embedShape = z.object({
    title: z.string().optional(),
    description: z.string().optional().describe('Body text; markdown links work here'),
    url: z.string().optional().describe('Makes the title a link (http or https)'),
    color: z.union([z.string(), z.number()]).optional().describe('Hex string like #c9a24b, or an integer'),
    fields: z
      .array(z.object({ name: z.string(), value: z.string(), inline: z.boolean().optional() }))
      .optional(),
    footer: z
      .object({ text: z.string(), icon_url: z.string().optional(), proxy_icon_url: z.string().optional().describe('Read-only; ignored when sending') })
      .optional(),
    author: z
      .object({ name: z.string(), url: z.string().optional(), icon_url: z.string().optional(), proxy_icon_url: z.string().optional().describe('Read-only; ignored when sending') })
      .optional(),
    image_url: z.string().optional(),
    image_proxy_url: z.string().optional().describe('Read-only; ignored when sending'),
    thumbnail_url: z.string().optional(),
    thumbnail_proxy_url: z.string().optional().describe('Read-only; ignored when sending'),
    timestamp: z.string().optional().describe('ISO date'),
  });
  const defs: ToolDefinition[] = [
    {
      name: 'discord_read_messages',
      description:
        'Read the actual recent messages LIVE from a Discord channel (fetched fresh from Discord). Returns author, content, timestamp, attachments and, when a message has them, its embeds (title, description, url, color, fields, footer, author, image_url, thumbnail_url, timestamp). Use this, not discord_get_history, to see what is really in a channel.',
      shape: {
        channel_id: z.string().describe('The Discord channel ID to read from'),
        limit: z.number().optional().describe('Number of messages to fetch (max 50, default 20)'),
      },
      endpoint: '/api/read-messages',
    },
    {
      name: 'discord_send_message',
      description:
        'Send a message to a Discord channel. Optionally reply to a specific message, send up to 3 guild stickers, and/or send embeds (up to 10) in the same message. Content is optional when sticker_ids or embeds is given.',
      shape: {
        channel_id: z.string().describe('The Discord channel ID to send to'),
        content: z.string().optional().describe('The message content to send (max 2000 characters). Optional when sticker_ids or embeds is provided.'),
        reply_to_message_id: z.string().optional().describe('Optional message ID to reply to. Creates a threaded reply linking to the original message.'),
        sticker_ids: z
          .array(z.string())
          .max(3)
          .optional()
          .describe('Optional array of guild sticker IDs (max 3) to send with the message, all in one Discord message. When provided, content is not required. Look IDs up with discord_list_stickers.'),
        embeds: z
          .array(embedShape)
          .optional()
          .describe('Optional embeds (max 10; title 256, description 4096, 25 fields, 6000 characters in all). Same shape discord_read_messages returns. When provided, content is not required.'),
      },
      endpoint: '/api/send-message',
      check: (a) =>
        !a.channel_id ||
        (!(typeof a.content === 'string' && a.content.length > 0) &&
          !(Array.isArray(a.sticker_ids) && a.sticker_ids.length > 0) &&
          !(Array.isArray(a.embeds) && a.embeds.length > 0))
          ? 'channel_id and content required (or sticker_ids, or embeds)'
          : null,
    },
    {
      name: 'discord_send_dm',
      description: 'Send a direct message to a user.',
      shape: {
        user_id: z.string().describe('The Discord user ID to DM'),
        content: z.string().describe('The message content to send'),
      },
      endpoint: '/api/send-dm',
    },
    {
      name: 'discord_get_dm_channel',
      description: 'Get the DM channel ID for a user. Returns the channel ID needed for discord_read_messages on DM conversations.',
      shape: {
        user_id: z.string().describe('The Discord user ID to look up'),
      },
      endpoint: '/api/get-dm-channel',
    },
    {
      name: 'discord_send_file',
      description:
        'Send a file to a Discord channel. Provide the file contents as base64 in file_data and the attachment name in file_name. The bot accepts request bodies up to 10 MB, so keep the encoded file under about 7 MB. On the Mac server, file_path (a local file) can be given instead of file_data.',
      shape: {
        channel_id: z.string().min(1).describe('The Discord channel ID to send to'),
        file_name: z.string().min(1).describe('The filename to use for the attachment'),
        file_data: z.string().min(1).max(FILE_DATA_MAX).describe('Base64-encoded file data'),
        content: z.string().optional().describe('Optional message text to accompany the file'),
      },
      localShape: {
        file_data: z.string().min(1).max(FILE_DATA_MAX).optional().describe('Base64-encoded file data (or give file_path instead)'),
        file_path: z.string().optional().describe('Path to a local file to send (alternative to file_data). The file is read on this Mac; its bytes never enter the conversation.'),
      },
      endpoint: '/api/send-file',
    },
    {
      name: 'discord_check_mentions',
      description:
        'Check pending @mentions of the bot. Only the Mac server in direct mode keeps a queue. On the cloud connector and in proxy mode the bot handles mentions itself (the owner gets auto-replies, other mentions send the owner a DM notification) and this returns a note saying so; use discord_read_messages to see mentions in context.',
      shape: {},
      endpoint: null,
    },
    {
      name: 'discord_check_dms',
      description:
        'Check pending direct messages to the bot. Only the Mac server in direct mode keeps a queue. On the cloud connector and in proxy mode the bot handles DMs itself (the owner receives DM notifications) and this returns a note saying so; use discord_get_dm_channel, then discord_read_messages, to read a DM conversation.',
      shape: {},
      endpoint: null,
    },
    {
      name: 'discord_get_history',
      description:
        "Reads the bot's STORED conversation memory for a channel (messages the bot recorded into its own memory), NOT live Discord. Returns empty for channels the bot has not actively conversed in (forums, lounges, post-only channels). To read the actual current messages in a channel (with their embeds, which stored memory does not keep), use discord_read_messages.",
      shape: {
        channel_id: z.string().describe('The Discord channel ID'),
        limit: z.number().optional().describe('Number of messages to retrieve (default 20)'),
      },
      endpoint: '/api/get-history',
    },
    {
      name: 'discord_list_channels',
      description: 'List all channels in a server.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID'),
      },
      endpoint: '/api/list-channels',
    },
    {
      name: 'discord_create_channel',
      description: 'Create a new channel in a server.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID'),
        name: z.string().describe('Channel name (will be lowercased, spaces become hyphens)'),
        type: z.enum(['text', 'voice', 'forum', 'announcement']).optional().describe('Channel type (default: text)'),
        category_id: z.string().optional().describe('Optional: Parent category ID to place the channel under'),
        topic: z.string().optional().describe('Optional: Channel topic/description'),
        nsfw: z.boolean().optional().describe('Optional: Mark channel as age-restricted (default: false)'),
      },
      endpoint: '/api/create-channel',
    },
    {
      name: 'discord_set_channel_topic',
      description: 'Set the topic/description of a channel.',
      shape: {
        channel_id: z.string().describe('The channel ID to update'),
        topic: z.string().describe('New topic/description (max 1024 characters)'),
      },
      endpoint: '/api/set-channel-topic',
    },
    {
      name: 'discord_rename_channel',
      description: 'Rename a channel.',
      shape: {
        channel_id: z.string().describe('The channel ID to rename'),
        new_name: z.string().describe('The new channel name'),
      },
      endpoint: '/api/rename-channel',
    },
    {
      name: 'discord_delete_channel',
      description: 'Delete a channel. This action is irreversible.',
      shape: {
        channel_id: z.string().describe('The channel ID to delete'),
        reason: z.string().optional().describe('Optional: Reason for deletion (appears in audit log)'),
      },
      endpoint: '/api/delete-channel',
    },
    {
      name: 'discord_create_category',
      description: 'Create a new category in a server.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID'),
        name: z.string().describe('The category name'),
        position: z.number().optional().describe('Optional: Position in the channel list (0 = top)'),
      },
      endpoint: '/api/create-category',
    },
    {
      name: 'discord_move_channel',
      description: 'Move a channel to a different category and/or position.',
      shape: {
        channel_id: z.string().describe('The channel ID to move'),
        category_id: z
          .string()
          .nullable()
          .optional()
          .describe('Optional: New parent category ID. null removes the channel from its category; omit to leave it where it is.'),
        position: z.number().optional().describe('Optional: New position within the category'),
      },
      endpoint: '/api/move-channel',
    },
    {
      name: 'discord_add_reaction',
      description: 'Add a reaction to a message.',
      shape: {
        channel_id: z.string().describe('The channel ID containing the message'),
        message_id: z.string().describe('The message ID to react to'),
        emoji: z.string().describe('Emoji to react with (unicode emoji or custom emoji string)'),
      },
      endpoint: '/api/add-reaction',
    },
    {
      name: 'discord_get_reactions',
      description: 'Get all reactions on a message with the list of users who reacted.',
      shape: {
        channel_id: z.string().describe('The channel ID containing the message'),
        message_id: z.string().describe('The message ID to get reactions from'),
      },
      endpoint: '/api/get-reactions',
    },
    {
      name: 'discord_create_poll',
      description: 'Create a native Discord poll in a channel.',
      shape: {
        channel_id: z.string().describe('The channel ID to create the poll in'),
        question: z.string().describe('The poll question'),
        options: z
          .array(
            z.object({
              text: z.string().describe('Option text'),
              emoji: z.string().optional().describe('Optional emoji for this option'),
            }),
          )
          .min(2)
          .max(10)
          .describe('Poll options (2 to 10), each an object with text and an optional emoji'),
        duration_hours: z.number().optional().describe('How long the poll runs in hours (1-768, default 24)'),
        allow_multiselect: z.boolean().optional().describe('Allow users to select multiple options (default false)'),
      },
      endpoint: '/api/create-poll',
    },
    {
      name: 'discord_edit_message',
      description:
        'Edit a message sent by the bot: its text (new_content), its embeds (embeds), or both. embeds REPLACES the message embeds, and [] removes them. To keep an embed unchanged while editing something else, read the message first, change only what you mean to, and send the whole embed back (or leave embeds out to leave the embeds as they are). At least one of new_content or embeds is required.',
      shape: {
        channel_id: z.string().describe('The channel ID containing the message'),
        message_id: z.string().describe('The message ID to edit'),
        new_content: z.string().optional().describe('New message content. Optional when embeds is given.'),
        embeds: z
          .array(embedShape)
          .optional()
          .describe('New embeds, replacing the old ones (max 10; same shape discord_read_messages returns). [] removes every embed.'),
      },
      endpoint: '/api/edit-message',
      check: (a) =>
        !a.channel_id || !a.message_id || (typeof a.new_content !== 'string' && !Array.isArray(a.embeds))
          ? 'channel_id, message_id, and at least one of new_content or embeds required'
          : null,
    },
    {
      name: 'discord_delete_message',
      description: "Delete a message from a channel. The bot can delete its own messages anywhere; other people's messages only in the home server (hosServerId in the house config file), and when no home server is configured, never.",
      shape: {
        channel_id: z.string().describe('The channel ID containing the message'),
        message_id: z.string().describe('The message ID to delete'),
      },
      endpoint: '/api/delete-message',
    },
    {
      name: 'discord_pin_message',
      description: 'Pin a message in a channel.',
      shape: {
        channel_id: z.string().describe('The channel ID containing the message'),
        message_id: z.string().describe('The message ID to pin'),
      },
      endpoint: '/api/pin-message',
    },
    {
      name: 'discord_create_thread',
      description: 'Create a thread in a text channel, optionally from an existing message.',
      shape: {
        channel_id: z.string().describe('The channel ID to create the thread in'),
        name: z.string().describe('Thread name'),
        message_id: z.string().optional().describe('Optional: Message ID to start the thread from'),
        auto_archive_duration: z.number().optional().describe('Optional: Minutes until auto-archive (60, 1440, 4320, 10080)'),
      },
      endpoint: '/api/create-thread',
    },
    {
      name: 'discord_create_forum_post',
      description: 'Create a new post in a forum channel.',
      shape: {
        channel_id: z.string().describe('The forum channel ID'),
        title: z.string().describe('Post title (becomes the thread name)'),
        content: z.string().describe('Initial message content for the post'),
        tags: z.array(z.string()).optional().describe('Optional: Array of tag IDs to apply to the post'),
      },
      endpoint: '/api/create-forum-post',
    },
    {
      name: 'discord_list_forum_threads',
      description: 'List threads in a forum channel.',
      shape: {
        channel_id: z.string().describe('The forum channel ID'),
        limit: z.number().optional().describe('Maximum number of threads to return (default 20)'),
        include_archived: z.boolean().optional().describe('Include archived threads (default false)'),
      },
      endpoint: '/api/list-forum-threads',
    },
    {
      name: 'discord_fetch_attachment',
      description:
        'Get the attachments on a message. On the Mac server the files are downloaded to the local attachments folder and the saved paths are returned. On the cloud connector it returns fresh CDN URLs to view or download the files. To SEE an image, use discord_view_attachment.',
      shape: {
        channel_id: z.string().describe('The channel ID where the message exists'),
        message_id: z.string().describe('The message ID containing the attachment(s)'),
        filename: z.string().optional().describe('Specific filename to fetch if the message has multiple attachments. If omitted, fetches all.'),
      },
      endpoint: '/api/get-attachment-urls',
    },
    {
      name: 'discord_view_attachment',
      description:
        'SEE an image attached to a Discord message. Returns the actual picture, not a link. Use this whenever a message has an image that matters, especially from a wing that cannot open files. Returns ONE image per call; if the message holds several, call again with filename.',
      shape: {
        channel_id: z.string().describe('The channel ID where the message is'),
        message_id: z.string().describe('The message ID carrying the image'),
        filename: z.string().max(255).optional().describe('Which image to view when the message has more than one. Omit for the first.'),
      },
      endpoint: '/api/get-attachment-image',
    },
    {
      name: 'discord_timeout_user',
      description: 'Timeout (mute) a user in a server, for at most 28 days.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID'),
        user_id: z.string().describe('The user ID to timeout'),
        duration_minutes: z.number().describe('Timeout duration in minutes (max 40320 = 28 days)'),
        reason: z.string().optional().describe('Optional: Reason for the timeout'),
      },
      endpoint: '/api/timeout-user',
    },
    {
      name: 'discord_assign_role',
      description: 'Assign a role to a user.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID'),
        user_id: z.string().describe('The user ID'),
        role_id: z.string().describe('The role ID to assign'),
        reason: z.string().optional().describe('Optional: Reason for role assignment (audit log)'),
      },
      endpoint: '/api/assign-role',
    },
    {
      name: 'discord_remove_role',
      description: 'Remove a role from a user.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID'),
        user_id: z.string().describe('The user ID'),
        role_id: z.string().describe('The role ID to remove'),
        reason: z.string().optional().describe('Optional: Reason for role removal (audit log)'),
      },
      endpoint: '/api/remove-role',
    },
    {
      name: 'discord_create_role',
      description:
        'Create a new role. Permission names are Discord names like ManageMessages, not raw numbers. House of Solance only, and Administrator can never be granted through this tool.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID. Must be House of Solance'),
        name: z.string().describe('The new role name'),
        permissions: z.array(z.string()).optional().describe('Optional: Discord permission names to grant, e.g. ViewChannel, SendMessages, ManageMessages'),
        color: z.string().optional().describe('Optional: hex color, e.g. #5865F2'),
        hoist: z.boolean().optional().describe('Optional: show members with this role separately in the member list'),
        mentionable: z.boolean().optional().describe('Optional: allow anyone to @mention this role'),
        reason: z.string().optional().describe('Optional: Reason for creating the role, kept in the audit log'),
      },
      endpoint: '/api/create-role',
    },
    {
      name: 'discord_edit_role',
      description:
        'Edit an existing role: rename, recolor, or add/remove server-wide permissions. Permission names are Discord names like ManageMessages, not raw numbers. House of Solance only, and Administrator can never be granted through this tool.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID. Must be House of Solance'),
        role_id: z.string().describe('The role ID to edit'),
        name: z.string().optional().describe('Optional: new role name'),
        color: z.string().optional().describe('Optional: new hex color, e.g. #5865F2'),
        add: z.array(z.string()).optional().describe('Optional: Discord permission names to add, e.g. CreatePublicThreads'),
        remove: z.array(z.string()).optional().describe('Optional: Discord permission names to remove, e.g. ManageMessages'),
        hoist: z.boolean().optional().describe('Optional: show members with this role separately in the member list'),
        mentionable: z.boolean().optional().describe('Optional: allow anyone to @mention this role'),
        reason: z.string().optional().describe('Optional: Reason for editing the role, kept in the audit log'),
      },
      endpoint: '/api/edit-role',
    },
    {
      name: 'discord_set_channel_permission',
      description:
        'Set a role or member permission overwrite on a channel or category. Merges with the existing overwrite: allow grants a permission, deny blocks it, neutral clears it back to inherit, clear removes the whole overwrite. Permission names are Discord names like ManageMessages, ViewChannel, not raw numbers. House of Solance only, and Administrator can never be granted through this tool.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID. Must be House of Solance'),
        channel_id: z.string().describe('The channel or category ID'),
        target_id: z.string().describe('The role ID or member user ID this overwrite applies to'),
        target_type: z.enum(['role', 'member']).describe('Whether target_id is a role or a member'),
        allow: z.array(z.string()).optional().describe('Optional: Discord permission names to allow, e.g. ViewChannel'),
        deny: z.array(z.string()).optional().describe('Optional: Discord permission names to deny'),
        neutral: z.array(z.string()).optional().describe('Optional: Discord permission names to unset (back to inherit)'),
        clear: z.boolean().optional().describe('Optional: remove the whole overwrite for this target instead of editing it'),
        reason: z.string().optional().describe('Optional: Reason for the change, kept in the audit log'),
      },
      endpoint: '/api/set-channel-permission',
    },
    {
      name: 'discord_list_members',
      description: 'List members in a server.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID'),
        limit: z.number().optional().describe('Optional: Max members to return (default 100)'),
      },
      endpoint: '/api/list-members',
    },
    {
      name: 'discord_get_user_info',
      description: 'Get information about a Discord user in a server. The bot needs both server_id and user_id.',
      shape: {
        server_id: z.string().min(1).describe('The Discord server (guild) ID'),
        user_id: z.string().min(1).describe('The Discord user ID'),
      },
      endpoint: '/api/get-user-info',
    },
    {
      name: 'discord_find_message',
      description:
        "Find a message from its ID ALONE, when you don't know which channel it is in. Sweeps every channel and active thread the bot can see, skipping any created after the message. Returns the channel, author, content, attachments, embeds (when it has any) and a jump link. Use this when handed a bare message ID; use discord_search_messages when you know the channel and want to filter by author/keyword/date.",
      shape: {
        message_id: z.string().max(20).describe('The message ID to locate (17-20 digits)'),
        server_id: z
          .string()
          .max(20)
          .optional()
          .describe('Optional: restrict the sweep to one server. Omit to search every server the bot is in.'),
      },
      endpoint: '/api/find-message',
    },
    {
      name: 'discord_search_messages',
      description:
        'Search messages in a channel with filters for author, keyword, date range and attachments. Scans messages server-side and returns only the matches, saving tokens. At least one filter is required.',
      shape: {
        channel_id: z.string().describe('The Discord channel ID to search'),
        author_id: z.string().optional().describe("Filter by author's Discord user ID"),
        keyword: z.string().optional().describe('Case-insensitive text search in message content'),
        before: z.string().optional().describe('ISO timestamp — only messages before this date'),
        after: z.string().optional().describe('ISO timestamp — only messages after this date'),
        has_attachment: z.boolean().optional().describe('Filter for messages with (true) or without (false) attachments'),
        limit: z.number().optional().describe('Max results to return (default 20, max 50)'),
        scan_depth: z.number().optional().describe('Messages to scan internally (default 200, max 500)'),
      },
      endpoint: '/api/search-messages',
      check: (a) =>
        !a.author_id && !a.keyword && !a.before && !a.after && a.has_attachment === undefined
          ? 'At least one filter (author_id, keyword, before, after, has_attachment) is required alongside channel_id.'
          : null,
    },
    {
      name: 'discord_list_roles',
      description:
        'List server roles WITH their permissions — each role reports is_administrator, a named sensitive_permissions list (the ones granting power over the server or over other people), the raw permissions bitfield, whether it is a bot integration role (managed/bot_id), and how many members hold it. Use for permission audits. NOTE: a bot can hold admin through a SEPARATE manually-created role, so check every role a member holds, not just its own integration role.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID'),
      },
      endpoint: '/api/list-roles',
    },
    {
      name: 'discord_list_stickers',
      description:
        'List all custom stickers in a Discord server with their id, name, description, and tags. Use this to look up which sticker ID corresponds to a named sticker before sending one with discord_send_message.',
      shape: {
        server_id: z.string().describe('The Discord server (guild) ID'),
      },
      endpoint: '/api/list-stickers',
    },
    {
      name: 'discord_persona_read',
      description:
        'Read the bot persona: its name, who it is and how it talks, where it comes from (page, file or url) and whether it can be edited here. Also returns the text the bot is using right now.',
      shape: {},
      endpoint: '/api/persona-read',
    },
    {
      name: 'discord_persona_update',
      description:
        'Change the bot persona. Give any of text (who it is), name or voice (how it talks). Refused when the persona comes from a file or a url, because your own core owns it then. The change is recorded as made by the companion, with the old text, so the owner can see it and undo it.',
      shape: {
        text: z.string().optional().describe('Who the bot is (max 8000 characters)'),
        name: z.string().optional().describe('The bot name (max 80 characters)'),
        voice: z.string().optional().describe('How the bot talks (max 2000 characters)'),
      },
      endpoint: '/api/persona-update',
    },
    {
      name: 'discord_instructions_read',
      description: 'Read the extra instructions the owner has given the bot (the standing guidance added to every prompt).',
      shape: {},
      endpoint: '/api/instructions-read',
    },
    {
      name: 'discord_instructions_update',
      description:
        'Replace the extra instructions with new text. Send the full text you want kept; read the current text first to edit it. The change is recorded as made by the companion, with the old text, so the owner can see it and undo it.',
      shape: {
        text: z.string().describe('The full extra instructions (max 4000 characters)'),
      },
      endpoint: '/api/instructions-update',
    },
  ];
  return defs;
}

/** The body a runtime posts to the bot for a tool call. */
export function bodyFor(def: ToolDefinition, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const a = args ?? {};
  return def.toBody ? def.toBody(a) : a;
}
