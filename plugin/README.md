# Discord MCP plugin

This Claude Code plugin packages a technical skill and a local stdio MCP configuration for a Discord bot. The same bot is also available as a remote Streamable HTTP MCP server for clients such as ChatGPT.

The checked-in configuration contains placeholders only. Replace them locally before use and never publish a configured copy containing credentials.

## Connection modes

| Capability | Local stdio | Remote Streamable HTTP |
| --- | --- | --- |
| Transport | Child process over stdio | HTTPS request to `/mcp` |
| Typical clients | Claude Code, Claude Desktop | ChatGPT and remote-MCP clients |
| Tool inventory | 34 tools | 35 tools |
| Read and write Discord data | Yes | Yes |
| Read a file from the client machine | Yes, through the local bot process | No |
| Send an attachment | From a path visible to the local bot | Only from a path visible to the remote bot host |
| Fetch an attachment | Can download to the local filesystem | Returns fresh attachment URLs |
| View an attached image directly | Through the downloaded local file | Yes, with the cloud-only `discord_view_attachment` tool |
| Authentication | Environment supplied to the process | Bearer header or key in the `/mcp/<key>` path |

Remote attachment support does not grant access to the client filesystem. A remote server can only access files and URLs available in its own environment.

## 30-second quickstart

1. Open [`docs/mcp.local-example.json`](docs/mcp.local-example.json), replace `<ABSOLUTE_PATH_TO_BOT>`, and export `BOT_API_SECRET` in the environment that launches Claude Code.
2. Validate the package:

   ```sh
   claude plugin validate <ABSOLUTE_PATH_TO_PLUGIN> --strict
   ```

3. Start Claude Code with the local plugin:

   ```sh
   claude --plugin-dir <ABSOLUTE_PATH_TO_PLUGIN>
   ```

4. Run `/mcp` and confirm the `discord` server is connected.

See [Install for Claude Code](docs/INSTALL-CLAUDE-CODE.md), [Install for ChatGPT](docs/INSTALL-CHATGPT.md), and the [tool reference](docs/TOOL-REFERENCE.md).

## Safety

Treat the server as a privileged integration. Review the destination and content before writes, use the narrowest permissions available, and keep secrets out of prompts, logs, screenshots, and version control.
