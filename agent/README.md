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

## Listening

The watcher above starts a fresh agent session for each question. If you would rather have one running session answer, it can say it is listening. Every call is an HTTPS request with `Authorization: Bearer <BOT_API_SECRET>` and a JSON body:

| Call | What it does |
|---|---|
| `POST /api/aside/study/listen` `{ session_id, name }` | This session is now the listener. The newest claim wins. `name` is what the card shows ("Sent to <name>") |
| `POST /api/aside/study/heartbeat` `{ session_id }` | Send at least every 60 seconds. 3 minutes without one drops the listener. A 409 answer means you are no longer the listener: stop, or claim again |
| `GET /api/aside/study/pending?session_id=<id>` | Waiting questions. While a listener is live, only that session's id gets any |
| `POST /api/aside/study/claim` `{ id, session_id }` | Take one question. 409 if it is taken or you are not the listener |
| `POST /api/aside/study/answer` `{ id, note, proposal? }` | The private answer; a `proposal` gets Post to channel and Discard buttons |
| `POST /api/aside/study/release` `{ id }` | Give a claimed question back to the queue |
| `POST /api/aside/study/unlisten` `{ session_id? }` | Stop listening. With no id it stops whoever is listening, which is what the settings page's Stop button does |
| `GET /api/aside/study/listener` | Who is listening now, or `null` |

While a listener is live, this folder's `watch.mjs` sends no `session_id`, so it gets an empty list and steps back; with no live listener it works as before. A question the listener claims but does not answer can be released back to the queue, and the watcher then takes it. A pending item may carry `send` (the message you pointed at, from Send to the bot) and `attachments` (name, content_type, size, url and whether it is an image) for the files you pointed at.

## What the agent may do

By default it reads and browses, and answers you privately. The command above gives Claude Code only `Read`, `Grep`, `Glob`, `WebSearch` and `WebFetch`. It does not run commands, write files or post anything on its own, and `--strict-mcp-config` keeps any other tools you have connected to Claude Code, Discord tools included, out of the agent. The answer goes back to you through the watcher, never through the agent's own tools.

This is the safety measure we decided to keep: we limit what the agent can touch until we can be sure how to make wider access solid. It is adjustable, based on your comfort level. Widening it is your choice, on your own machine, at your own risk: add tools to the `--tools` list, or use a different command.

The bot has limits of its own, whatever the agent does:

- Role and permission edits are made only in the home server, when one is set.
- The bot never grants Administrator.
- Messages the model writes never ping @everyone, @here or roles.
