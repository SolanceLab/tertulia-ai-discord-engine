# Discord module: host contract

The Discord pages are a dashboard module. The host supplies login, look and the connection.

```js
import manifest from '<module>/dashboard/manifest.js'
manifest.setup({ adapter, labels, theme, contextLog })   // once, before any page renders
```

`setup` calls `setHost` (host.js). `useHost()` throws a clear error when no host was set. The pages import nothing from the host app: no `@frame/`.

## adapter (required)

Every method returns a Promise. Same calls and shapes the pages made before the split.

| Method | Returns |
|---|---|
| `getDiscordConfig()` | `{ discord }` where discord = `{ step: 'silent'\|'reply_only'\|'reserved'\|'balanced'\|'sociable'\|'chatty', presence_level (legacy 0-4, read only when `step` is absent), sweep_minutes, posture: {channelId: step (an old word is read as one: off silent, reactive reply_only, gentle/moderate/high/full reserved)}, extra_instructions, name_triggers[], stickers_enabled, away: {announce, override: {active, reason, until, set_at, share_reason}}, context_log: 'off'\|'mentions_only'\|'house_channels'\|'all', ignored_user_ids[] }` |
| `setDiscordConfig(patch)` | `{ action, discord }`, patch is partial (`{step}`, `{context_log}`, `{sweep_minutes}`, `{posture}`, `{extra_instructions}`, `{name_triggers}`, `{ignored_user_ids}`, `{stickers_enabled}`, `{away: {announce}}`); the `away` leaf is deep-merged by the host. Per server: `{ servers: { [id]: partial } }`, where a partial is any of `{ step: 'silent'\|'reply_only'\|'reserved'\|'balanced'\|'sociable'\|'chatty'\|null, context_log: 'off'\|'mentions_only'\|'this_server'\|'all'\|null, rules: { curfew, flag, away: 'channel'\|'owner_dm'\|'off' } }` merged field by field into what is saved (`null` = same as the main dial / the global level; an old `mode` and `presence_level` are still read when a server has no `step`). Focus flag: `{ scene: { active: true, raised_by, until_hours } }` raises it, `{ scene: { active: false } }` lowers it. `getDiscordConfig().discord` then also carries `servers` (only what was saved), `scene` (`{ active, raised_at, raised_by, until, lowered_at }`) and `scene_sightings` (`[{ raised_at, caught }]`) |
| `getDiscordServers()` | `{ servers: [{ id, name, icon?, channel_count, joined_at?, defaults? }] }`, the servers the bot is in. `defaults` is how a server behaves before any choice is saved (`{ step, context_log, rules }`); absent, the page assumes Silent. Required for the Servers and Focus mode sections: an adapter without it keeps the flat per-channel posture list and hides both |
| `getDiscordChannels(guildId?)` | `{ channels: [{ id, name, type, category, category_position, position, default_step? }] }` for that server (`default_step` is optional: the step a channel follows when it has none of its own, for hosts that seed channels) (best effort; `[]` is fine). Without `guildId` the host answers for its main server |
| `getDiscordUserInfo(ids)` | `{ users: [{ id, name }] }`, `name: null` when unresolved |
| `getChannelBlocklist('discord')` | `{ blocklist: string[] }` |
| `setChannelBlocklist('discord', words)` | `{ blocklist: string[] }` |
| `getCurfew()` | `{ curfew: { enabled, start: 'HH:MM', end: 'HH:MM' } }` |
| `setCurfew({ enabled, start, end })` | `{ action, curfew }` |
| `getAwayStatus()` | `{ away, source, status, reason, announce, reason_shareable, until, until_label }` |
| `setAwayOverride({ active, reason, until, shareReason })` | `{ action, discord }` (like `setDiscordConfig`). `until` is an ISO instant or `null`; `shareReason: false` keeps the reason private. The current override is read from `getDiscordConfig().discord.away.override` |
| `getContextLogs({ channel, limit })` | `{ messages: [{ id, sender, author_name, message, created_at, model, context_log, tool_results, reasoning }] }` (`context_log` / `tool_results` may be JSON strings) |

### Optional adapter methods (Away)

Absent methods hide their part of the Away section; nothing else changes.

| Method | Returns |
|---|---|
| `getAwaySchedule()` | `{ next: { start, end, label? } \| null, source: 'calendar'\|'host'\|null }`. When `next` is present the section shows one line, "Next scheduled away: Thu 08:00–09:00" (formatted from `start`/`end` in the viewer's zone unless `label` is given), plus the `schedule_link` label when set |
| `getAwayCalendar()` | `{ linked, host, unreachable? }`, never the address |
| `setAwayCalendar(url)` | same shape. `url` is a private https iCal address to link, or `null` to unlink. The Calendar row (masked paste field, Link / Unlink, "Linked (host)") shows only when this method exists |

`getAwayStatus()` may return `source: 'calendar'` (busy time counts as away; no reason) and `calendar_unreachable: true`.

### Optional adapter methods (Persona and change history)

Absent `getPersona` hides the Persona and Change history sections and the page keeps its persona note (the House host does not offer them).

| Method | Returns |
|---|---|
| `getPersona()` | `{ source: 'page'\|'file'\|'url', editable, persona: { text, name, voice }, text_in_use, instructions }`. Editable fields show only when `editable` is true; for `file` and `url` the page shows `text_in_use` read-only with the `persona_core_note` line. `instructions` is the extra instructions text, editable whatever the source |
| `setPersona(patch)` | same shape. `patch` is any of `{ text, name, voice, instructions }`; the page sends only what changed. Recorded as made by the owner |
| `getSettingsHistory()` | `{ history: [{ id, at, by: 'owner'\|'agent', field, before, after }] }`, newest first, last 50. `field` is `persona.text`, `persona.name`, `persona.voice` or `extra_instructions`. Absent = no history list |
| `undoSettingsChange(id)` | restores the text that entry replaced and records the undo as its own entry |

### Optional adapter methods (Agent)

Absent `getAgentStatus` hides the Agent section (the House host does not offer it).

| Method | Returns |
|---|---|
| `getAgentStatus()` | `{ enabled, connected, last_seen }`, `last_seen` an ISO instant or `null` |
| `setAgentEnabled(enabled)` | same shape |

## labels (optional)

Neutral defaults live in `labels.js`. The host passes only what it wants to override; a host's own wording lives in the host, not in this module.

| Key | Neutral default |
|---|---|
| `page_title` | Discord |
| `page_description` | How present the bot is on your server, and the rules it holds while there. |
| `presence_description` | How willing the bot is to speak up on its own. Servers and channels can set their own. |
| `step_silent` / `_reply_only` / `_reserved` / `_balanced` / `_sociable` / `_chatty` (+ `_hint`) | The six steps of the one ladder and the line under each (what the step means) |
| `context_log_title` | Context log (what the bot remembers) |
| `context_log_description` | How much of Discord gets logged into memory — off, direct mentions only, chosen channels, or everything. |
| `house_channels_option` | Chosen channels |
| `posture_description` | Set how much the bot talks in specific channels — a busy channel can run chatty while a private one stays reply only, or silent. |
| `extra_instructions_placeholder` | Current guidance for the room… |
| `ignore_title` | Hidden people (who the bot never sees) |
| `ignore_description` | People the bot never sees and can't be summoned by — it still speaks in the room as usual. |
| `stickers_description` | Whether the bot rides messages with stickers — curfew nudges included. |
| `away_description` | Whether the bot tells guests it's away, and why. Set it here, or let a linked calendar set it. |
| `away_active_label` | Away right now |
| `away_reason_label` | Reason (optional) |
| `away_reason_placeholder` | e.g. traveling, offline for the weekend |
| `away_until_label` | Back at (optional) |
| `away_private_label` | Keep this reason private |
| `away_private_on` | The bot says only that it's away, and still says when it's back. |
| `away_private_off` | The bot explains where you are, in its own words. |
| `away_override_save` | Save away status |
| `away_override_error` | Could not save the away override. Try again. |
| `away_schedule_prefix` | Next scheduled away: |
| `away_from_calendar` | from calendar |
| `schedule_link` | none. `{ href, text }` shown after the schedule line |
| `away_calendar_label` | Calendar |
| `away_calendar_placeholder` | Paste your private iCal address |
| `away_calendar_help` | Paste your calendar's private iCal address (Google: Settings → your calendar → Secret address in iCal format; Apple and Outlook have the same). Busy times count as away; event names are never shown. |
| `away_calendar_link` / `away_calendar_unlink` | Link / Unlink |
| `away_calendar_linked` | Linked |
| `away_calendar_unreachable` | Calendar unreachable |
| `away_calendar_error` | Could not save the calendar link. Check the address and try again. |
| `servers_title`, `servers_description`, `servers_empty`, `servers_error` | Servers section: heading ("Servers"), line under it, empty and load-failed notes |
| `server_step_label`, `server_step_default` | The server's "How much the bot talks here" select and its first option ("Same as main dial", shown with the dial's step; a House host overrides it to its own word) |
| `server_details`, `server_memory_label`, `server_memory_default`, `server_memory_this`, `server_memory_note` | Details: what it remembers; the note says memories stay with their server |
| `server_rules_title`, `server_rule_curfew`, `server_rule_flag`, `server_rule_away_label`, `server_away_channel` / `_owner_dm` / `_off` | Rules here. The away choices default to "Tell them in the channel" / "Only tell you (DM)" / "Off" |
| `server_channels_*`, `channel_step_default`, `server_uncategorized`, `server_save`, `server_save_error` | Channels grouped by category, a channel's first option ("Same as server", shown with the effective step), the per-server Save |
| `focus_title`, `focus_description`, `focus_status_up` / `_down`, `focus_until`, `focus_raised_by`, `focus_caught` (+ `_yes` / `_no`), `focus_turn_on`, `focus_turn_off`, `focus_until_morning`, `focus_error` | Focus mode section. A host with its own word for the flag overrides `focus_title` and `focus_description` |
| `curfew_description` | The window the bot holds the line on, every night. |
| `persona_title`, `persona_description`, `persona_name_label`, `persona_text_label`, `persona_voice_label`, `persona_instructions_label`, `persona_instructions_help`, `persona_core_note`, `persona_save`, `persona_saved`, `persona_error`, `persona_load_error` | Persona section (shown when the adapter has `getPersona`) |
| `history_title`, `history_description`, `history_empty`, `history_by_owner`, `history_by_agent`, `history_undo`, `history_undo_error`, `history_field_*` | Change history list |
| `persona_note` | Persona is deploy-managed — no live editor here yet. View it in |
| `persona_path` | persona.md |
| `context_logs_description` | See what the bot received and responded for each message. |
| `bot_sender` | bot |
| `context_log_channels` (array) | `['discord']` |

## contextLog (optional)

`{ selfNames: string[], transcriptTags: string[] }`: hints for recovering the transcript from older logs: the bot's own speaker names, and the tags the transcript was wrapped in. Neutral default: none.

## theme (optional)

Free-form, kept on the host object. The pages add no colours: they use the host's CSS variables and classes (`--page`, `--ink`, `--gold-soft`, `--rule-mid`, and the rest).

## Public adapter: `adapters/bot-settings-api.js`

`createBotSettingsAdapter({ baseUrl = '/settings/api' })` talks to the bot's `/settings/api` (cookie login, `GET/PUT /settings`, `GET /context-logs`, `GET/PUT /persona`, `GET /settings-history`, `POST /settings-history/undo`). The host handles login (the adapter also offers `login(password)`).

The bot's document holds: presence level and posture, curfew, away (override, announce, reason shareable), ignored user ids, context log level, keyword blocklist. The linked calendar lives beside it (`GET/PUT /away-calendar`): the address goes in and is never returned, only `{ linked, host }`. Busy times count as away; the reason is empty and event names are never read out.

It does not hold these, so the adapter returns empty values on read and refuses writes (the page shows its save-failed message): `sweep_minutes` (null), `extra_instructions` (''), `name_triggers` ([]), `stickers_enabled` (true). `getDiscordUserInfo()` returns `name: null`, so rows show raw ids. `getDiscordServers()` and `getDiscordChannels(guildId)` read the bot's `GET /servers` and `GET /channels?server_id=`; the per-server choices and the focus flag are part of the same settings document (`servers`, `focus`). Context logs come from the bot's local log only (`501` when memory is not local); `tool_results` and `reasoning` are null.

## Capabilities

Four settings sections need fields the adapter must be able to save: `sweep_minutes` (cadence), `extra_instructions`, `name_triggers`, `stickers_enabled`. A host (or adapter, via `adapter.capabilities`) passes `capabilities: { sweep_minutes: false, ... }` to hide a section it cannot save. Absent keys mean supported. `createBotSettingsAdapter()` sets all four to false, so the default public adapter hides those sections instead of showing editors that always fail.
