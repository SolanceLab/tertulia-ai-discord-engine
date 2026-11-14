# Moving to 1.8.0

This page lists every name that changed, every behaviour that changed, and what to do about each. Most renames need nothing from you: the earlier name still works, the new name wins when both are set, and the engine logs one warning per process that names the new one. The earlier names stay until the next major version.

A test (`engine/src/migrating-doc.test.ts`) fails the build when a name the engine still reads is missing from this page.

## What stops working until you act

| If your install... | It now... | You do |
|---|---|---|
| uses the plug value `sanctum` or `solance-api`, or a config file with no `plugs` that names a hosted service URL | stops at start with an error that names `custom` and the hooks file | write a hooks file that supplies the provider, set the plug to `custom` |
| has no model provider | refuses to start and names the settings to set | set `MODEL_API_KEY` and `MODEL_NAME`, or set `plugs.model` to `custom` and supply `modelProvider` |
| relied on the earlier fixed time zone (seven hours ahead of UTC) | reads UTC | set `timezone` (for example `Asia/Jakarta`) |
| set `TERTULIA_HOOKS_PATH` to a file that is missing | stops at start | fix the path or unset it |

## What changed behind the same name

- **Time zone.** `timezone` is a new setting, an IANA name, default `UTC`. It now drives quiet hours, the away return time and the times shown in the conversation the model reads (`[HH:MM]` on each line, a day-break line where the date changes, and a `Now:` line in the prompts).
- **Status text.** The default is empty. A public bot shows no status until you set `identity.custom_status` (or use `discord_status_set`).
- **Profile files.** `PROFILE_FILES_DIR` is off by default: the profile tools refuse local file paths. Set it to a folder and they read only regular files inside it, at most 8 MB.
- **Owner read tools.** `discord_read_messages`, `discord_find_message`, `discord_search_messages` and `discord_list_pins` return every message, including messages from ignored or hidden authors. Hiding (the ignore list, `hideAuthor`, `hideMessage`) governs what the bot's own model sees, not what its owner reads.
- **Model ids.** The engine carries no default model ids. With a gateway provider, name yours with `PRESENCE_PRIMARY_MODEL`, `PRESENCE_FALLBACK_MODELS` and `PRESENCE_VISION_MODELS`.
- **Care replies.** The care-reply config is gone. Use the `onChannelReply` hook.

## Hosted values that were removed

| Removed | Replaced by |
|---|---|
| plug value `sanctum` (model) | plug value `custom`, with `modelProvider(opts)` in the hooks file |
| plug value `solance-api` (settings) | plug value `custom`, with `settingsStore(opts)` in the hooks file |
| a hosted store for the context log | plug `memory` set to `custom`, with `contextSink(opts)` in the hooks file; or `off` (the default) |
| config keys `modelServiceUrl`, `settingsApiUrl` | nothing; the provider in your hooks file holds its own addresses (`sanctumUrl` and `solanceApiUrl` are still recognised in an old file, as the renames in the table below, only so that file is read as before and then stopped by the plug error) |
| variables `MODEL_SERVICE_URL`, `MODEL_SERVICE_KEY`, `SETTINGS_API_URL`, `SETTINGS_API_TOKEN` | the same values, read by your hooks file from its own environment |
| identity `care`, config key `careChannelId` | the `onChannelReply` hook |

The hooks file is found through `TERTULIA_HOOKS_PATH`. It exports `hooks` with any of `modelProvider`, `settingsStore`, `contextSink`, `auditSink`, `authorNotes`, `onChannelReply`, `hideAuthor`, `revealAuthor`, `hideMessage` and `onDirectMessage`.

## Renamed environment variables

| Earlier | Now |
|---|---|
| `HOUSE_CONFIG_PATH` | `CONFIG_PATH` |
| `STUDY_ASIDE_GUEST_TEXT` | `AGENT_ASIDE_GUEST_TEXT` |

## Renamed files

| Earlier | Now |
|---|---|
| `discord.house.json` | `discord.config.json` |
| `house/` (the folder beside the bot) | `deployment/` |
| `house.hooks.js` | `hooks.js` |
| `house/hooks.ts` | `deployment/hooks.ts` |

## Renamed config keys

These are read at any depth of the config file, of the stored settings document and of a request body to the settings page. Stored settings are read under the earlier key and written under the new one on the next save.

| Earlier | Now |
|---|---|
| `curfew` | `quiet_hours` |
| `curfew_events` | `quiet_hours_events` |
| `curfew_stickers` | `quiet_hours_stickers` |
| `curfewStickers` | `quietHoursStickers` |
| `scene` | `focus` |
| `scene_sighting` | `focus_sighting` |
| `scene_sightings` | `focus_sightings` |
| `study` | `agent_window` |
| `study_command` | `agent_command` |
| `intimate_tells` | `private_tells` |
| `intimateStickerIds` | `ownerOnlyStickerIds` |
| `hosServerId` | `homeServerId` |
| `solanceApiUrl` | `settingsApiUrl` |
| `sanctumUrl` | `modelServiceUrl` |

Per-server rules (`servers[id].rules`):

| Earlier | Now |
|---|---|
| `curfew` | `quiet_hours` |
| `flag` | `focus` |

Identity text keys (sentence templates): `curfew.*` is now `quiet.*`, and `scene.*` is now `focus.*` (for example `curfew.tone.1` is `quiet.tone.1`).

## Renamed values

| Where | Earlier | Now |
|---|---|---|
| context-log level (config, stored settings, settings page requests) | `house_channels` | `this_server` |
| aside `to:` choice | `sanctum` | `model` |
| aside `to:` choice | `study` | `agent` |
| stored `source` of an away status | `curfew` | `quiet_hours` |

## Renamed command-line flag

| Earlier | Now |
|---|---|
| `--study` (`scripts/register-aside.mjs`) | `--agent` |

## Renamed HTTP routes

| Earlier | Now |
|---|---|
| `/api/aside/study/*` | `/api/aside/agent/*` |

The earlier paths still answer.

## Settings page: host methods and labels

A host written against the earlier contract is wrapped automatically.

| Earlier | Now |
|---|---|
| `getCurfew` | `getQuietHours` |
| `setCurfew` | `setQuietHours` |
| config key `scene` and `scene_sightings` | `focus` and `focus_sightings` |
| `rules.curfew`, `rules.flag` | `rules.quiet_hours`, `rules.focus` |
| label `house_channels_option` | `this_server_option` |
| label `curfew_description` | `quiet_hours_description` |
| label `server_rule_curfew` | `server_rule_quiet_hours` |
| label `server_rule_flag` | `server_rule_focus` |

Context-log rows stored before the rename, whose quiet-hours instruction says `curfew`, are still recognised when the log is read back.

## New settings, for reference

`TERTULIA_HOOKS_PATH`, `MODEL_API_KEY`, `MODEL_NAME`, `PROFILE_FILES_DIR`, `timezone`, `identity.custom_status`, `identity.text["judge.intro"]`, and the tools `discord_status_read`, `discord_status_set`, `discord_profile_read` and `discord_profile_set` (53 tools in all).
