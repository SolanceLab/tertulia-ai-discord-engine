# How it works

Back to the [README](../README.md).

The bot connects to Discord through the gateway. Each message passes through the presence engine, which decides whether to answer and calls your model directly. The model is OpenAI-compatible or Anthropic, with the key you supply.

Settings live in one JSON file on the bot. The settings page is a dashboard module: the page code reads and writes them through the bot's `/settings/api`, and the host supplies the login and the look. It is off until you set `DASHBOARD_PASSWORD`.

Memory is a socket, and it is off by default. If you turn it on, the bot asks your service for notes before it replies. The `http` socket works with any memory service you run. The `antechamber` socket talks to [Antechamber](https://github.com/SolanceLab/antechamber), the recall engine in the [Presence App](https://github.com/SolanceLab/presence-app). It is experimental, and the adapter may still change. The public build only reads from memory. It has no way to write to one. It keeps each server's memories to that server, and never quotes anything from outside the server it is in. Your keyword blocklist is applied to what comes back.

**The context log.** The context log is how you keep a record of what the bot says. It is off by default, and you set it per server on the settings page, or once for every server. When it is on, the bot records its own replies together with the conversation each one answered, which means other people's words. Each entry has the Discord message id, the time in UTC, the server, channel and author, whether a bot wrote it, the text, and which message it replied to. A reply's entry can also carry how the reply was made. Only turn it on in servers whose members know about it. The record goes to a local file (`CONTEXT_LOG_PATH`), or to a service you run when you set `CONTEXT_LOG_URL`. If that service cannot be reached, the entries for that moment are dropped and the bot carries on. Your keyword blocklist keeps chosen words out of it.

Hidden people are people the bot never sees. It cannot be summoned by them. The keyword blocklist keeps chosen words out of memory and the context log. Both are set on the settings page.

The tools server is a thin layer. It checks your key and forwards each tool call to the bot, which does the work in Discord.
