// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { Message, MessageReferenceType } from 'discord.js';
import { isIgnoredAuthor } from '../presence-config.js';
import type { WindowMessage } from '../presence-engine.js';

export interface MentionEvent {
  channelId: string;
  channelName: string;
  guildName: string | null;
  authorId: string;
  authorTag: string;
  content: string;
  timestamp: Date;
  message: Message;
  isDM?: boolean;
}

/** Context Log scope (Owner, 2026-07-18): bot replies are the independent rows.
 * Human/guest messages belong inside the reply's captured Discord context. */
export function shouldCollectContextLogMessage(authorId: string, botUserId: string | null): boolean {
  return Boolean(botUserId && authorId === botUserId);
}

/** Structural view of a discord.js Message's reply pointer — narrow on purpose
 *  so tests can hand in a plain object and a real `Message` still satisfies it.
 *  (Both directions verified against discord.js 14.24.2 typings.) */
export interface ReferenceCarrier {
  reference?: { messageId?: string | null; channelId?: string | null; guildId?: string | null; type?: number } | null;
}

export interface ReplyReference { messageId: string; channelId: string; guildId?: string }

/** The parent id when this message is a genuine REPLY.
 *  Forwards (MessageReferenceType.Forward) carry a reference too and are NOT
 *  replies. Anything not explicitly a Forward counts — never `=== Default`,
 *  which would drop any reply whose `type` the payload omits. */
export function replyParentId(message: ReferenceCarrier | null | undefined): string | undefined {
  const ref = message?.reference;
  if (!ref?.messageId) return undefined;
  if (ref.type === MessageReferenceType.Forward) return undefined;
  return ref.messageId;
}

/** The reply pointer as a read-tool field; omitted entirely for non-replies. */
export function toReplyReference(message: ReferenceCarrier | null | undefined): ReplyReference | undefined {
  const messageId = replyParentId(message);
  const ref = message?.reference;
  if (!messageId || !ref?.channelId) return undefined;
  return { messageId, channelId: ref.channelId, guildId: ref.guildId ?? undefined };
}

/** Whether THIS bot was addressed. `@everyone`/`@here` is an announcement to a
 *  room, not someone talking to me — discord.js `MessageMentions#has` counts it
 *  as a mention by default, which is how an announcement became a 'pending
 *  mention' the sweep then threaded a reply onto (REPRODUCED in a harness on
 *  the current tree: an @everyone post received a threaded reply). Role
 *  mentions and replied-user still count: my roles are mine, and a reply to my
 *  own message IS addressing me. */
export interface MentionLookup {
  has(target: string, options?: { ignoreEveryone?: boolean }): boolean;
}
export function mentionsBot(mentions: MentionLookup, botUserId: string | null): boolean {
  return botUserId ? mentions.has(botUserId, { ignoreEveryone: true }) : false;
}

/** The id of the newest message in the window that is not mine — the
 *  conversational tail a freshly generated reply is actually answering.
 *  `undefined` (send unthreaded) rather than any stale fallback. Windows on
 *  this path are sorted oldest-first, so the last match is the newest.
 *
 *  BOUND (verified): on the ambient-mention path the triggering mention is
 *  itself in the window and is non-bot, so this can never resolve OLDER than
 *  the mention — the anchor only ever moves forward, never backward.
 *
 *  `ignored` (Owner, 2026-08-29) — an ignored author's message is skipped
 *  exactly like the bot's own: a reply must never anchor onto someone the
 *  bot never answers. Defaults to `[]` so every pre-existing caller that
 *  passes no list behaves byte-identically to before. */
export function newestNonBotMessageId(window: WindowMessage[], ignored: string[] = []): string | undefined {
  return window
    .filter((message) => !message.isFromMe && message.id && !isIgnoredAuthor(message.authorId, ignored))
    .at(-1)?.id;
}

export interface ChannelInfo {
  id: string;
  name: string;
  type: string;
  position: number;
  /** Position of the containing category, so a page can order the groups; absent when uncategorized. */
  category_position?: number;
}

export interface CategoryInfo {
  id: string;
  name: string;
  position: number;
  channels: ChannelInfo[];
}

export interface ServerChannels {
  serverName: string;
  serverId: string;
  categories: CategoryInfo[];
  uncategorized: ChannelInfo[];
}

export interface FileAttachment {
  file: Buffer | string;
  name?: string;
  description?: string;
}

/** Options accepted by `considerChannel` — the sweep supplies `window`; soft-presence supplies `triggerMessage`/`claimMessageId`. */
export interface ConsiderChannelOpts {
  triggerMessage?: WindowMessage;
  claimMessageId?: string;
  window?: WindowMessage[];
}
