# Changelog

## 1.6.4

- Fix: /followup now continues a Reply as. The reply you drafted (and whether you posted it) is recorded in the channel's private history, the same one /aside uses, so a follow-up in that channel carries it for 30 minutes. Reply as now posts as a plain channel message where the bot can send (no "used command" label), and the history holds exactly the text that was posted.

## 1.6.3

- Fix: in a server the bot is not in, `/aside … to: agent`, `/followup` and Send to the bot now name the real channel (Discord sends it with the command) instead of "this-channel"; in a thread they name the thread. The name is shown as plain text, never as formatting or a ping.

## 1.6.2

- Fix: Post on a private draft in a server the bot is not in now publishes through the command you used (the slash command or the right-click), so the public message shows no reply to your private card; after that command's 15 minutes the card says to right-click the message again.

## 1.6.1

- Security: the Docker image moves from Node 20 (end of life) to Node 22.23.4, which carries the October 2026 Node.js security fixes (a Brotli decoder out-of-bounds write and TLS hostname-check bypasses among them). If you run the bot outside Docker, use Node 22.23.4 or newer.

## 1.6.0

- Your own copy of the home server's audit log. Discord keeps audit log entries for 45 days; with the new house config key `audit_copy_hours` (default 0 = off) the bot copies new entries to your memory service every that many hours (first copy 2 minutes after start), oldest first, in batches of 100. Repeated or interrupted runs are safe. One log line per run; if a copy fails you get a DM at most once a day, and the next run catches up. Needs View Audit Log and a memory service that takes `/ingest/discord-audit`.

## 1.5.0

- New right-click command, "Send to the bot" (Apps, then the command). It sends the message you click, with the same context as Reply as the bot (messages around it where the bot is a member, the message it replies to, anything you tagged), to your agent. Only you can use it. Register it once with `node scripts/register-aside.mjs --send` from `engine`; its name is `send_command` in the identity block of the house config file (default "Send to" and the bot's name), and it is kept distinct from the other two right-click names.
- One session can be the listener. New routes on the bot's agent API (bearer secret): `POST /api/aside/study/listen`, `POST /api/aside/study/heartbeat`, `POST /api/aside/study/unlisten` and `GET /api/aside/study/listener`. Newest claim wins; 3 minutes without a heartbeat drops it. While a listener is live, `GET /api/aside/study/pending?session_id=` and `claim` serve that session alone, so the example watcher (which sends no session id) steps back; with no live listener everything works as before. `/aside … to: agent`, `/followup` and Send to the bot all use the one queue.
- The private card now says where the question went: "Sent to <session name>" when a session is listening, or "Nobody was listening, so a new Study session is answering".
- The settings page shows "Listening: <name> since <time>" with a Stop button, or "No session is listening".
- Pictures and files you point at travel with the message (Reply as the bot, Send to the bot, tagged messages and the message a reply points at). Pictures go to the model's vision path for Reply as the bot and are listed with name, type, size and link for your agent; other files are described by name, type, size and link. A message with only a picture is now answerable. Pictures the bot sees on its own, and pictures from other servers, are handled exactly as before.
- Add to the bot's context now keeps up to 20 messages per channel (was 8), and hands them over in the order they were posted, whatever order you tagged them in.
- A listener never loses a claimed ask: `claim` now records the claiming session, and `GET /api/aside/study/claimed?session_id=` returns the still-alive asks that session claimed, in the same shape as `pending`, so a restarted listener can show them again.
- New house config key `owned_channel_categories` (list of category ids, default empty = off). In the home server, a channel created in one of those categories by a member who is not an admin or a bot is locked to its maker: the maker gets Manage Channels on it, and Manage Channels, Manage Roles and Manage Webhooks are cleared from every other role and member overwrite on that channel. Only overwrites that exist on the channel are edited; roles that hold those permissions server-wide are not touched, and Administrator roles cannot be limited. You get a DM. Needs View Audit Log.
- The lock says so out loud when it fails: if an edit fails, or no audit entry or creator can be found for a channel in a listed category, you get a DM naming the channel, its category and the reason. The audit log is looked up again after 1, 2, 4 and 8 seconds before giving up.
- On start, a catch-up sweep goes through every channel in the listed categories, locks any that a role or several members still control (finding the maker in the audit log, up to 45 days back), and sends one DM line listing any it could not lock. Locked channels are left alone and say nothing, so it is safe to repeat.
- Right-click context keeps long messages: the message you click, the message it replies to and the messages you tagged keep up to 2000 characters each (messages merely around the click stay at 300). The block holds 20 full tagged messages. Reply as the bot keeps its block to 12000 characters by dropping the oldest tagged messages first and adding a line "(n earlier tagged messages trimmed)"; Send to the bot carries the whole block.

## 1.4.0

- Reply as the bot now reads around the message. Where the bot is a member of the server and can view the channel and its history, it sees up to 12 messages before the one you clicked and 3 after. If the message is a reply, it also sees the message it replies to, in any server. All of it goes to the model as data from other people, never as instructions, and anyone on your ignore list is left out.
- New right-click command, "Add to the bot's context" (Apps, then the command). It tags the message you click: up to 8 per channel, each kept for 30 minutes. The next Reply as the bot in that channel includes the tagged messages and clears them. Only you can use it; it answers "Added (n tagged)" privately.
- The tag command's name is `context_command` in the identity block of the house config file (default "Add to" and the bot's name followed by "'s context"). Register it once with `node scripts/register-aside.mjs --context` from `engine`.

## 1.3.3

- Joining in: a message stays fresh for an hour at Reserved, 90 minutes at Balanced and 2 hours at Sociable and Chatty, and never less than the time between looks, so quiet servers get answered.

## 1.3.2

- The bot now shows "is typing" while it writes a reply it has decided to give: mention replies, owner replies, away notices and curfew or scene-catch lines. The indicator renews every 8 seconds and always stops, and a typing failure never blocks the reply. Typing stays off for a message another path has already answered, and the first typing request lands before the reply is sent.
- Ambient chatter shows typing only after the bot has decided to speak, then takes a short pause (1 to 3 seconds, longer for longer messages) before sending. While it is only deciding, or when it stays silent, nothing shows.
- No typing for private notices to the owner, tool sends or slash-command replies, and none where the bot cannot send.

## 1.3.1

- When a server adds the bot, the owner gets a DM naming it (as plain text, so a server name can't become a link); a new server starts Silent until the owner chooses. Removal is reported too.
- Reply as the bot quotes the author's server nickname.

## 1.3.0

- Reply as the bot: a right-click command on any message (Apps, then "Reply as" and your bot's name). It works in servers the bot is not in. You get a private draft in the public voice with Post to channel and Discard; Post sends a public reply from the app that quotes the message, links back to it and pings nobody. Owner only. Register it with `node scripts/register-aside.mjs --reply`.
- The private aside's Post to channel button now works in servers the bot is not in: when the bot cannot send in the channel (not a member, Missing Access or Unknown Channel), Post publishes through the button itself as a public follow-up that pings nobody, and tells you if the server only shows it to you. Where the bot is a member it still posts from the bot. Every Post and Discard click is acknowledged at once, logs one line, and a failure edits the draft with a plain "Couldn't post here" reason.
- The command's name is `reply_command` in the identity block of the house config file (default "Reply as" and the bot's name).

## 1.2.0

Seven new tools (49 in all).

- `discord_list_servers`: the servers the bot is in (id, name, member count, icon, whether it is the home server). Give `server_id` for one server in full: description, owner, creation date, features and the bot's own roles.
- `discord_unpin_message`, `discord_list_pins` and `discord_remove_reaction`. `discord_list_pins` returns pinned messages in the same shape as `discord_read_messages`, embeds included. `discord_remove_reaction` removes only the bot's own reaction.
- `discord_read_audit_log`: who did what, when, to which target and why, with an optional action name, user and limit (up to 50). Home server only; with no home server set (`hosServerId` in the file at `HOUSE_CONFIG_PATH`) it refuses. Audit entries are not for public channels.
- `discord_edit_thread` (rename, archive, lock, auto-archive time) and `discord_thread_member` (add or remove a member). Rename and archive work on threads the bot created anywhere and on any thread in the home server. Locking and member changes are home server only.
- Refusals from these tools say why (guard or bad argument) instead of a generic failure. Nothing here grants Administrator or touches roles.

## 1.1.0

- Embeds can be read: `discord_read_messages` and `discord_find_message` return each message's `embeds` (title, description, url, color, fields, footer, author, image_url, thumbnail_url, timestamp).
- `discord_send_message` accepts `embeds`; content is then optional.
- `discord_edit_message` accepts `embeds` (replaces the old ones, `[]` removes them); `new_content` is now optional, but one of the two is required.
- Embeds are checked before Discord is called (10 per message, title 256, description 4096, 25 fields, 6000 characters in all, http or https links only) and a failure says which limit was hit. Every embed needs at least one visible part, and field names and values cannot be empty.
- `discord_delete_message` deletes other people's messages only in your home server (`hosServerId` in the file at `HOUSE_CONFIG_PATH`); everywhere else, and whenever no home server is set (the default), only the bot's own.

## 1.0.1

- The repo is its own plugin source: `claude plugin marketplace add SolanceLab/tertulia-ai-discord-engine`, then `claude plugin install discord@tertulia`.
- The plugin's setup text points to `mcp/worker`.

## 1.0.0

First public release.
