# Settings

Back to the [README](../README.md). Hooks have their own page: [hooks.md](hooks.md).

Set these as environment variables on the bot, for example in `engine/.env`.

| Setting | What it is |
|---|---|
| `DISCORD_BOT_TOKEN` | Your Discord bot token |
| `OWNER_USER_ID` | Your Discord user ID. The bot treats you as the owner |
| `PRESENCE_ENABLED` | `true` turns Presence on |
| `BOT_API_SECRET` | Required on the bot. The key the tools server sends to reach it |
| `BOT_API_PORT` | The port the bot listens on. Default 3000 |
| `MODEL_PROVIDER` | `openai-compatible` (default) or `anthropic` |
| `MODEL_BASE_URL` | The model address. Defaults to OpenAI's, or Anthropic's for `anthropic` |
| `MODEL_API_KEY` | Your model key. Required |
| `MODEL_NAME` | The model to call. Required |
| `MEMORY` | `off` (default), `http` or `antechamber`. `antechamber` is experimental: Antechamber is coming and the adapter may change before its release |
| `MEMORY_URL` | Your memory service address, https only. Needed for `http` |
| `MEMORY_KEY` | Sent to your memory service as a Bearer key |
| `ANTECHAMBER_URL` | Your Antechamber address. Needed for `antechamber`. http works only on this computer |
| `ANTECHAMBER_KEY` | Optional key for your Antechamber |
| `TERTULIA_HOOKS_PATH` | Optional. The full path of your hooks file (see [hooks.md](hooks.md)). If it is set and the file is missing or broken, the bot stops at start with an error. Unset, the bot looks for `deployment-hooks.js` next to the built engine (the build writes your layer's hooks file there), and runs without hooks if there is none |
| `CONFIG_PATH` | Path to your settings file, a JSON file that sets the names, labels and per-server defaults. Without it the bot uses neutral defaults. If it is set and the file is missing or not valid JSON, the bot stops at start with an error naming the path |
| `SETTINGS_PATH` | Where the bot keeps changes you make on the settings page. Default `./data/settings.json` |
| `PROFILE_FILES_DIR` | Optional. A folder the profile tools may read image files from (`avatar_path`, `banner_path`). Unset by default, which turns local path reads off; images sent as base64 or a data URI still work. When set, a path must resolve (symlinks followed) to a regular file inside this folder and be at most 8 MB. The folder is trusted: keep it owned and writable only by you, because the check does not defend against someone else who can write in it |
| `CONTEXT_LOG_PATH` | Where the context log is written. Default `./data/context-log.jsonl` |
| `CONTEXT_LOG_URL` | Optional. Send the context log to a service you run instead of the file, https only |
| `CONTEXT_LOG_KEY` | Sent to that service as a Bearer key |
| `DASHBOARD_PASSWORD` | Turns the settings page on, and is its login password |
| `DASHBOARD_SECRET` | Optional. Keeps settings-page logins valid across restarts |
| `ASIDE_COMMAND_NAME` | Optional. Renames the private `/aside` command |
| `FOLLOWUP_COMMAND_NAME` | Optional. Renames the `/followup` command |
| Plugin server address | Where your tools server answers, ending in `/mcp` |
| Plugin key | The key your tools server expects, sent as a Bearer header |

## Time zone and a few more settings in the config file

These go in the JSON file named by `CONFIG_PATH` (or are set on the settings page where noted).

- `timezone`: an IANA name such as `Europe/Lisbon` or `America/New_York`. Default `UTC`. Quiet hours start and end, and the return time the bot gives when you are away, are read on this clock, and it follows daylight saving. A name that is not a real zone falls back to UTC and says so in the log. The settings document (`/settings/api/settings`) carries the same value as `timezone`; a value saved there wins over the file. The same clock also stamps each line of the conversation the model reads with its time (`[HH:MM]`) and marks day changes with a line such as `— Saturday 14 Nov —`, and the model is told the current date, time and zone.
- `identity.custom_status`: the bot's status line (empty by default).
- `identity.text` wording keys for single phrases inside the prompts. Each default is neutral; set the key to use your own words. Every one is optional.

  | Key | Default | What it changes |
  |---|---|---|
  | `presence.balanced_label` | `(the default)` | the label after "PRESENCE: BALANCED" in the instructions for deciding whether to speak |
  | `presence.friend_phrase` | `a friend of the server` | who the bot steps in for, in that same BALANCED step ("the way you would for ...") |
  | `respond.host_phrase` | `a warm, neutral host` | how the bot is told to treat everyone but the owner in a direct reply |
  | `respond.narration_walls` | `focus-mode narration walls` | the last item of the direct reply's "No essays, ..." rule |
  | `draft.private_register` | `private register` | the phrase in "no ..." in every prompt that drafts a public message (the private aside's proposal, its drafting pass, reply as the bot) |

- `identity.text["judge.intro"]`: the opening sentence of the instructions the bot gives its model when it decides whether to speak in a channel. The default is neutral ("You are deciding whether to SPEAK in a channel of this server or stay silent. You are a present host, not a wallflower and not a commentator on every line.").
- `awareness_say_guilds`: ids of servers where what your model provider knows about the owner may be spoken, not only shape the tone (default none).
- `plugs`: `{ "model": "direct" | "custom", "settings": "local" | "custom", "memory": "off" | "custom" }`. The defaults are `direct`, `local`, `off`. `custom` hands that choice to your hooks file (see [hooks.md](hooks.md)). The plug values of the earlier built-in hosted implementations no longer exist; a file that uses one stops the bot at start with an error that points here.
- `custom`: an object of your own. It is handed untouched to your hooks file's provider functions.
