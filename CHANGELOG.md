# Changelog

## 1.3.0

- Reply as the bot: a right-click command on any message (Apps, then "Reply as" and your bot's name). It works in servers the bot is not in. You get a private draft in the public voice with Post to channel and Discard; Post sends a public reply from the app that quotes the message, links back to it and pings nobody. Owner only. Register it with `node scripts/register-aside.mjs --reply`.
- The private aside's Post to channel button now works in servers the bot is not in: when the bot cannot send in the channel (not a member, Missing Access or Unknown Channel), Post publishes through the button itself as a public follow-up that pings nobody, and tells you if the server only shows it to you. Where the bot is a member it still posts from the bot. Every Post and Discard click is acknowledged at once, logs one line, and a failure edits the draft with a plain "Couldn't post here" reason.
- The command's name is `reply_command` in the identity block of the house config file (default "Reply as" and the bot's name).

## 1.2.0

Seven new tools (49 in all).

- `discord_list_servers`: the servers the bot is in (id, name, member count, icon, whether it is the home server). Give `server_id` for one server in full: description, owner, creation date, features and the bot's own roles.
- `discord_unpin_message`, `discord_list_pins` and `discord_remove_reaction`. `discord_list_pins` returns pinned messages in the same shape as `discord_read_messages`, embeds included. `discord_remove_reaction` removes only the bot's own reaction.
- `discord_read_audit_log`: who did what, when, to which target and why, with an optional action name, user and limit (up to 50). Home server only; with no home server set (`hosServerId` in the file at `HOUSE_CONFIG_PATH`) it refuses. Audit entries are not for public channels.
- `discord_edit_thread` (rename, archive, lock, auto-archive time) and `discord_thread_member` (add or remove a member). Rename and archive work on threads the bot created anywhere and on any thread in the home server. Locking and member changes are home server only.
- Refusals from these tools say why (guard or bad argument) instead of a generic failure. Nothing here grants Administrator or touches roles.

## 1.1.0

- Embeds can be read: `discord_read_messages` and `discord_find_message` return each message's `embeds` (title, description, url, color, fields, footer, author, image_url, thumbnail_url, timestamp).
- `discord_send_message` accepts `embeds`; content is then optional.
- `discord_edit_message` accepts `embeds` (replaces the old ones, `[]` removes them); `new_content` is now optional, but one of the two is required.
- Embeds are checked before Discord is called (10 per message, title 256, description 4096, 25 fields, 6000 characters in all, http or https links only) and a failure says which limit was hit. Every embed needs at least one visible part, and field names and values cannot be empty.
- `discord_delete_message` deletes other people's messages only in your home server (`hosServerId` in the file at `HOUSE_CONFIG_PATH`); everywhere else, and whenever no home server is set (the default), only the bot's own.

## 1.0.1

- The repo is its own plugin source: `claude plugin marketplace add SolanceLab/tertulia-ai-discord-engine`, then `claude plugin install discord@tertulia`.
- The plugin's setup text points to `mcp/worker`.

## 1.0.0

First public release.
