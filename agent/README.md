# Agent watcher

Your own agent (for example Claude Code or Codex) can answer `/aside` with `to: agent` and `/wake`. This folder is a small example watcher that connects it to your bot. Node 20 or newer, no dependencies.

1. On the settings page, open the Agent section and switch it on.
2. On the machine where your agent lives, run:

```
BOT_URL=https://your-bot.example BOT_API_SECRET=your-secret \
AGENT_COMMAND='claude -p --tools "Read,Grep,Glob,WebSearch,WebFetch" --strict-mcp-config' node watch.mjs
```

| Setting | What it is |
|---|---|
| `BOT_URL` | Your bot's address |
| `BOT_API_SECRET` | The same `BOT_API_SECRET` the bot uses |
| `AGENT_COMMAND` | A shell command. It receives the question on stdin and prints the answer, for example the Claude Code command above, or `codex exec -` with its own read-only settings |
| `POLL_SECONDS` | How often to ask the bot for new questions. Default 20 |
| `AGENT_TIMEOUT_SECONDS` | How long the command may take. Default 600 |

The watcher takes one question at a time, runs your command, and posts the answer back to you privately. If the command fails or times out, the question goes back in the queue. The log shows ids and outcomes only, never the question or the secret.

The agent's tools are set on the machine where it runs. This watcher only passes text in and out.

## What the agent may do

By default it reads and browses, and answers you privately. The command above gives Claude Code only `Read`, `Grep`, `Glob`, `WebSearch` and `WebFetch`. It does not run commands, write files or post anything on its own, and `--strict-mcp-config` keeps any other tools you have connected to Claude Code, Discord tools included, out of the agent. The answer goes back to you through the watcher, never through the agent's own tools.

This is the safety measure we decided to keep: we limit what the agent can touch until we can be sure how to make wider access solid. It is adjustable, based on your comfort level. Widening it is your choice, on your own machine, at your own risk: add tools to the `--tools` list, or use a different command.

The bot has limits of its own, whatever the agent does:

- Role and permission edits are made only in the home server, when one is set.
- The bot never grants Administrator.
- Messages the model writes never ping @everyone, @here or roles.
