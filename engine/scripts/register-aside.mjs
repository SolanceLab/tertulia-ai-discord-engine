#!/usr/bin/env node
// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Registers the private aside as a USER-INSTALLED command (only in the installing user's own slash
// menu). Usage: node scripts/register-aside.mjs [name] [--followup]   (default name: aside; a deployment can pick its own;
// --followup registers the /followup command instead, --study registers the study-window command (default wake),
// --reply registers the "Reply as <bot>" message command (right-click a message, Apps; its name is the identity's reply_command).
// With no name given, the names, choices and descriptions come from the deployment's identity config.)
// Reads DISCORD_BOT_TOKEN from the environment or ./.env. POSTs one command: it ADDS or updates
// that name and never touches the app's other commands (a PUT to /commands would replace them all).
// .env first: the identity config (HOUSE_CONFIG_PATH) is read at import time, so the config-dependent
// modules are imported only after the env is loaded (Codex, 16 Oct).
import '../dist/load-env.js';
const { asideCommand, followupCommand } = await import('../dist/aside.js');
const { studyCommand } = await import('../dist/study-summons.js');
const { replyCommand } = await import('../dist/reply-as.js');
const { identity } = await import('../dist/config/identity.js');
const { resolveCommandNames } = await import('../dist/config/identity-defaults.js');

const args = process.argv.slice(2);
const isFollowup = args.includes('--followup');
const isStudy = args.includes('--study');
const isReply = args.includes('--reply');
const given = args.find((a) => !a.startsWith('--'));
let token = process.env.DISCORD_BOT_TOKEN;
// The same resolver the running bot uses: env overrides (ASIDE_COMMAND_NAME, FOLLOWUP_COMMAND_NAME) are
// validated and collision-checked exactly as at runtime, so what is registered is what is handled.
const names = resolveCommandNames(identity, process.env);
const name = given || (isReply ? identity.reply_command : null) || (isStudy ? names.study : isFollowup ? names.followup : names.aside);
if (!token) { console.error('DISCORD_BOT_TOKEN missing'); process.exit(1); }
const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
const app = await (await fetch('https://discord.com/api/v10/applications/@me', { headers })).json();
if (!app?.id) { console.error('could not read the application'); process.exit(1); }
const res = await fetch(`https://discord.com/api/v10/applications/${app.id}/commands`, { method: 'POST', headers, body: JSON.stringify(isReply ? replyCommand(name) : isStudy ? studyCommand(name) : isFollowup ? followupCommand(name, identity.followup_description) : asideCommand(name, { description: identity.aside_to_description, choices: identity.aside_choices })) });
const body = await res.json();
if (!res.ok) { console.error('register failed', res.status, JSON.stringify(body).slice(0, 300)); process.exit(1); }
console.log(`registered ${body.type === 3 ? '' : '/'}${body.name} (id ${body.id}, user-install only)`);
