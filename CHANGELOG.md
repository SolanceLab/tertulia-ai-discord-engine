# Changelog

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
