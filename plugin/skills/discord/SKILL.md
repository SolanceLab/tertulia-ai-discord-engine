---
name: discord
description: Use Discord MCP tools for bounded message reads, searches, sends, direct messages, attachments, reactions, polls, threads, forums, channel administration, moderation, and awareness checks. Apply when an agent must choose or sequence the packaged Discord tools safely and efficiently.
---

# Use Discord MCP tools

## Choose the right retrieval tool

- Use `discord_read_messages` to read current live contents from a known channel.
- Use `discord_get_history` only for the bot's stored conversation memory. Do not treat it as live Discord history.
- Use `discord_find_message` when given a message ID but not its channel.
- Use `discord_search_messages` when the channel is known and filtering by author, keyword, date, or attachments is useful. Supply at least one filter when the server requires it.
- Use `discord_get_dm_channel` before `discord_read_messages` when a direct-message channel ID is not known.

Start with the smallest useful result limit. Follow server-provided pagination or cursors, and request another page only when the first page does not answer the task. Do not assume a result set is complete when a limit, cursor, or continuation value is present.

## Compose messages correctly

- Keep each Discord message at or below 2000 characters. Split longer content into coherent parts.
- Mention a user with `<@user_id>`.
- Mention a role with `<@&role_id>`.
- Use IDs returned by list or lookup tools. Do not guess IDs.
- Verify the destination channel, thread, forum, or user before sending.
- Prefer a reply when the message should remain attached to existing context.

## Handle attachments by transport

- Use the local stdio server when a task must read from or write to the client filesystem.
- Use `discord_fetch_attachment` locally to download an attachment to a local path.
- In cloud mode, treat `discord_fetch_attachment` as URL retrieval rather than a local download.
- Use cloud-only `discord_view_attachment` to inspect one attached image directly. Select by filename when a message contains several images.
- Use `discord_send_file` only with a path visible to the server process. A path on the client machine is not visible to the remote server.

## Sequence operations conservatively

1. Resolve the target with a read, list, or lookup tool.
2. Confirm IDs and current state from tool output.
3. Perform the narrowest requested action.
4. Verify consequential writes with a bounded read when appropriate.

Treat channel deletion, message deletion, moderation, and role changes as consequential. Do not infer authorization from a read request. Avoid bulk operations unless the request explicitly defines the scope.

## Work within limits

- Respect tool result limits and Discord rate limits.
- Paginate incrementally rather than requesting broad history by default.
- Narrow searches with known authors, dates, keywords, or attachment filters.
- If a tool description does not establish a behavior, use it conservatively and inspect the returned shape before relying on optional fields.
- Never place credentials in messages, tool arguments, logs, or generated documentation.
