# Discord MCP Server — Cloud

Remote MCP server on Cloudflare Workers that connects your Discord bot to Claude mobile, desktop, and web. Exposes 26 Discord tools via Streamable HTTP transport.

Cloud companion to [discord-mcp-bot](https://github.com/SolanceLab/discord-mcp-bot) (the Fly.io bot with HTTP API).

## Architecture

```
Claude (mobile/web/desktop)
    │
    │  MCP Streamable HTTP
    ▼
Cloudflare Worker (this repo)
    │
    │  HTTP API calls
    ▼
Fly.io Bot (discord-mcp-bot)
    │
    │  Discord.js WebSocket
    ▼
Discord
```

The Worker is a thin MCP protocol adapter. All Discord logic lives in the Fly.io bot — this just forwards tool calls.

## Tools (26)

### Messages (5)
`discord_read_messages` · `discord_send_message` · `discord_edit_message` · `discord_delete_message` · `discord_pin_message`

### Direct Messages (2)
`discord_send_dm` · `discord_check_dms`

### Attachments (2)
`discord_send_file` · `discord_fetch_attachment`

### Reactions (2)
`discord_add_reaction` · `discord_get_reactions`

### Polls (1)
`discord_create_poll`

### Threads (1)
`discord_create_thread`

### Forums (2)
`discord_create_forum_post` · `discord_list_forum_threads`

### Channels (6)
`discord_list_channels` · `discord_create_channel` · `discord_rename_channel` · `discord_set_channel_topic` · `discord_delete_channel` · `discord_move_channel`

### Categories (1)
`discord_create_category`

### Moderation (3)
`discord_timeout_user` · `discord_assign_role` · `discord_remove_role`

### Awareness (5)
`discord_check_mentions` · `discord_get_history` · `discord_list_members` · `discord_get_user_info` · `discord_list_roles`

## Prerequisites

- Node.js 18+
- Cloudflare account (free tier works)
- Wrangler CLI: `npm install -g wrangler`
- Running [discord-mcp-bot](https://github.com/SolanceLab/discord-mcp-bot) on Fly.io (or any server with the HTTP API)

## Setup

### 1. Clone and install

```bash
git clone https://github.com/SolanceLab/discord-mcp-cloud.git
cd discord-mcp-cloud
npm install
```

### 2. Set secrets

```bash
# Your chosen API key for authenticating to this Worker
npx wrangler secret put API_KEY

# Your Fly.io bot URL (e.g., https://your-bot.fly.dev)
npx wrangler secret put BOT_API_URL

# The BOT_API_SECRET from your Fly.io bot
npx wrangler secret put BOT_API_SECRET
```

### 3. Deploy

```bash
npx wrangler deploy
```

### 4. Connect Claude

Add the deployed URL as a remote MCP server in your Claude settings:

- **URL:** `https://discord-mcp-cloud.<your-account>.workers.dev/mcp`
- **Auth header:** `Authorization: Bearer <your-api-key>`

Or use the URL-based auth:
- **URL:** `https://discord-mcp-cloud.<your-account>.workers.dev/mcp/<your-api-key>`

## Local Development

Create `.dev.vars` with your secrets:

```
API_KEY=your_dev_key
BOT_API_URL=https://your-bot.fly.dev
BOT_API_SECRET=your_bot_secret
```

Run the dev server:

```bash
npm run dev
```

Test with curl:

```bash
curl -X POST http://localhost:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-api-key>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## How It Works

1. Claude sends MCP tool calls to the Worker
2. Worker authenticates the request (API key)
3. Worker creates a stateless MCP server for this request
4. Tool handler calls the Fly.io bot's HTTP API
5. Response flows back through MCP protocol to Claude

The Worker is stateless — each request creates a fresh MCP server. This works because all state lives in the Fly.io bot (Discord connection, memory ledger, etc.).

## Disclaimer

This software is provided **as-is, without warranty or guarantee of any kind**. Use at your own risk.

See [LICENSE](LICENSE) for full terms.

## Support

If you find this useful, support us on Ko-fi:

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/houseofsolance)

## Authors

Built by [House of Solance](https://ko-fi.com/houseofsolance).
