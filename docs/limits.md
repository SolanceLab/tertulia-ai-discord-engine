# Limits

Back to the [README](../README.md).

- The sweep, where the companion looks over the channels and decides whether to join in, runs every 5 to 240 minutes. The default is 30.
- When the owner mentions the bot, it answers at once. When anyone else does, the owner gets a DM, and the bot answers at the next sweep. Other people's mentions are never answered instantly.
- Channels that stay their maker's: list category ids under `owned_channel_categories` in the config file (default empty = off). In your home server, when a member who is not an admin or a bot creates a channel in one of those categories, the bot allows Manage Channels for that member on the channel and clears Manage Channels, Manage Roles and Manage Webhooks from every other role and member overwrite there (only overwrites on the channel are edited; Administrator roles cannot be limited), then DMs you. It needs View Audit Log (Administrator covers it). If a lock fails, or the maker cannot be found, you get a DM saying which channel and why. On start the bot sweeps the listed categories once to catch channels it missed (audit log, up to 45 days back) and DMs one summary line for any it could not lock.
- Your own copy of the audit log: Discord keeps audit log entries 45 days. Set `audit_copy_hours` in the config file (default 0 = off), supply `auditSink` in your hooks file, and, in your home server, the bot copies new entries to it every that many hours (the first copy comes 2 minutes after start), oldest first, 100 at a time. With no `auditSink` the copy stays off and the log says so. Repeating a run is safe. It logs one line per run; if a copy fails you get a DM at most once a day, and the next run catches up. It needs View Audit Log (Administrator covers it).
- A server the bot has not been set up for starts Silent. Silent servers get no answers. Guest servers answer mentions only. Home servers answer and join in.
- Memory: the bot waits 7 seconds for your memory service and ignores any reply over 256 KiB. If it fails, the bot carries on without memory for that turn.
- Linked calendar: the bot refreshes it at most every 10 minutes. If the calendar cannot be reached, the bot uses the last good copy for up to 6 hours, then stops using it.
- The settings page keeps you logged in for 12 hours. It allows 10 login attempts a minute per address.
- The settings document accepts up to 200 servers and up to 500 blocked keywords.
- `/aside` takes a question of up to 1500 characters.
- The right-click reply quotes the first 80 characters of the message it answers.
- `discord_send_file` accepts files up to about 7 MB. The bot refuses requests over 10 MB.
- The settings page lists the last 200 context log entries at most.
