# Hooks

Back to the [README](../README.md) or [settings.md](settings.md).

A deployment can add one optional hooks module that the engine loads at start. Name it with `TERTULIA_HOOKS_PATH`, or let the build place it as `deployment-hooks.js` next to the built engine (from source, `deployment/hooks.ts` beside `engine`). With no module nothing changes. If `TERTULIA_HOOKS_PATH` is set and the file is missing, cannot load, or exports something that is not a function, the bot stops at start with an error that names the path. A module exports `hooks` with any of these, each called once per message unless noted:

- `revealAuthor(authorId)` returns true to show an author as normal, even when they are on the ignore list or `hideAuthor` would hide them. It is checked first. It can therefore show an author you muted.
- `hideAuthor(authorId)` returns true to treat an author like one on the ignore list.
- `hideMessage(facts)` returns true to leave one message out everywhere the model could see it. `facts` is plain data: `authorId`, `content`, `mentionsBot`, `repliesToBot` and `msSinceBotSpokeInChannel` (milliseconds since the bot last spoke in that channel, or null when unknown).
- `onDirectMessage(msg, api)` can answer a message that mentions or replies to the bot.
- `onChannelReply(msg, api)` is called for a reply to another message (`id`, `channelId`, `guildId`, `authorId`, `authorIsOwner`, `content`). Return true when you handled it; the bot then does nothing more with that message. Bots and the bot itself are skipped. Absent, nothing changes.
- `authorNotes(authors)` returns one short note per person. `authors` lists the distinct people in the window the bot is about to read, except the bot itself: `{ id, shownName, username, isWebhook, isBot }`, where `shownName` is the server nickname, else the display name, else the username (for a webhook post, the persona's name). Return an object keyed `` `${id}|${shownName}` `` (the engine exports `authorNoteKey(author)`), so one bot account that speaks for several people can have a note for each. The bot calls it once per window, after ignored and hidden people are removed (they never reach it), and keeps each note for five minutes per key. The notes appear under "Who's here" in the instructions for deciding whether to speak and for replying, one line per person, labelled the way the transcript labels them. A note is cut to one line of at most 400 characters. Absent, or if it throws (logged once), the section is left out.

**The provider socket.** When a plug in the config file is `custom`, the engine asks the hooks module for that part. Each function receives `{ env, config, timeoutMs, primaryTarget }`: the environment, your `custom` object from the config file, the model timeout the engine wants, and the first model of the chain (`PRESENCE_PRIMARY_MODEL`).

- `modelProvider(opts)` (`plugs.model: "custom"`) returns a `ModelProvider` (see `engine/src/seams/model-provider.ts`). A model provider is required: with `plugs.model` `direct` (the default) the bot needs `MODEL_API_KEY` and `MODEL_NAME`, and with `custom` it needs this function. With neither, the bot refuses to start and the message names the settings to set. The engine ships no model ids; name yours with `PRESENCE_PRIMARY_MODEL`, `PRESENCE_FALLBACK_MODELS` and `PRESENCE_VISION_MODELS` (`engine:model,engine:model`; a bare name with no colon goes to the neutral `default` engine) if your provider walks a chain.
- `settingsStore(opts)` (`plugs.settings: "custom"`) returns a `SettingsStore` (`engine/src/seams/settings-store.ts`). By default the bot keeps its settings in a local file and calls no service.
- `contextSink(opts)` (`plugs.memory: "custom"`) returns a memory provider: `recall(query)`, and optionally `flush(rows)` (receives the context-log rows; without it they are dropped) and `readJournal(limit)` (fills the "active threads" and "recent journal" sections of the prompt; without it there is no journal).
- `auditSink(opts)` is optional and switches the audit-log copy on (see [limits.md](limits.md)): `latest(guildId)` returns the id of the newest entry it holds, `post(guildId, entries)` stores up to 100 and returns how many.

Everything but the model is optional and off by default; the bot logs once at start which optional features are off. No default setting calls a hosted service.

Hiding (the ignore list, `hideAuthor`, `hideMessage`) governs what the bot's model sees. Your own tools (read messages, find message, search messages, list pins) read every message.

A hook that throws hides and reveals nobody, and the error is logged once. Hook code is operator-trusted: it runs with the bot's own privileges, so install only code you wrote or read.
