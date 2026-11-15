# Tools

Back to the [README](../README.md).

53 tools in all.

| Tool | What it does |
|---|---|
| `discord_read_messages` | Read recent messages live from a channel, including their embeds |
| `discord_send_message` | Send a message, optionally as a reply, with up to 3 stickers, or with embeds |
| `discord_send_dm` | Send a direct message to a user |
| `discord_get_dm_channel` | Get the channel ID of a DM with a user |
| `discord_send_file` | Send a file to a channel |
| `discord_check_mentions` | Check pending mentions of the bot |
| `discord_check_dms` | Check pending direct messages to the bot |
| `discord_get_history` | Read the bot's stored memory of a channel, not live Discord |
| `discord_list_channels` | List all channels in a server |
| `discord_create_channel` | Create a channel |
| `discord_set_channel_topic` | Set a channel's topic |
| `discord_rename_channel` | Rename a channel |
| `discord_delete_channel` | Delete a channel. This cannot be undone |
| `discord_create_category` | Create a category |
| `discord_move_channel` | Move a channel to another category or position |
| `discord_add_reaction` | Add a reaction to a message |
| `discord_get_reactions` | List the reactions on a message and who left them |
| `discord_create_poll` | Create a native Discord poll |
| `discord_edit_message` | Edit the text or the embeds of a message the bot sent |
| `discord_delete_message` | Delete a message (the bot's own anywhere; other people's only in your home server, `homeServerId` in the file at `CONFIG_PATH`; none is set by default) |
| `discord_pin_message` | Pin a message |
| `discord_create_thread` | Create a thread, optionally from a message |
| `discord_create_forum_post` | Create a post in a forum channel |
| `discord_list_forum_threads` | List threads in a forum channel |
| `discord_fetch_attachment` | Get the attachments on a message |
| `discord_view_attachment` | See an image attached to a message |
| `discord_timeout_user` | Time a user out, for at most 28 days |
| `discord_assign_role` | Give a role to a user |
| `discord_remove_role` | Take a role from a user |
| `discord_create_role` | Create a role |
| `discord_edit_role` | Rename or recolor a role, or change its server-wide permissions |
| `discord_set_channel_permission` | Set a role or member permission overwrite on a channel or category |
| `discord_list_members` | List members of a server |
| `discord_get_user_info` | Get information about a user in a server |
| `discord_find_message` | Find a message from its ID alone |
| `discord_search_messages` | Search a channel by author, keyword, date or attachments |
| `discord_list_roles` | List roles with their permissions, for audits |
| `discord_list_stickers` | List a server's custom stickers |
| `discord_status_read` | Read the custom status line the bot shows while you are online |
| `discord_status_set` | Set that status line (up to 128 characters; empty means no status) |
| `discord_profile_read` | Read the bot's display picture and banner links, for the account or one server |
| `discord_profile_set` | Change the bot's display picture, banner or per-server bio from base64 or, if `PROFILE_FILES_DIR` is set, a file in that folder |
| `discord_persona_read` | Read the bot's persona and where it comes from |
| `discord_persona_update` | Change the bot's persona, when it is editable here |
| `discord_instructions_read` | Read the owner's extra instructions for the bot |
| `discord_instructions_update` | Replace the owner's extra instructions |
| `discord_list_servers` | List the servers the bot is in, or describe one in full |
| `discord_unpin_message` | Unpin a message |
| `discord_list_pins` | List a channel's pinned messages, embeds included |
| `discord_remove_reaction` | Remove the bot's own reaction from a message |
| `discord_read_audit_log` | Read a server's audit log: who did what, when, to whom and why. Home server only |
| `discord_edit_thread` | Rename, archive, unarchive or lock a thread, or change its auto-archive time. Locking is home server only |
| `discord_thread_member` | Add a user to a thread or remove one. Home server only |
