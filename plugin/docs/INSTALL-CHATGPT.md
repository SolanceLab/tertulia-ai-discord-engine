# Connect the remote MCP server to ChatGPT

ChatGPT connects to the remote Streamable HTTP server. It does not launch the local stdio process and cannot directly access files on the client machine.

ChatGPT custom MCP apps require developer mode and plan or workspace access that supports custom apps. Full MCP access, including write actions, is currently available on Business and Enterprise/Edu. Pro can connect custom MCP apps with read and fetch permissions only. The current interface is on ChatGPT web and may be controlled by a workspace administrator.

## Endpoint and authentication

Use one of these placeholder forms:

| Style | Endpoint | Authentication setting |
| --- | --- | --- |
| Bearer header | `<REMOTE_MCP_ORIGIN>/mcp` | Send `Authorization: Bearer <REMOTE_MCP_KEY>` |
| URL path | `<REMOTE_MCP_ORIGIN>/mcp/<REMOTE_MCP_KEY>` | Select no authentication because the key is already in the URL |

Prefer the Bearer-header style when the ChatGPT setup surface offers a compatible bearer or custom-header option. The path-key style is a compatibility alternative. Treat either value as a secret; a URL containing a key can appear in browser history, screenshots, logs, and administrative records.

## Configure the app

1. In ChatGPT web, enable developer mode if your plan and workspace role allow it.
2. Open user or workspace settings, go to **Apps**, and choose **Create**.
3. Enter a neutral app name and one endpoint from the table above.
4. Select the matching authentication option.
5. Choose **Scan tools** and wait for discovery to finish.
6. Review the discovered read and write actions, then create the draft app.
7. Open a new chat, enable the draft app from the tools menu, and test a bounded read before any write.

Expect a successful scan to discover up to 35 remote tools. Which actions ChatGPT permits depends on the plan, workspace policy, and action configuration; Pro does not receive the write actions. `discord_view_attachment` is cloud-only. The shared `discord_fetch_attachment` returns fresh attachment URLs remotely rather than downloading into the ChatGPT client filesystem.

## Compatibility constraint for tool schemas

Some MCP clients silently drop tool descriptions or parameter descriptions when those descriptions contain embedded double quotes. Keep every tool and parameter description quote-free. After changing any schema description, rescan or refresh the app actions and verify that names, descriptions, and inputs are still present.

## Troubleshooting

### Developer mode or Create is missing

- Confirm the current ChatGPT plan supports the required custom-app capabilities.
- Ask the workspace administrator to enable developer mode or grant the required role.
- Use ChatGPT web; custom MCP apps may not be available in every client surface.

### Tool scan fails

- Confirm the endpoint is HTTPS and ends in `/mcp` or `/mcp/<REMOTE_MCP_KEY>`.
- Confirm the Worker accepts `POST` requests at that route.
- For header auth, verify the header is exactly `Authorization: Bearer <REMOTE_MCP_KEY>`.
- For path auth, select no authentication and verify the key occupies one path segment.
- Check the Worker logs for authorization, routing, or MCP protocol errors without logging the secret.

### Some tools or inputs are missing

- Remove embedded double quotes from all tool and parameter descriptions.
- Rescan tools while the app is a draft, or refresh its actions through workspace administration.
- Compare the scan with the 35-tool remote inventory in [TOOL-REFERENCE.md](TOOL-REFERENCE.md).

### Tool calls fail after a server update

ChatGPT may retain an approved snapshot of tool definitions. Refresh the app actions and review the schema changes. Recreate the draft if the current workspace flow does not support updating it.

### Local paths do not work

This is expected. ChatGPT reaches the remote server, so paths on the client computer are unavailable. Upload or stage the file through an authorized server-side workflow, or use the local stdio server from Claude Code.
