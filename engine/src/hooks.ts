// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * hooks.ts — an optional extension point. A deployment can add one module that answers two questions
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
 *   onChannelReply(msg, api)        called for a reply to another message in a channel; true = handled, the engine
 *                                   does nothing more with it.
 *   authorNotes(authors)            one short note per author in a window, keyed by `authorNoteKey(author)`.
 *
 * The provider socket: when a plug in the deployment config is `custom`, the engine asks this module for the
 * implementation. `modelProvider(opts)` (plugs.model), `settingsStore(opts)` (plugs.settings) and
 * `contextSink(opts)` (plugs.memory) return the engine's own interfaces; `auditSink(opts)` is optional and
 * switches the audit-log copy on. A plug set to `custom` without its function stops the engine at start.
 * Hook code is operator-trusted: it runs with the process's privileges.
 *
 * Where the module lives: the path in the env var TERTULIA_HOOKS_PATH. When that is set but the file is missing
 * or broken, the engine stops at start with an error. When it is not set, `hooks.js` next to this file's compiled
 * output (the build writes it there from the deployment's own layer folder), or that folder's source when this
 * code runs under tsx. Absent = no-op hooks. A module found that way and broken is logged loudly and the engine
 * runs on the no-op hooks.
 */
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logger } from './logger.js';
import { hooksFileCandidates, noteHooksFile } from './config/legacy-names.js';
import type { ModelProvider, ModelTarget } from './seams/model-provider.js';
import type { SettingsStore } from './seams/settings-store.js';
import type { MemoryProvider } from './seams/memory-provider.js';

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
export interface HooksApi {
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

/** What the socket hands every provider function. */
export interface ProviderOptions {
  env: NodeJS.ProcessEnv;
  /** The deployment config file's `custom` object, untouched: the layer's own settings. */
  config: Record<string, unknown>;
  /** The per-call model timeout the engine wants honoured. */
  timeoutMs: number;
  /** The first model of the text chain (PRESENCE_PRIMARY_MODEL). */
  primaryTarget: ModelTarget;
}

/** Where a copy of the home server's audit log goes. */
export interface AuditSink {
  /** The id of the newest entry the sink holds for this server, or null when it holds none. */
  latest(guildId: string): Promise<string | null>;
  /** Store a batch of at most 100 entries; resolves to how many were stored. Must ignore ids it already holds. */
  post(guildId: string, entries: unknown[]): Promise<number>;
}

/** One person in a window, as the transcript names them. */
export interface AuthorInfo {
  id: string;
  /** Server nickname, else display name, else username; a webhook post's persona name. */
  shownName: string;
  username: string;
  isWebhook: boolean;
  isBot: boolean;
}

/** The key a note is returned under: the id and the shown name, so one bot account speaking for several people keeps one note each. */
export function authorNoteKey(a: Pick<AuthorInfo, 'id' | 'shownName'>): string {
  return `${a.id}|${a.shownName}`;
}

/** A reply to a message in a channel. Plain data. */
export interface ChannelReply {
  id: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorIsOwner: boolean;
  content: string;
}

export interface Hooks {
  modelProvider?(opts: ProviderOptions): ModelProvider;
  settingsStore?(opts: ProviderOptions): SettingsStore;
  contextSink?(opts: ProviderOptions): MemoryProvider;
  auditSink?(opts: ProviderOptions): AuditSink;
  authorNotes?(authors: AuthorInfo[]): Promise<Record<string, string>> | Record<string, string>;
  onChannelReply?(msg: ChannelReply, api: HooksApi): Promise<boolean> | boolean;
  hideMessage?(m: MessageFacts): boolean;
  hideAuthor?(authorId: string): boolean;
  revealAuthor?(authorId: string): boolean;
  onDirectMessage?(msg: DirectMessage, api: HooksApi): Promise<DirectMessageOutcome>;
}

export const NOOP_HOOKS: Hooks = Object.freeze({});

let active: Hooks = NOOP_HOOKS;

// A hook that throws on every message would flood the log: each distinct error is logged once per loaded module.
const loggedHookErrors = new Set<string>();
function logHookErrorOnce(hook: string, err: any): void {
  const key = `${hook}:${err?.message}`;
  if (loggedHookErrors.has(key) || loggedHookErrors.size >= 100) return;
  loggedHookErrors.add(key);
  logger.error('Hooks', `${hook} threw (treated as false)`, { error: err?.message });
}

export function setHooks(h: Hooks | null | undefined): void {
  active = h ?? NOOP_HOOKS;
  loggedHookErrors.clear();
}

export function getHooks(): Hooks {
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

/** True when a module is loaded that supplies author notes. */
export function hooksCanNoteAuthors(): boolean {
  return typeof active.authorNotes === 'function';
}

/**
 * The hook's notes for these authors, keyed by `authorNoteKey`. A hook that is absent, throws or answers with
 * something that is not an object gives null (the prompt section is left out); a throw is logged once.
 */
export async function hookAuthorNotes(authors: AuthorInfo[]): Promise<Record<string, string> | null> {
  if (typeof active.authorNotes !== 'function') return null;
  try {
    const out = await active.authorNotes(authors);
    return out && typeof out === 'object' && !Array.isArray(out) ? out : null;
  } catch (err: any) {
    logHookErrorOnce('authorNotes', err);
    return null;
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

function looksLikeHooks(v: any): v is Hooks {
  return Boolean(v) && typeof v === 'object'
    && (v.hideAuthor === undefined || typeof v.hideAuthor === 'function')
    && (v.hideMessage === undefined || typeof v.hideMessage === 'function')
    && (v.revealAuthor === undefined || typeof v.revealAuthor === 'function')
    && (v.onDirectMessage === undefined || typeof v.onDirectMessage === 'function')
    && PROVIDER_FUNCTIONS.every((k) => v[k] === undefined || typeof v[k] === 'function');
}

const PROVIDER_FUNCTIONS = ['modelProvider', 'settingsStore', 'contextSink', 'auditSink', 'authorNotes', 'onChannelReply'] as const;

/** Where to look, in order. The source candidate only counts when this code itself runs from source. */
export function hookCandidates(here: string = fileURLToPath(import.meta.url)): string[] {
  return hooksFileCandidates(dirname(here), here.endsWith('.ts'), join);
}

/** The hooks file named by TERTULIA_HOOKS_PATH, or null when the variable is unset. */
export function hooksPathFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const p = (env.TERTULIA_HOOKS_PATH || '').trim();
  return p ? resolve(p) : null;
}

/**
 * Load the module if one exists. Returns the hooks now active. `candidates` and `importer` are for tests.
 * When `explicit` (TERTULIA_HOOKS_PATH) is given the file must exist and load, or this throws: a path someone
 * set on purpose never falls back to no hooks quietly.
 */
export async function loadHooks(
  candidates: string[] = hookCandidates(),
  importer: (url: string) => Promise<any> = (u) => import(u),
  explicit: string | null = hooksPathFromEnv(),
): Promise<Hooks> {
  if (explicit && !existsSync(explicit)) {
    throw new Error(`TERTULIA_HOOKS_PATH is set to ${explicit}, but no file is there. Fix the path or unset the variable.`);
  }
  const file = explicit ?? candidates.find((c) => existsSync(c));
  if (!file) { setHooks(null); return active; }
  try {
    noteHooksFile(file);
    const mod = await importer(pathToFileURL(file).href);
    const hooks = mod?.hooks ?? mod?.default;
    if (!looksLikeHooks(hooks)) throw new Error('module exports no `hooks` object whose members are all functions');
    setHooks(hooks);
    logger.info('Hooks', 'loaded', { file });
  } catch (err: any) {
    if (explicit) throw new Error(`TERTULIA_HOOKS_PATH ${file} failed to load: ${err?.message}`);
    logger.error('Hooks', 'module present but failed to load (running without it)', { file, error: err?.message });
    setHooks(null);
  }
  return active;
}
