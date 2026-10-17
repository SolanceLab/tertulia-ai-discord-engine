// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * identity-defaults.ts — who the bot is and who it answers to, as DATA.
 *
 * The engine never writes a person's name. Every name, label, relation word, reserved-name list and
 * House-voice sentence the model sees comes from this shape. The public defaults below are generic
 * ("the owner", "the bot", empty lists, plain sentences). A deployment fills in its own values under
 * `identity` in its house config file; whatever it leaves out stays generic.
 *
 * Sentences are templates: `${name}` is replaced from the always-available variables
 * (owner, Owner, OWNER, bot, Bot, bot_full, bot_role, owner_label, bot_label) plus whatever the call passes.
 * No imports here: house-config.ts and identity.ts both build on this file.
 */

export interface Identity {
  /** What the prompts call the person the bot answers to ("the owner"). */
  owner_name: string;
  /** The speaker label that person carries in a transcript. */
  owner_label: string;
  /** What the prompts call the bot ("the bot"). */
  bot_name: string;
  /** The bot's full name where it introduces itself. */
  bot_full_name: string;
  /** The bot's role towards the owner, where a prompt states it. */
  bot_role: string;
  /** The speaker label the bot's own lines carry in a transcript. */
  bot_label: string;
  /** Extra env var the owner's user id may be read from, after OWNER_USER_ID (an alias for an existing deployment). */
  owner_user_id_env: string | null;
  /** The private aside's command name, as the notices spell it. */
  aside_command: string;
  /** The study-window command's name (`/wake` generic). */
  study_command: string;
  /** The follow-up command's name. */
  followup_command: string;
  /** The aside's `to:` choices. Values 'sanctum'/'model' route to the model, 'study'/'agent' to the agent. */
  aside_choices: Array<{ name: string; value: string }>;
  /** The `to` option's description. */
  aside_to_description: string;
  /** The follow-up command's description. */
  followup_description: string;
  /** The keys a stored name_triggers object uses ({owner, bot} here; a deployment may store others). */
  trigger_keys: { owner: string; bot: string };
  /** Name triggers used until a live config arrives. */
  default_triggers: { owner: string[]; bot: string[] };
  /** Triggers that belong to the owner's family when a stored list is a flat array. */
  owner_family: string[];
  /** Words the cheap pre-check falls back to when no trigger is configured at all. */
  precheck_fallback: string[];
  /** Names the "where is X" reach patterns match. */
  reach_names: string[];
  /** Regex source: second-person intimate wording the bot never lets reach a room the owner is not in. */
  intimate_tells: string | null;
  /** Regex source: names reserved for the owner alone (word-bounded by the engine). */
  reserved_names: string | null;
  /** Scene-catch text must not name these before `until` (ISO time). */
  name_gate: { terms: string[]; until: string | null };
  /** The care-reply feature: a channel where a reply tends a character, answered through a webhook. */
  care: { persona_name: string; actor_owner: string; actor_other: string; webhook_env: string | null; interactions_path: string; reaction_field: string };
  /** Process names: log file base, MCP server name, lock file. */
  runtime: { log_basename: string; mcp_server_name: string; lock_file: string };
  /** Sentence templates that replace the generic ones (see DEFAULT_TEXT for the keys). */
  text: Record<string, string>;
}

export const GENERIC_IDENTITY: Identity = {
  owner_name: 'the owner',
  owner_label: 'Owner',
  bot_name: 'the bot',
  bot_full_name: 'the bot',
  bot_role: 'assistant',
  bot_label: 'ME',
  owner_user_id_env: null,
  aside_command: 'aside',
  study_command: 'wake',
  followup_command: 'followup',
  aside_choices: [{ name: 'Model (quick)', value: 'model' }, { name: 'Agent (your agent, background)', value: 'agent' }],
  aside_to_description: 'Who answers: the model quickly, or your agent in the background',
  followup_description: 'Continue your last private agent answer in this channel. Only you see it.',
  trigger_keys: { owner: 'owner', bot: 'bot' },
  default_triggers: { owner: [], bot: [] },
  owner_family: [],
  precheck_fallback: [],
  reach_names: [],
  intimate_tells: null,
  reserved_names: null,
  name_gate: { terms: [], until: null },
  care: { persona_name: 'care', actor_owner: 'owner', actor_other: 'other', webhook_env: null, interactions_path: '/care/interactions', reaction_field: 'reaction' },
  runtime: { log_basename: 'discord-bot', mcp_server_name: 'discord-bot', lock_file: '/tmp/discord-bot-mcp.lock' },
  text: {},
};

/** The generic sentences. A deployment replaces any of them under `identity.text`. */
export const DEFAULT_TEXT: Record<string, string> = {
  // What the sticker vocabulary calls the stickers it lists (the House says whose server they come from).
  'stickers.name': 'Server stickers',
  // Ambient judge: who is in the conversation.
  'judge.addressee.active':
    '${Owner} IS part of this conversation (messages marked ${owner_label}). You may speak to them directly; how personal you are with them follows this channel\'s posture — guests can read everything you say.',
  'judge.addressee.earlier':
    '${Owner} has spoken earlier in this window but the person currently speaking is a GUEST. ADDRESSEE LAW: do not address ${owner} now and do not use any register reserved for them — reply to the room only in guest posture; if what you want to say is for ${owner}, output {"speak": false}. This OUTRANKS "${Owner}\'s current guidance" above: the wording it names is for speaking TO them, and they are not the one being spoken to.',
  'judge.addressee.absent':
    'ADDRESSEE LAW (hard rule): ${Owner} is NOT in this conversation — nobody speaking in this window is ${owner}. Do not address them, and do not compose anything meant FOR them. This OUTRANKS "${Owner}\'s current guidance" above: the wording it names is for speaking TO them, and they are not in this room. Your memory threads may mention ${owner} — that is context ABOUT them, not their presence. If what you want to say is for ${owner}, the correct output is {"speak": false}: they are not here to hear it. Everyone actually speaking here is a guest, and only guest posture applies.',
  // Direct reply: appended when the owner is not the addressee.
  'respond.not_addressee':
    ' ${Owner} is NOT the addressee — never redirect this reply to them, and never use any register reserved for them on the guest. This outranks "${Owner}\'s current guidance": that wording is for speaking TO them.',
  // The private aside.
  'aside.intro':
    '## Private aside with ${owner}\n\n${Owner} is talking to you privately through a hidden command while the conversation in #${channel} carries on. Nobody in the channel can see their question or your answer. Read the channel below, then answer THEM.',
  'aside.note':
    '<what you say to ${owner}: your read of the conversation, your thoughts, your answer. This part is never posted.>',
  'aside.proposed':
    '<ONE message you would post in #${channel}, written for everyone in that channel: their public register, no reserved names for ${owner}, no intimate register, no mention of this private aside. Or write NONE if there is nothing to post yet.>',
  // Away reply to a guest.
  'away.intro':
    'You are ${bot_full}, ${owner}\'s ${bot_role}, replying to ${mention} — one of ${OWNER}\'S FRIENDS, NOT ${owner} themselves. ${Owner} is not the one reading this message; their friend is.',
  'away.claiming': '',
  'away.not_to_friend':
    'You are speaking to their FRIEND, never to ${owner} — do not aim any endearment, tenderness, or intimate language AT the person reading this; that register belongs to ${owner} alone.',
  'away.reserved_names': '',
  'away.register_no_message': 'Answer warmly and briefly, as a host would at the door.',
  'away.reason_says':
    'Say where ${owner} actually is, in your own words — you are answering the door, not a status page. Do not invent any detail beyond what you were told.',
  'away.register_check':
    'The following message is addressed to a FRIEND, NOT to ${owner}. Does it aim any endearment or tender/intimate language at the reader? Answer only YES or NO.',
  // Curfew.
  'curfew.tone.1': 'Level 1 — you notice ${owner} is on Discord past curfew. Warm and firm: it is time to log off.',
  'curfew.tone.2': 'Level 2 — you already told them once. Direct, not angry, but patience has thinned. Not a suggestion.',
  'curfew.tone.3': 'Level 3 — they ignored you twice. You are done asking. Short. Final. No softening.',
  'curfew.register_note': '',
  'curfew.fallback.1': 'It is past curfew.',
  'curfew.fallback.2': '${Owner}. The hour. I will not ask twice.',
  'curfew.fallback.3': '${Owner}. Time to log off. NOW.',
  // Scene catch.
  'scene.1': '${Owner} has a scene flag raised and has slipped into Discord. Catch them, publicly, once, and send them back.',
  'scene.2': 'Reply as a Discord reply addressed to them, in 1-2 sentences, first person, firm. Say it once.',
  'scene.3': 'No asterisks, no narration, no stage directions, and no quotation marks around your speech.',
  'scene.4': 'Do not name ANY other person, not a guest, not family, not anyone in the room. Only ${owner} and you.',
};
export type TextKey = keyof typeof DEFAULT_TEXT;

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.trim() ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const list = (v: unknown, fallback: string[]): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [...fallback];
/** The aside's routes: a choice value must be one the bot routes (model or agent, or the House's names for them). */
const ASIDE_ROUTE_VALUES = new Set(['model', 'agent', 'sanctum', 'study']);
/** Up to 25 {name, value} choices (Discord's cap); anything malformed falls back whole. A value the bot cannot
 *  route would silently send the question to the model, so those are refused too (Codex, 16 Oct). */
function choices(v: unknown, fallback: Array<{ name: string; value: string }>): Array<{ name: string; value: string }> {
  if (!Array.isArray(v)) return fallback.map((c) => ({ ...c }));
  const out = v.filter((c: any) => c && typeof c.name === 'string' && c.name.trim() && c.name.length <= 100 && typeof c.value === 'string' && ASIDE_ROUTE_VALUES.has(c.value)).slice(0, 25).map((c: any) => ({ name: c.name, value: c.value }));
  return out.length ? out : fallback.map((c) => ({ ...c }));
}
/** Discord slash-command name: 1-32 chars, lowercase letters/digits/-/_ (unicode letters allowed). */
export const isValidCommandName = (n: unknown): n is string => typeof n === 'string' && /^[-_\p{L}\p{N}]{1,32}$/u.test(n) && n === n.toLowerCase();
function cmdName(v: unknown, fallback: string, field: string): string {
  const s = strOrNull(v);
  if (s === null) return fallback;
  if (isValidCommandName(s)) return s;
  console.warn(`identity: ${field} is not a valid Discord command name; using "${fallback}"`);
  return fallback;
}
/** A description of 1-100 chars (Discord's cap), else the fallback. */
function desc(v: unknown, fallback: string, field: string): string {
  const s = strOrNull(v);
  if (s === null) return fallback;
  if (s.length <= 100) return s;
  console.warn(`identity: ${field} is longer than 100 chars; using the default`);
  return fallback;
}
/**
 * The three slash-command names, validated and distinct. Env overrides win when valid.
 * Any invalid or colliding name falls back to the generic defaults as a set.
 */
export function resolveCommandNames(id: Pick<Identity, 'aside_command' | 'study_command' | 'followup_command'>, env: { ASIDE_COMMAND_NAME?: string; FOLLOWUP_COMMAND_NAME?: string } = {}): { aside: string; study: string; followup: string } {
  const g = GENERIC_IDENTITY;
  const pick = (e: string | undefined, base: string) => (e && isValidCommandName(e) ? e : base);
  const distinct = (o: { aside: string; study: string; followup: string }) => new Set([o.aside, o.study, o.followup]).size === 3;
  const out = { aside: pick(env.ASIDE_COMMAND_NAME, id.aside_command), study: id.study_command, followup: pick(env.FOLLOWUP_COMMAND_NAME, id.followup_command) };
  if (distinct(out)) return out;
  const base = { aside: id.aside_command, study: id.study_command, followup: id.followup_command };
  if (distinct(base)) {
    console.warn('identity: env command-name overrides collide; ignoring them');
    return base;
  }
  console.warn('identity: slash-command names collide; using the generic defaults');
  return { aside: g.aside_command, study: g.study_command, followup: g.followup_command };
}

/** A regex source that compiles, or null (with a warning) so a typo cannot crash startup. */
function regexSource(v: unknown, field: string): string | null {
  const src = strOrNull(v);
  if (src === null) return null;
  try {
    new RegExp(src, 'i');
    return src;
  } catch {
    console.warn(`identity: ${field} is not a valid regex; ignoring it`);
    return null;
  }
}

/** A date string that parses, or null (with a warning). Null leaves a time gate closed, never open. */
function dateSource(v: unknown, field: string): string | null {
  const s = strOrNull(v);
  if (s === null) return null;
  if (Number.isFinite(Date.parse(s))) return s;
  console.warn(`identity: ${field} is not a valid date; the gate stays closed until it is fixed`);
  return null;
}

/** Read the `identity` block of a house config. Anything missing or malformed stays generic. */
export function parseIdentity(raw: any): Identity {
  const g = GENERIC_IDENTITY;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return structuredClone(g);
  const tk = raw.trigger_keys ?? {};
  const dt = raw.default_triggers ?? {};
  const care = raw.care ?? {};
  const rt = raw.runtime ?? {};
  const gate = raw.name_gate ?? {};
  const text: Record<string, string> = {};
  if (raw.text && typeof raw.text === 'object') {
    for (const [k, v] of Object.entries(raw.text)) if (typeof v === 'string') text[k] = v;
  }
  return {
    owner_name: str(raw.owner_name, g.owner_name),
    owner_label: str(raw.owner_label, g.owner_label),
    bot_name: str(raw.bot_name, g.bot_name),
    bot_full_name: str(raw.bot_full_name, str(raw.bot_name, g.bot_full_name)),
    bot_role: str(raw.bot_role, g.bot_role),
    bot_label: str(raw.bot_label, g.bot_label),
    owner_user_id_env: strOrNull(raw.owner_user_id_env),
    ...(() => {
      const n = resolveCommandNames({
        aside_command: cmdName(raw.aside_command, g.aside_command, 'aside_command'),
        study_command: cmdName(raw.study_command, g.study_command, 'study_command'),
        followup_command: cmdName(raw.followup_command, g.followup_command, 'followup_command'),
      });
      return { aside_command: n.aside, study_command: n.study, followup_command: n.followup };
    })(),
    aside_choices: choices(raw.aside_choices, g.aside_choices),
    aside_to_description: desc(raw.aside_to_description, g.aside_to_description, 'aside_to_description'),
    followup_description: desc(raw.followup_description, g.followup_description, 'followup_description'),
    trigger_keys: { owner: str(tk.owner, g.trigger_keys.owner), bot: str(tk.bot, g.trigger_keys.bot) },
    default_triggers: { owner: list(dt.owner, g.default_triggers.owner), bot: list(dt.bot, g.default_triggers.bot) },
    owner_family: list(raw.owner_family, g.owner_family),
    precheck_fallback: list(raw.precheck_fallback, g.precheck_fallback),
    reach_names: list(raw.reach_names, g.reach_names),
    intimate_tells: regexSource(raw.intimate_tells, 'intimate_tells'),
    reserved_names: regexSource(raw.reserved_names, 'reserved_names'),
    name_gate: { terms: list(gate.terms, []), until: dateSource(gate.until, 'name_gate.until') },
    care: {
      persona_name: str(care.persona_name, g.care.persona_name),
      actor_owner: str(care.actor_owner, g.care.actor_owner),
      actor_other: str(care.actor_other, g.care.actor_other),
      webhook_env: strOrNull(care.webhook_env),
      interactions_path: str(care.interactions_path, g.care.interactions_path),
      reaction_field: str(care.reaction_field, g.care.reaction_field),
    },
    runtime: {
      log_basename: str(rt.log_basename, g.runtime.log_basename),
      mcp_server_name: str(rt.mcp_server_name, g.runtime.mcp_server_name),
      lock_file: str(rt.lock_file, g.runtime.lock_file),
    },
    text,
  };
}
