// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * house-hooks.ts — an optional extension point. A deployment can add one module that answers two questions
 * the engine asks, and the engine runs the same with no module at all.
 *
 *   hideAuthor(authorId)            true = treat this author like any other author the engine already leaves
 *                                   out of what the model sees (one gate, every place that strips authors).
 *   revealAuthor(authorId)          true = show this author as a normal author, even when the engine's own list
 *                                   or hideAuthor would hide them (checked first, at the same one gate).
 *   hideMessage(facts)              true = leave this one message out exactly like a hidden author's message (ingress,
 *                                   history fetch, every window strip). Facts are plain data.
 *   onDirectMessage(msg, api)       called for a message that mentions the bot or replies to it, before the
 *                                   mention path runs. The answer says what happens next.
 *
 * Where the module lives: `house.hooks.js` next to this file's compiled output (the build writes it there from
 * the deployment's own layer folder), or that folder's source when this code runs under tsx. Absent = no-op hooks.
 * A module that is present but broken is logged loudly and the engine runs on the no-op hooks.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logger } from './logger.js';

/** The facts about one direct message. Plain data: no discord.js objects cross this line. */
export interface DirectMessage {
  id: string;
  channelId: string;
  channelName: string;
  guildId: string | null;
  authorId: string;
  authorName: string;
  content: string;
  isMention: boolean;
  isReplyToBot: boolean;
  timestampMs: number;
  /** A jump link to the message. */
  link: string;
}

/** What a hook may do. Each call is best-effort and never throws. */
export interface HouseHooksApi {
  /** Add one reaction to the message. Resolves true when it landed. */
  react(emoji: string): Promise<boolean>;
  /** Send the owner a private message. */
  dmOwner(text: string): Promise<void>;
  /** A one-line quote of text, flattened and capped, safe to put inside a message. */
  quote(text: string): string;
  now(): number;
}

/** 'handled' = the engine does nothing more with this message. 'continue' = the engine carries on as it would. */
export type DirectMessageOutcome =
  | 'handled'
  | 'continue'
  /** Answer from this one message alone: no surrounding messages, no reply chain, no tags. `note` is one extra line for the prompt. `onDelivery` is told afterwards whether the reply actually went out. */
  | { replyWithOnly: true; note?: string; onDelivery?: (delivered: boolean) => void | Promise<void> };

/** Plain facts about one guest message, for hideMessage. */
export interface MessageFacts {
  authorId: string;
  content: string;
  mentionsBot: boolean;
  repliesToBot: boolean;
  /** Milliseconds since the bot last spoke in this channel (before this message), or null when unknown. */
  msSinceBotSpokeInChannel: number | null;
}

export interface HouseHooks {
  hideMessage?(m: MessageFacts): boolean;
  hideAuthor?(authorId: string): boolean;
  revealAuthor?(authorId: string): boolean;
  onDirectMessage?(msg: DirectMessage, api: HouseHooksApi): Promise<DirectMessageOutcome>;
}

export const NOOP_HOOKS: HouseHooks = Object.freeze({});

let active: HouseHooks = NOOP_HOOKS;

// A hook that throws on every message would flood the log: each distinct error is logged once per loaded module.
const loggedHookErrors = new Set<string>();
function logHookErrorOnce(hook: string, err: any): void {
  const key = `${hook}:${err?.message}`;
  if (loggedHookErrors.has(key) || loggedHookErrors.size >= 100) return;
  loggedHookErrors.add(key);
  logger.error('HouseHooks', `${hook} threw (treated as false)`, { error: err?.message });
}

export function setHouseHooks(h: HouseHooks | null | undefined): void {
  active = h ?? NOOP_HOOKS;
  loggedHookErrors.clear();
}

export function getHouseHooks(): HouseHooks {
  return active;
}

/** True when a module is loaded that has an opinion on authors (the callers that skip work on an empty list ask this). */
export function hooksCanHideAuthors(): boolean {
  return typeof active.hideAuthor === 'function';
}

/** The hook's answer; a throwing hook hides nobody and says so in the log. */
export function hookHidesAuthor(authorId: string | null | undefined): boolean {
  if (!authorId || typeof active.hideAuthor !== 'function') return false;
  try {
    return active.hideAuthor(authorId) === true;
  } catch (err: any) {
    logHookErrorOnce('hideAuthor', err);
    return false;
  }
}

/** True when a module is loaded that has an opinion on single messages. */
export function hooksCanHideMessages(): boolean {
  return typeof active.hideMessage === 'function';
}

/** The hook's answer for one message; a throwing hook hides nothing and says so in the log. */
export function hookHidesMessage(m: MessageFacts | null | undefined): boolean {
  if (!m || !m.authorId || typeof active.hideMessage !== 'function') return false;
  try {
    return active.hideMessage(m) === true;
  } catch (err: any) {
    logHookErrorOnce('hideMessage', err);
    return false;
  }
}

/** The hook's answer; a throwing hook reveals nobody and says so in the log. */
export function hookRevealsAuthor(authorId: string | null | undefined): boolean {
  if (!authorId || typeof active.revealAuthor !== 'function') return false;
  try {
    return active.revealAuthor(authorId) === true;
  } catch (err: any) {
    logHookErrorOnce('revealAuthor', err);
    return false;
  }
}

function looksLikeHooks(v: any): v is HouseHooks {
  return Boolean(v) && typeof v === 'object'
    && (v.hideAuthor === undefined || typeof v.hideAuthor === 'function')
    && (v.hideMessage === undefined || typeof v.hideMessage === 'function')
    && (v.revealAuthor === undefined || typeof v.revealAuthor === 'function')
    && (v.onDirectMessage === undefined || typeof v.onDirectMessage === 'function');
}

/** Where to look, in order. The source candidate only counts when this code itself runs from source. */
export function hookCandidates(here: string = fileURLToPath(import.meta.url)): string[] {
  const dir = dirname(here);
  const out = [join(dir, 'house.hooks.js')];
  if (here.endsWith('.ts')) out.push(join(dir, '..', '..', 'house', 'hooks.ts'));
  return out;
}

/**
 * Load the module if one exists. Returns the hooks now active. `candidates` and `importer` are for tests.
 */
export async function loadHouseHooks(
  candidates: string[] = hookCandidates(),
  importer: (url: string) => Promise<any> = (u) => import(u),
): Promise<HouseHooks> {
  const file = candidates.find((c) => existsSync(c));
  if (!file) { setHouseHooks(null); return active; }
  try {
    const mod = await importer(pathToFileURL(file).href);
    const hooks = mod?.hooks ?? mod?.default;
    if (!looksLikeHooks(hooks)) throw new Error('module exports no `hooks` object with hideAuthor / hideMessage / onDirectMessage functions');
    setHouseHooks(hooks);
    logger.info('HouseHooks', 'loaded', { file });
  } catch (err: any) {
    logger.error('HouseHooks', 'module present but failed to load (running without it)', { file, error: err?.message });
    setHouseHooks(null);
  }
  return active;
}
