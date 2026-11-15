# Answer from Claude Code

Back to the [README](../README.md).

Ask your own Claude Code (or Codex) a question from inside Discord, privately. `/aside your question to: agent` queues it; a small watcher on your computer runs it through Claude Code and the answer comes back to you, visible only to you. Setup: switch on the Agent section on the settings page, register the command (`node scripts/register-aside.mjs` from `engine`), then run the watcher (`agent/README.md`):

```
BOT_URL=https://your-bot.example BOT_API_SECRET=your-secret \
AGENT_COMMAND='claude -p --tools "Read,Grep,Glob,WebSearch,WebFetch" --strict-mcp-config' node agent/watch.mjs
```

## What the agent may do

By default it reads and browses, and answers you privately. The command above gives Claude Code only `Read`, `Grep`, `Glob`, `WebSearch` and `WebFetch`: it does not run commands, write files or post anything on its own, and `--strict-mcp-config` keeps any other tools you have connected to Claude Code out of the agent. The answer goes back through the watcher, never through the agent's own tools.

This is the safety measure we decided to keep: we limit what the agent can touch until we can be sure how to make wider access solid. It is adjustable, based on your comfort level. Widening it is your choice, on your own machine, at your own risk.

The bot has limits of its own, whatever the agent does: role and permission edits are made only in the home server (when one is set), the bot never grants Administrator, and messages the model writes never ping @everyone, @here or roles.
