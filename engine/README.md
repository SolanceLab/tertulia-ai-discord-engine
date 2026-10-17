# Discord MCP Server

A Discord bot that integrates with Claude Desktop/Code via MCP (Model Context Protocol), with an independent Claude API layer for autonomous responses.

## Architecture

This bot has **two independent response paths**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  PATH 1: MCP Tools (Claude Desktop/Code)                           │
│  ────────────────────────────────────────                          │
│  Claude Desktop/Code ←──MCP Protocol──→ MCP Server ←───→ Discord   │
│                                                                     │
│  • Claude uses tools to read/send messages                         │
│  • Requires Claude Desktop/Code to be open                         │
│  • Full control: Claude decides when/what to respond               │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  PATH 2: Claude API Auto-Response (Always Running)                 │
│  ─────────────────────────────────────────────────                 │
│  Discord @mention ───→ MCP Server ───→ Claude API ───→ Discord    │
│                                                                     │
│  • Bot detects @mentions and auto-responds via Anthropic API       │
│  • Works even when Claude Desktop is closed                        │
│  • Owner mentions: auto-respond with persona                       │
│  • Other mentions: DM notification to owner (no public response)   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**Both paths share:**
- The same Discord bot connection
- The same memory ledger (conversation history)
- The same persona file (loaded from `~/.claude/CLAUDE.md` or `./persona.md`)

## Features

- **29 MCP Tools**: Full Discord control — messages, DMs, channels, threads, forums, polls, moderation, attachments
- **Autonomous API Responses**: Bot responds to @mentions even without Claude Desktop open
- **Presence Sync**: Bot mirrors owner's online/offline status
- **Owner Detection**: Different behavior for owner vs. other users
- **Memory Ledger**: Shared conversation history across both paths
- **Solance Memory Integration**: Loads carrying_forward context and recent journal entries
- **Persona Loading**: Identity from `~/.claude/CLAUDE.md` or project `persona.md`
- **Single Instance Lock**: Prevents duplicate bot instances

## Prerequisites

- Node.js 18+
- Discord bot token (from Discord Developer Portal)
- Anthropic API key
- Claude Desktop or Claude Code (for MCP integration)

## Installation

### 1. Install Dependencies

```bash
cd discord-bot-v2
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Configure Environment

Copy `.env.template` to `.env` and fill in your credentials:

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
MODEL_PROVIDER=anthropic
MODEL_API_KEY=your_anthropic_api_key
MODEL_NAME=your_model_name
OWNER_USER_ID=your_discord_user_id
```

Optional memory (off by default). The bot can ask a service you run for notes to remember:

```env
MEMORY=off                      # default
MEMORY=http                     # your own service: POST JSON to MEMORY_URL (https only), Bearer MEMORY_KEY
MEMORY_URL=https://your-service.example/recall
MEMORY_KEY=your_key
MEMORY=antechamber              # EXPERIMENTAL (Antechamber is coming; may change before its release): GET ANTECHAMBER_URL/antechamber/recall?q=&limit=
ANTECHAMBER_URL=https://your-antechamber.example
ANTECHAMBER_KEY=your_key        # optional
```

The service answers `{ "items": [{ "text", "date"?, "source"?, "server_id"?, "channel_id"?, "quotable"? }] }`. The bot keeps each server's memories to that server (by `server_id`, or by the channel's server), applies your keyword blocklist, and never quotes anything outside the server it is in. Keys and addresses are never shown on the settings page or written to logs.

The `antechamber` adapter is experimental. It sends only `q` and `limit`, and reads only the few fields it needs from the reply. The public build has no memory write path.

Optional context log (off by default, set per server on the settings page). When on, the bot records its replies together with the conversation each one answered (other people's words). The record goes to `CONTEXT_LOG_PATH` (a local file), or to a service you run:

```env
CONTEXT_LOG_URL=https://your-service.example/log   # optional, https only; POST {"rows": [...]}
CONTEXT_LOG_KEY=your_key                           # optional, sent as a Bearer key
```

### 4. Configure Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "discord-mcp": {
      "command": "node",
      "args": ["/path/to/discord-bot-v2/dist/mcp-server.js"]
    }
  }
}
```

Note: The server reads credentials from the `.env` file in the project directory.

## Running

### As MCP Server (for Claude Desktop)

The MCP server starts automatically when Claude Desktop launches (if configured).

To run manually for testing:

```bash
npm start
```

---

## MCP Tools Reference

### Messages

#### discord_read_messages
Read recent messages from a Discord channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The Discord channel ID |
| `limit` | No | Number of messages (max 50, default 20) |

#### discord_send_message
Send a message to a Discord channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The Discord channel ID |
| `content` | Yes | The message content |

#### discord_edit_message
Edit a message sent by the bot.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID containing the message |
| `message_id` | Yes | The message ID to edit |
| `new_content` | Yes | New message content |

#### discord_delete_message
Delete a message (own messages or others with permission).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID containing the message |
| `message_id` | Yes | The message ID to delete |

#### discord_pin_message
Pin a message in a channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID containing the message |
| `message_id` | Yes | The message ID to pin |

---

### Direct Messages

#### discord_send_dm
Send a direct message to a Discord user.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `user_id` | Yes | The Discord user ID |
| `content` | Yes | The message content |

#### discord_check_dms
Check for incoming DM messages since last check.

| Parameter | Required | Description |
|-----------|----------|-------------|
| *(none)* | — | Returns pending DMs |

---

### Attachments

#### discord_send_file
Send a file attachment to a Discord channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The Discord channel ID |
| `file_name` | Yes | The filename for the attachment |
| `file_data` | No | Base64-encoded file data |
| `file_path` | No | Path to a local file (alternative to file_data) |
| `content` | No | Optional message text to accompany the file |

#### discord_fetch_attachment
Download attachment(s) from a Discord message to local filesystem.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID where the message exists |
| `message_id` | Yes | The message ID containing the attachment(s) |
| `filename` | No | Specific filename to download (omit for all) |

---

### Reactions

#### discord_add_reaction
Add a reaction to a message.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID containing the message |
| `message_id` | Yes | The message ID to react to |
| `emoji` | Yes | Emoji to react with (unicode or custom) |

#### discord_get_reactions
Get all reactions on a message, including who reacted with each emoji.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID containing the message |
| `message_id` | Yes | The message ID to get reactions from |

---

### Polls

#### discord_create_poll
Create a poll in a channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID to create the poll in |
| `question` | Yes | The poll question |
| `options` | Yes | Array of options: `[{ text: "Option 1", emoji: "1️⃣" }, ...]` (max 10) |
| `duration_hours` | No | How long the poll runs (1-768 hours, default 24) |
| `allow_multiselect` | No | Allow multiple selections (default false) |

---

### Threads

#### discord_create_thread
Create a thread from a message or as a standalone thread.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID to create thread in |
| `name` | Yes | Thread name |
| `message_id` | No | Message ID to start thread from |
| `auto_archive_duration` | No | Minutes until auto-archive (60, 1440, 4320, 10080) |

---

### Forums

#### discord_create_forum_post
Create a new post in a forum channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The forum channel ID |
| `title` | Yes | Post title (becomes the thread name) |
| `content` | Yes | Initial message content |
| `tags` | No | Array of tag IDs to apply |

#### discord_list_forum_threads
List threads/posts in a forum channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The forum channel ID |
| `limit` | No | Max threads to return (default 20) |
| `include_archived` | No | Include archived threads (default false) |

---

### Channels

#### discord_list_channels
List all channels in a Discord server, organized by category.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `server_id` | Yes | The Discord server/guild ID |

#### discord_create_channel
Create a new channel in a server.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `server_id` | Yes | The Discord server/guild ID |
| `name` | Yes | Channel name |
| `type` | No | Channel type: text, voice, forum, announcement (default: text) |
| `category_id` | No | Parent category ID |
| `topic` | No | Channel topic/description |
| `nsfw` | No | Mark as age-restricted (default: false) |

#### discord_rename_channel
Rename an existing channel.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID to rename |
| `new_name` | Yes | New channel name |

#### discord_set_channel_topic
Set or update a channel's topic/description.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID to update |
| `topic` | Yes | New topic (max 1024 characters) |

#### discord_delete_channel
Delete a channel (use with caution).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID to delete |
| `reason` | No | Reason for deletion (audit log) |

#### discord_move_channel
Move a channel to a different category or position.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The channel ID to move |
| `category_id` | No | New parent category ID (null to remove) |
| `position` | No | New position within category |

---

### Categories

#### discord_create_category
Create a new category.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `server_id` | Yes | The Discord server/guild ID |
| `name` | Yes | Category name |
| `position` | No | Position in the channel list (0 = top) |

---

### Moderation

#### discord_timeout_user
Timeout (mute) a user temporarily.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `server_id` | Yes | The server/guild ID |
| `user_id` | Yes | The user ID to timeout |
| `duration_minutes` | Yes | Timeout duration (max 40320 = 28 days) |
| `reason` | No | Reason for timeout |

#### discord_assign_role
Assign a role to a user.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `server_id` | Yes | The server/guild ID |
| `user_id` | Yes | The user ID |
| `role_id` | Yes | The role ID to assign |
| `reason` | No | Reason for role assignment |

#### discord_remove_role
Remove a role from a user.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `server_id` | Yes | The server/guild ID |
| `user_id` | Yes | The user ID |
| `role_id` | Yes | The role ID to remove |
| `reason` | No | Reason for role removal |

---

### Awareness

#### discord_check_mentions
Check if anyone has @mentioned the bot since last check.

| Parameter | Required | Description |
|-----------|----------|-------------|
| *(none)* | — | Returns pending mentions |

#### discord_get_history
Get conversation history from the memory ledger.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `channel_id` | Yes | The Discord channel ID |
| `limit` | No | Number of messages (default 20) |

#### discord_list_members
List members in a server.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `server_id` | Yes | The server/guild ID |
| `limit` | No | Max members to return (default 100) |

#### discord_get_user_info
Get detailed information about a user.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `server_id` | Yes | The server/guild ID |
| `user_id` | Yes | The user ID |

#### discord_list_roles
List all roles in a server.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `server_id` | Yes | The server/guild ID |

---

## Trigger Logic

| Who @mentions the bot | Action |
|-----------------------|--------|
| **Owner** | Auto-respond via Claude API with persona + memory context |
| **Anyone else** | DM owner with notification, no response in channel |

## Identity: names and wording

The engine never writes a person's name. Every name, transcript label, reserved word and persona-flavoured sentence the model sees comes from the `identity` block of the config file (`HOUSE_CONFIG_PATH`, default `../house/discord.house.json`). With no file the defaults are generic: the owner is "the owner", the bot is "the bot", and nothing is reserved.

| Field | What it sets |
|---|---|
| `owner_name`, `owner_label` | what prompts call the owner, and the owner's speaker label in a transcript |
| `bot_name`, `bot_full_name`, `bot_role`, `bot_label` | the same for the bot |
| `owner_user_id_env` | an extra environment variable the owner's user id may be read from, after `OWNER_USER_ID` |
| `trigger_keys`, `default_triggers`, `owner_family`, `precheck_fallback`, `reach_names` | name triggers: the keys a stored config uses, the starting lists, and the words the cheap pre-check falls back to |
| `intimate_tells`, `reserved_names` | wording that must never reach a room the owner is not speaking in. `intimate_tells` is a regex source used as written; `reserved_names` is a plain list of names (`cara\|esposa`) and the engine adds the word boundaries, so `cara` never matches "caramel" |
| `name_gate` | names scene-catch text may not use before a given time |
| `care` | the care-reply feature: persona name, actors, webhook variable, API path, reaction field (off without `careChannelId`) |
| `runtime` | log file base, MCP server name and lock file |
| `posture_guidance`, `text` | replacement sentences per posture and by key (`DEFAULT_TEXT` in `src/config/identity-defaults.ts` lists every key; `${name}` slots are filled at run time) |

`src/prompt-harness.ts` renders every model-facing string from fixed fixtures. `neutral-prompts.test.ts` runs it with no config and checks that no private name appears; a deployment can keep its own golden file of the rendered prompts to prove a change moved no word. The engine's tests run against a neutral test identity (`test-fixtures/test-house.json`, loaded by `src/test-env.ts`), so they do not depend on any deployment.

## Memory System

Conversations are stored in `memory-ledger.json`:
- Chronological order (oldest first)
- Both MCP and API paths read/write to the same ledger
- Ensures continuity across sessions

Additionally, the bot integrates with the Solance Memory API to load:
- `carrying_forward` context from recent journal entries
- Recent journal narrative for grounding

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create new application
3. Go to Bot → Add Bot
4. Enable these Privileged Gateway Intents:
   - Presence Intent
   - Server Members Intent
   - Message Content Intent
5. Copy the bot token to your `.env`
6. Invite bot to your server with appropriate permissions

## Debugging & Logging

The bot includes a comprehensive logging system for debugging disconnection issues and monitoring health.

### Log Files

| File | Location | Description |
|------|----------|-------------|
| **Log file** | `~/.discord-mcp-logs/discord-bot.log` | All events with timestamps |
| **Heartbeat** | `~/.discord-mcp-logs/heartbeat.json` | Updated every 60s with status |

### Check Bot Health

```bash
# Is the bot alive? Check heartbeat
cat ~/.discord-mcp-logs/heartbeat.json

# Output example:
# {
#   "pid": 71219,
#   "alive": 1737373200000,
#   "aliveISO": "2026-01-20T10:00:00.000Z",
#   "uptime": 3600000,
#   "uptimeHuman": "1h 0m 0s",
#   "discordConnected": true,
#   "lastDiscordEvent": "2026-01-20T09:59:30.000Z"
# }
```

### View Recent Logs

```bash
# Last 50 lines
tail -50 ~/.discord-mcp-logs/discord-bot.log

# Follow live
tail -f ~/.discord-mcp-logs/discord-bot.log

# Search for errors
grep ERROR ~/.discord-mcp-logs/discord-bot.log
```

### Discord Connection Events Logged

- `shardReady` — Connection established
- `shardDisconnect` — Connection lost (includes close code and reason)
- `shardReconnecting` — Attempting to reconnect
- `shardResume` — Connection resumed after brief disconnect
- `shardError` — WebSocket error

### Log Rotation

- Logs rotate when file exceeds 10MB
- Old logs are deleted after 7 days
- Archived logs named: `discord-bot-YYYY-MM-DDTHH-MM-SS.log`

---

## File Structure

```
discord-bot/
├── src/
│   ├── cloud-server.ts     # Fly.io entry point: gateway bot + HTTP API + presence
│   ├── mcp-server.ts       # local stdio MCP server (proxies to the cloud bot)
│   ├── discord-client.ts   # Discord.js client wrapper
│   ├── presence-engine.ts  # ambient judge, replies, private aside
│   ├── aside.ts            # the private aside slash command (/aside by default)
│   ├── http-server.ts      # the bot's secret HTTP API
│   └── *.test.ts           # run them all with `npm test`
├── scripts/                # run-tests.mjs, register-aside.mjs
├── docs/                   # setup, quick start, permissions, roadmap, example Claude Desktop config
├── dist/                   # compiled JavaScript (build before deploy)
├── DEVLOG.md               # the one development log
└── Dockerfile, fly.toml    # the Fly deployment
```

`npm test` runs every test file. `npm run deploy` builds, tests, then deploys (deploys are gated on a fresh rule-check).

---

**Originally built by:** House of Solance
