# Install for Claude Code

Claude Code can load this directory directly for development, install it through a marketplace for persistent distribution, or connect the MCP server without the plugin wrapper.

## Before installation

1. Build the Discord bot so `<ABSOLUTE_PATH_TO_BOT>/dist/mcp-server.js` exists.
2. Edit `docs/mcp.local-example.json` (copy it into your own MCP config) and replace `<ABSOLUTE_PATH_TO_BOT>` with the local absolute path.
3. Export `BOT_API_SECRET` in the environment that launches Claude Code. The `${BOT_API_SECRET}` entry passes that runtime value to the child process. Do not put the secret itself in this file.
4. Validate the plugin:

   ```sh
   claude plugin validate <ABSOLUTE_PATH_TO_PLUGIN> --strict
   ```

## Load the plugin directory

For an immediate local session:

```sh
claude --plugin-dir <ABSOLUTE_PATH_TO_PLUGIN>
```

The manifest connects to the cloud Discord MCP over HTTP and asks for its address and key at install (`userConfig.server_url`, `userConfig.api_key`). For the local stdio server instead, copy the block from `docs/mcp.local-example.json` into your own MCP config.

## Install from a marketplace

This directory is a plugin package, not a marketplace catalog. If it is distributed through a marketplace, add that catalog and install the package:

```text
/plugin marketplace add <MARKETPLACE_SOURCE>
/plugin install discord@<MARKETPLACE_NAME>
```

Choose user, project, or local scope in the plugin interface according to who should receive the plugin. If Claude Code asks for a reload, run:

```text
/reload-plugins
```

Do not put secrets into a shared marketplace artifact. Supply `BOT_API_SECRET` in the environment that launches Claude Code. The plugin configuration resolves it at runtime.

## Add only the MCP server

To skip plugin loading and register the stdio server directly for the current user:

```sh
claude mcp add-json --scope user discord '{"type":"stdio","command":"node","args":["<ABSOLUTE_PATH_TO_BOT>/dist/mcp-server.js"],"env":{"BOT_API_SECRET":"${BOT_API_SECRET}"}}'
```

Use `--scope local` instead when the server should apply only to the current project. Direct registration loads the MCP tools but does not install the bundled skill.

## Verify

In Claude Code:

1. Run `/plugin` or `claude plugin list` and confirm the plugin is enabled when using the plugin route.
2. Run `/mcp` and confirm the server is connected.
3. Ask Claude to list available Discord tools or make a harmless bounded read request.
4. If the server is absent, launch `claude --debug` and inspect MCP initialization errors.

Common failures are an unreplaced placeholder, a missing bot build, `node` not being on `PATH`, or an environment variable not matching what the bot expects.
