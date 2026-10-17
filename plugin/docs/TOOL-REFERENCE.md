# Discord MCP tool reference

This reference is derived from an exact name diff of `TOOLS.json` and `CLOUD_TOOLS.json`.

| Inventory result | Count |
| --- | ---: |
| Shared | 34 |
| Local-only | 0 |
| Cloud-only | 1 |

Availability labels describe tool-name presence. A shared tool can still return different transport-appropriate results, especially for attachments.

## Messages

| Tool | Availability | Purpose |
| --- | --- | --- |
| `discord_read_messages` | Shared | Read recent live messages from a channel. Use for current Discord contents. |
| `discord_send_message` | Shared | Send a channel message and, where supported, reply to a message or send a server sticker. |
| `discord_edit_message` | Shared | Edit a message sent by the bot. |
| `discord_delete_message` | Shared | Delete a message from a channel. |
| `discord_pin_message` | Shared | Pin a message in a channel. |
| `discord_get_history` | Shared | Read conversation memory stored by the bot. This is not live channel history. |
| `discord_find_message` | Shared | Find a message from a bare message ID when its channel is unknown. Searches visible channels and active threads. |
| `discord_search_messages` | Shared | Search within a known channel. The cloud description supports author, keyword, date-range, and attachment filters and requires at least one filter. |

## Direct messages

| Tool | Availability | Purpose |
| --- | --- | --- |
| `discord_send_dm` | Shared | Send a direct message to a user. |
| `discord_get_dm_channel` | Shared | Get or find the direct-message channel for a user. Use the returned channel ID for reads. |

## Attachments

| Tool | Availability | Purpose |
| --- | --- | --- |
| `discord_send_file` | Shared | Send a file to a channel. Local mode can use files visible to the local bot process; cloud mode requires a file visible to the remote bot host. |
| `discord_fetch_attachment` | Shared | Resolve a message attachment. Local mode downloads it to the local filesystem; cloud mode returns fresh CDN URLs. |
| `discord_view_attachment` | **Cloud-only** | Return one attached image directly. If a message has several images, select one by filename in a later call. |
| `discord_list_stickers` | Shared | List custom server stickers and their available metadata. Use it to resolve a sticker ID before sending. |

## Reactions

| Tool | Availability | Purpose |
| --- | --- | --- |
| `discord_add_reaction` | Shared | Add a reaction to a message. |
| `discord_get_reactions` | Shared | Get reactions on a message. The cloud description also returns the users who reacted. |

## Polls

| Tool | Availability | Purpose |
| --- | --- | --- |
| `discord_create_poll` | Shared | Create a native poll in a channel. |

## Threads

| Tool | Availability | Purpose |
| --- | --- | --- |
| `discord_create_thread` | Shared | Create a thread in a text channel, optionally from an existing message where supported. |

## Forums

| Tool | Availability | Purpose |
| --- | --- | --- |
| `discord_create_forum_post` | Shared | Create a post in a forum channel. |
| `discord_list_forum_threads` | Shared | List threads in a forum channel. |

## Channels

| Tool | Availability | Purpose |
| --- | --- | --- |
| `discord_list_channels` | Shared | List channels in a server. |
| `discord_create_channel` | Shared | Create a channel in a server. |
| `discord_set_channel_topic` | Shared | Set a channel topic or description. |
| `discord_rename_channel` | Shared | Rename a channel. |
| `discord_delete_channel` | Shared | Delete a channel. This operation is irreversible. |
| `discord_move_channel` | Shared | Move a channel to a category. |

## Categories

| Tool | Availability | Purpose |
| --- | --- | --- |
| `discord_create_category` | Shared | Create a category in a server. |

## Moderation and directory

| Tool | Availability | Purpose |
| --- | --- | --- |
| `discord_timeout_user` | Shared | Timeout or mute a user. The cloud description specifies a maximum of 28 days. |
| `discord_assign_role` | Shared | Assign a role to a user. |
| `discord_remove_role` | Shared | Remove a role from a user. |
| `discord_list_members` | Shared | List members in a server. |
| `discord_get_user_info` | Shared | Get information about a Discord user. |
| `discord_list_roles` | Shared | List roles in a server. |

## Awareness

| Tool | Availability | Purpose |
| --- | --- | --- |
| `discord_check_mentions` | Shared | Check pending or recent mentions of the bot. |
| `discord_check_dms` | Shared | Check pending or incoming direct messages to the bot. |

## Choosing among read, history, find, and search

| Need | Tool |
| --- | --- |
| Current contents of a known channel | `discord_read_messages` |
| Bot-stored conversation memory | `discord_get_history` |
| A bare message ID with unknown channel | `discord_find_message` |
| Filtered messages in a known channel | `discord_search_messages` |
