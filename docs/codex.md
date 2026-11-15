# Use in Codex

Back to the [README](../README.md).

The plugin works in Codex as well as Claude Code. Install it from the SolanceLab store:

```
codex plugin marketplace add SolanceLab/plugins
codex plugin add tertulia-ai-discord-engine@solancelab
```

This brings the Discord usage skill and a connection entry that points at a tools server on this computer (`http://127.0.0.1:8787/mcp`, where `wrangler dev` in `mcp/worker` listens). If your tools server runs somewhere else (the Worker you deployed, ending in `/mcp`), give Codex that address one of two ways:

1. Add the server yourself (this survives plugin updates): `codex mcp add discord --url https://your-worker.example/mcp --bearer-token-env-var DISCORD_MCP_KEY`. The plugin's own `discord-cloud` entry still loads and simply finds nothing at the local address, which does no harm. Or
2. Edit the plugin's `codex.mcp.json` in your Codex plugin folder and replace `http://127.0.0.1:8787/mcp` with your address. A plugin update puts the local address back, so repeat the edit after updating.

Either way, put the key in your shell, never in a file: `read -rs DISCORD_MCP_KEY && export DISCORD_MCP_KEY` (it asks without echoing), then start a new Codex session and ask it to read the bot's status.
