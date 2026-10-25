// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * reply-as.ts — "Reply as <bot>" (Owner, 22 Oct 2026).
 *
 * A USER-INSTALLED message context-menu command (right-click a message, Apps): it works in servers
 * the bot is NOT in, because the message arrives inside the interaction itself. The owner points at
 * one message; the bot drafts a reply through Sanctum (public register, never the owner's reserved
 * register), shows it PRIVATELY with Post / Discard buttons, and only on Post sends a PUBLIC
 * follow-up on the same interaction, quoting the message with a jump link and pinging nobody.
 *
 * The command's name comes from the deployment's identity (default "Reply as <bot name>").
 */
import { identity } from './config/identity.js';
import type { Identity } from './config/identity-defaults.js';
import { ownerPointedImages, toMessageAttachments, describeFiles, type MessageAttachment } from './attachments.js';
import { HIDDEN_CONTEXT_CARD_LINE } from './hidden-context.js';
import { wasDowngradedToPrivate, withStatus, plainFailureReason, ASIDE_QUESTION_MAX, massPingReason } from './aside.js';

export { wasDowngradedToPrivate };

export const REPLY_DISCARD_PREFIX = 'reply-drop:';
export const REPLY_POST_PREFIX = 'reply-post:';
export const REPLY_DRAFT_TTL_MS = 15 * 60_000;      // a Discord interaction token lives 15 min
export const REPLY_QUOTE_MAX = 80;
const DISCORD_MAX = 2000;
const BODY_MAX = 1800;                               // leaves room for the draft's status lines
export const REPLY_OUTSIDE_APPS_HINT = "If this server doesn't allow outside apps, only you will see it.";
export const REPLY_EXPIRED = 'This draft expired; right-click the message again.';
export const EPHEMERAL = 1 << 6;

/** Nothing in a reply ever pings anyone. */
export const REPLY_ALLOWED_MENTIONS = { parse: [] as string[] };

/** Discord application-command body. type 3 = message context menu; integration_types [1] = user install; contexts 0,1,2 = guild, bot DM, private channel. */
export function replyCommand(name: string) {
  return { name, type: 3, integration_types: [1], contexts: [0, 1, 2] };
}
export function replyCommandFor(id: Identity = identity) {
  return replyCommand(id.reply_command);
}

/** Only the owner may use it. */
export function isReplyOwner(userId: string | null | undefined, ownerUserId: string | null | undefined): boolean {
  return Boolean(ownerUserId) && userId === ownerUserId;
}

/** Markdown in a quoted line shows as typed, not as formatting. */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\*_~|`>#[\]()]/g, '\\$&');
}

/** Ids never go into the text: mention tags, channel tags and custom emoji become plain words. */
export function plainMentions(s: string): string {
  return s
    .replace(/<@&\d+>/g, '@role')
    .replace(/<@!?\d+>/g, '@someone')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/@(everyone|here)\b/gi, '@​$1');
}

/** The first ~80 characters of a message on a word boundary, whitespace collapsed, markdown escaped. */
export function quoteSnippet(content: string, max: number = REPLY_QUOTE_MAX): string {
  const flat = plainMentions(String(content ?? '')).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return escapeMarkdown(flat);
  let cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  if (space >= Math.floor(max / 2) && flat[max] !== ' ') cut = cut.slice(0, space);
  return `${escapeMarkdown(cut.trimEnd())}…`;
}

const SNOWFLAKE = /^\d{15,25}$/;
/** https://discord.com/channels/<guild or @me>/<channel>/<message>; null when an id is not a snowflake. */
export function jumpLink(guildId: string | null | undefined, channelId: string, messageId: string): string | null {
  if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(messageId)) return null;
  if (guildId != null && guildId !== '' && !SNOWFLAKE.test(guildId)) return null;
  return `https://discord.com/channels/${guildId ? guildId : '@me'}/${channelId}/${messageId}`;
}

/** The public post: quote line, jump link, blank line, the reply. Fitted to Discord's 2000. */
export function formatPublicReply(o: { authorName: string; content: string; guildId?: string | null; channelId: string; messageId: string; reply: string }): string {
  const name = escapeMarkdown(plainMentions(o.authorName).replace(/\s+/g, ' ').trim()) || 'someone';
  const link = jumpLink(o.guildId, o.channelId, o.messageId);
  const head = `> **${name}**: ${quoteSnippet(o.content)}${link ? `\n${link}` : ''}`;
  const room = DISCORD_MAX - head.length - 2;
  // A plain channel post would ping a tagged user, so user tags become words here (the preview shows the same); everyone/here/role pings are left for the guard to refuse.
  const reply = o.reply.replace(/<@!?\d+>/g, '@someone').trim();
  return `${head}\n\n${reply.length > room ? `${reply.slice(0, Math.max(0, room - 1))}…` : reply}`;
}

export function replyButtons(id: string) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 1, label: 'Post to channel', custom_id: `${REPLY_POST_PREFIX}${id}` },
      { type: 2, style: 2, label: 'Discard', custom_id: `${REPLY_DISCARD_PREFIX}${id}` },
    ],
  }];
}

export interface ReplyDraft {
  /** The full public text, quote and link included. */
  text: string;
  /** Just the reply, which is what the public-register guard reads. */
  reply: string;
  /** The channel the message was in; Post sends there as a plain channel message when the bot can. */
  channelId?: string;
  /** The clicked message: the plain post attaches to it as a native Discord reply, so the thread line shows. */
  targetMessageId?: string;
  /** Fallback when the bot cannot send in that channel: a public follow-up on the command's own interaction (shown as a reply to the clicked message). */
  followUp(opts: { content: string; allowedMentions: { parse: string[] } }): Promise<unknown>;
  /** Called with the sent message after a successful post (audit record). Never allowed to fail the post. */
  onPosted?(sent: unknown): void;
  /** Set after a draft is recorded in the aside history: Post marks that entry posted. */
  markPosted?(): void;
  expiresAt: number;
}

/** Drafts waiting for a tap. In-process only; the interaction token's life bounds them. */
export class ReplyMemory {
  private drafts = new Map<string, ReplyDraft>();
  constructor(private now: () => number = Date.now) {}
  /** `startedAt` is when the command was used: the interaction token's 15 minutes run from then, not from when the draft is ready. */
  put(id: string, draft: Omit<ReplyDraft, 'expiresAt'>, startedAt: number = this.now()): void {
    this.prune();
    this.drafts.set(id, { ...draft, expiresAt: startedAt + REPLY_DRAFT_TTL_MS });
  }
  /** One-shot: a draft can be posted or discarded once, never twice. */
  take(id: string): ReplyDraft | null {
    this.prune();
    const d = this.drafts.get(id) ?? null;
    this.drafts.delete(id);
    return d;
  }
  restore(id: string, draft: ReplyDraft): void { this.drafts.set(id, draft); }
  private prune(): void {
    const t = this.now();
    for (const [id, d] of this.drafts) if (d.expiresAt <= t) this.drafts.delete(id);
  }
}

export interface ReplyTargetMessage {
  id: string;
  content?: string | null;
  channelId?: string | null;
  guildId?: string | null;
  author?: { id?: string; username?: string; globalName?: string | null } | null;
  member?: { displayName?: string | null } | null;
  /** The message's attachments (a discord.js collection or a plain list); read only because the owner pointed at this message. */
  attachments?: unknown;
  /** The message this one replies to (id only; Discord sends the rest with the click where it can). */
  reference?: { messageId?: string | null } | null;
}

export interface ReplyCommandLike {
  commandName: string;
  user: { id: string };
  channelId: string | null;
  guildId?: string | null;
  /** The interaction id. */
  id?: string;
  /** The cached channel (null in a server the bot is not in). */
  channel?: { name?: unknown } | null;
  targetId?: string;
  targetMessage?: ReplyTargetMessage | null;
  /** The command's resolved data: the target author's member (server nickname) lives here in servers the bot is not in. */
  options?: { resolved?: { members?: { get?(id: string): { nick?: string | null; displayName?: string | null } | null | undefined } | null } | null } | null;
  /** When the command was used (ms); the interaction token's 15 minutes start here. */
  createdTimestamp?: number;
  isMessageContextMenuCommand?(): boolean;
  reply(opts: { content: string; flags: number }): Promise<unknown>;
  deferReply(opts: { flags: number }): Promise<unknown>;
  editReply(opts: { content: string; components?: unknown[] }): Promise<unknown>;
  followUp(opts: { content: string; allowedMentions?: { parse: string[] } }): Promise<unknown>;
}

export interface ReplyCommandDeps {
  commandName: string;
  ownerUserId: string | null;
  memory: ReplyMemory;
  /** The reply for one message, drafted through Sanctum. text null = nothing came back. */
  generate(authorName: string, content: string, guildId: string | null, context: string, images?: MessageAttachment[], hidden?: boolean): Promise<{ text: string | null; ctx?: unknown; modelChainExhausted?: boolean }>;
  /**
   * The context block for this message (messages around it, the message it replies to, the owner's tagged
   * messages), as data for the prompt. '' = none. Never allowed to fail the reply.
   */
  context?(info: { target: ReplyTargetMessage; channelId: string; guildId: string | null; ownerUserId: string }): Promise<string | { block: string; attachments?: MessageAttachment[]; hidden?: number }>;
  /**
   * The channel's aside history (the same instance /aside and /followup use), so a /followup after a Reply as
   * carries the exchange. Entries hold names and text only, never tokens or functions.
   */
  history?: { addTurn(channelId: string, turn: { question: string; note: string; proposal: string | null }): object; markPosted(channelId: string, turn: any): boolean;
    /** Registers this right-click as the channel's latest origin, so a later /followup can post through it. */
    noteOrigin?(channelId: string, origin: { followUp(opts: { content: string; allowedMentions?: { parse: string[] } }): Promise<unknown>; startedAt: number; targetMessageId: string; targetAuthorName: string }): void };
  /** Records the posted message's generation context (id from the sent message). */
  registerPosted?(messageId: string, ctx: unknown): void;
  newId(): string;
  log(message: string, data?: Record<string, unknown>): void;
}

const fit = (s: string) => (s.length > DISCORD_MAX ? `${s.slice(0, DISCORD_MAX - 1)}…` : s);

/**
 * The name people see in that server: the server nickname first. Where the bot is not a member, the
 * message's own member is empty, but Discord sends the author's member data beside the click
 * (`resolved.members`), as a GuildMember or a raw `{ nick }`; read it there.
 */
export function displayNameOf(m: ReplyTargetMessage, resolvedMember?: { nick?: string | null; displayName?: string | null } | null): string {
  return (m.member?.displayName || resolvedMember?.nick || resolvedMember?.displayName || m.author?.globalName || m.author?.username || 'someone').toString();
}

/** Cap the post to what the preview shows, so nothing unseen can go public. */
export function capToPreview(text: string): string {
  return text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text;
}

/** What the owner sees while deciding. */
export function renderReplyDraft(publicText: string, hidden = false): string {
  // The ignore-list note is for the owner's card only; the public text never carries it.
  const note = hidden ? `\n*${HIDDEN_CONTEXT_CARD_LINE}*` : '';
  return fit(`**Draft** (only you see this):\n${publicText.slice(0, BODY_MAX)}\n\n*${REPLY_OUTSIDE_APPS_HINT}*${note}`);
}

/** Returns true when the interaction was the reply command (handled), false otherwise. */
export async function handleReplyCommand(interaction: ReplyCommandLike, deps: ReplyCommandDeps): Promise<boolean> {
  if (interaction.commandName !== deps.commandName) return false;
  if (interaction.isMessageContextMenuCommand && !interaction.isMessageContextMenuCommand()) return false;
  if (!isReplyOwner(interaction.user.id, deps.ownerUserId)) {
    deps.log(`reply command refused — not ${identity.owner_name}`, { userId: interaction.user.id });
    await interaction.reply({ content: 'Not available.', flags: EPHEMERAL });
    return true;
  }
  const msg = interaction.targetMessage;
  const channelId = msg?.channelId ?? interaction.channelId;
  if (!msg || !msg.id || !channelId) {
    await interaction.reply({ content: "I couldn't read that message.", flags: EPHEMERAL });
    return true;
  }
  const content = (msg.content ?? '').trim();
  // Owner-pointed (Part 3): the clicked message's attachments travel with it, so an image-only message is answerable.
  const targetAttachments = toMessageAttachments(msg.attachments);
  if (!content && !targetAttachments.length) {
    await interaction.reply({ content: 'That message has no text for me to answer.', flags: EPHEMERAL });
    return true;
  }
  const guildId = interaction.guildId ?? msg.guildId ?? null;
  // Acknowledge first, privately: Discord allows 3 s and the model call takes longer.
  await interaction.deferReply({ flags: EPHEMERAL });
  const authorId = msg.author?.id;
  const resolvedMember = authorId ? interaction.options?.resolved?.members?.get?.(authorId) ?? null : null;
  const authorName = displayNameOf(msg, resolvedMember);
  try { deps.history?.noteOrigin?.(channelId, { followUp: (o) => interaction.followUp(o), startedAt: interaction.createdTimestamp ?? Date.now(), targetMessageId: msg.id, targetAuthorName: authorName }); }
  catch (err: any) { deps.log('reply origin record failed', { error: err?.message }); }
  try {
    let context = '';
    let pointed: MessageAttachment[] = [];
    let hidden = false;
    if (deps.context) {
      try {
        const got = await deps.context({ target: msg, channelId, guildId, ownerUserId: interaction.user.id });
        if (typeof got === 'string') context = got; else { context = got.block; pointed = got.attachments ?? []; hidden = (got.hidden ?? 0) > 0; }
      } catch (err: any) { deps.log('reply context failed; replying without it', { error: err?.message }); }
    }
    // Images the owner pointed at (the clicked message first, then tagged and reply-chain ones) go to the model's vision chain.
    const images = ownerPointedImages([...targetAttachments, ...pointed]);
    const files = describeFiles(targetAttachments);
    const promptContent = [content, ...files].filter(Boolean).join('\n') || '(an image)';
    const res = await deps.generate(authorName, promptContent, guildId, context, images, hidden);
    const reply = (res.text ?? '').trim();
    if (!reply) {
      await interaction.editReply({ content: res.modelChainExhausted ? 'No model answered just now. Right-click the message again in a moment.' : 'Nothing came back. Right-click the message again in a moment.', components: [] });
      return true;
    }
    // The preview shows BODY_MAX characters; cap the stored post to the same, so Post publishes exactly what was shown.
    const text = capToPreview(formatPublicReply({ authorName, content: content || '(attachment)', guildId, channelId, messageId: msg.id, reply }));
    // What goes public is the text after the quote block; history records exactly that, not the untruncated model reply.
    const sep = text.indexOf('\n\n');
    const posted = sep >= 0 ? text.slice(sep + 2).trim() : reply;
    const id = deps.newId();
    const ctx = res.ctx;
    const onPosted = ctx !== undefined && deps.registerPosted
      ? (sent: unknown) => { const mid = (sent as any)?.id; if (mid) deps.registerPosted!(String(mid), ctx); }
      : undefined;
    // The aside history is what /followup reads: record the exchange as /aside would (owner's turn, then the draft).
    let markPosted: (() => void) | undefined;
    if (deps.history) {
      try {
        const n = context ? context.split('\n').filter((l) => l.trim()).length : 0;
        // Only WHICH message, never its text: this slot is read later as the owner's own words, and guest text must not
        // reach a /followup (or a Study session) that way (commit security review, 22 Oct). The draft carries the gist.
        const question = `[Reply as, on ${authorName}'s message${n ? `; ${n} context lines` : ''}]`.slice(0, ASIDE_QUESTION_MAX);
        const turn = deps.history.addTurn(channelId, { question, note: posted, proposal: posted });
        markPosted = () => { deps.history!.markPosted(channelId, turn); };
      } catch (err: any) { deps.log('reply history record failed', { error: err?.message }); }
    }
    deps.memory.put(id, { text, reply: posted, channelId, targetMessageId: msg.id, followUp: (o) => interaction.followUp(o), onPosted, markPosted }, interaction.createdTimestamp ?? undefined);
    await interaction.editReply({ content: renderReplyDraft(text, hidden), components: replyButtons(id) });
    deps.log('reply draft ready', { channelId });
  } catch (err: any) {
    // The interaction is already deferred; never leave it on "thinking".
    deps.log('reply command failed after defer', { error: err?.message });
    try {
      await interaction.editReply({ content: 'Something went wrong drafting that. Right-click the message again in a moment.', components: [] });
    } catch (e2: any) {
      deps.log('reply error edit failed', { error: e2?.message });
    }
  }
  return true;
}

export interface ReplyButtonLike {
  customId: string;
  user: { id: string };
  reply(opts: { content: string; flags: number }): Promise<unknown>;
  deferUpdate(): Promise<unknown>;
  editReply(opts: { content?: string; components?: unknown[] }): Promise<unknown>;
  message?: { content?: string };
}

export interface ReplyButtonDeps {
  ownerUserId: string | null;
  memory: ReplyMemory;
  /** null = safe to post; otherwise a short reason it may not go public. */
  publicGuard(text: string): string | null;
  /**
   * Posts as a plain channel message (no "used command" label). Returns the sent message; 'no-access' = the bot
   * cannot send there (not a member), so the post falls back to the command's follow-up (a reply to the clicked message); null = the send failed and nothing went out.
   */
  post?(channelId: string, text: string, replyToMessageId?: string): Promise<unknown | 'no-access' | null>;
  log(message: string, data?: Record<string, unknown>): void;
}

/** Returns true when the interaction was a reply button (handled), false otherwise. */
export async function handleReplyButton(interaction: ReplyButtonLike, deps: ReplyButtonDeps): Promise<boolean> {
  const isPost = interaction.customId.startsWith(REPLY_POST_PREFIX);
  const isDrop = interaction.customId.startsWith(REPLY_DISCARD_PREFIX);
  if (!isPost && !isDrop) return false;
  deps.log(`reply ${isPost ? 'post' : 'discard'} button clicked`);
  if (!isReplyOwner(interaction.user.id, deps.ownerUserId)) {
    await interaction.reply({ content: 'Not available.', flags: EPHEMERAL });
    return true;
  }
  try {
    await interaction.deferUpdate();
  } catch (err: any) {
    deps.log('reply button could not be acknowledged', { error: err?.message });
    return true;
  }
  try {
    await settleReplyClick(interaction, deps, isPost);
  } catch (err: any) {
    deps.log('reply button failed', { error: err?.message });
    try {
      await interaction.editReply({ content: withStatus(interaction.message?.content, `*Couldn't post here: ${plainFailureReason(err)}.*`), components: [] });
    } catch (e2: any) {
      deps.log('reply button failure note could not be shown', { error: e2?.message });
    }
  }
  return true;
}

async function settleReplyClick(interaction: ReplyButtonLike, deps: ReplyButtonDeps, isPost: boolean): Promise<void> {
  const id = interaction.customId.slice((isPost ? REPLY_POST_PREFIX : REPLY_DISCARD_PREFIX).length);
  const draft = deps.memory.take(id);
  const was = interaction.message?.content;
  if (!draft) {
    await interaction.editReply({ content: withStatus(was, `*${REPLY_EXPIRED}*`), components: [] });
    return;
  }
  if (!isPost) {
    await interaction.editReply({ content: withStatus(was, '*Discarded. Nothing was posted.*'), components: [] });
    return;
  }
  const reason = deps.publicGuard(draft.reply) ?? massPingReason(draft.text);
  if (reason) {
    deps.log('reply post refused by the public guard', { reason });
    await interaction.editReply({ content: withStatus(was, `*Not posted: ${reason}. Right-click the message to draft another.*`), components: [] });
    return;
  }
  let sent: unknown;
  try {
    const plain = deps.post && draft.channelId ? await deps.post(draft.channelId, draft.text, draft.targetMessageId) : 'no-access';
    if (plain === null) {
      // Nothing was sent, so the draft stays usable.
      deps.memory.restore(id, draft);
      await interaction.editReply({ content: withStatus(was, "*Couldn't post here: the send failed and nothing was sent. Try the button again.*") });
      return;
    }
    // Where the bot is not a member the only public route is the command's own follow-up. For this message command Discord shows it
    // as a reply to the clicked message with the APP badge (no "used command" line; the owner's screenshot, 22 Oct 16:56).
    sent = plain === 'no-access' ? await draft.followUp({ content: draft.text, allowedMentions: REPLY_ALLOWED_MENTIONS }) : plain;
  } catch (err: any) {
    deps.log('reply post threw', { error: err?.message });
    // The request may have reached Discord before the error, so a retry could post twice. The draft is spent.
    await interaction.editReply({ content: withStatus(was, '*I could not confirm the post. Check the channel before drafting again; I will not retry on my own.*'), components: [] });
    return;
  }
  if (wasDowngradedToPrivate(sent)) {
    deps.log('reply post was shown only to the owner');
    await confirmReplyPosted(interaction, deps, withStatus(was, "*Posted, but only you can see it: this server doesn't allow outside apps.*"));
    return;
  }
  try { draft.markPosted?.(); } catch (err: any) { deps.log('reply history mark failed', { error: err?.message }); }
  try { draft.onPosted?.(sent); } catch (err: any) { deps.log('reply audit record failed', { error: err?.message }); }
  deps.log('reply posted');
  await confirmReplyPosted(interaction, deps, withStatus(was, '*✓ Posted in the channel.*'));
}

/** After the reply went out, a failure to update the card must never read as "couldn't post" (that invites a double post). */
async function confirmReplyPosted(interaction: { editReply(opts: { content?: string; components?: unknown[] }): Promise<unknown> }, deps: { log(message: string, data?: Record<string, unknown>): void }, content: string): Promise<void> {
  try {
    await interaction.editReply({ content, components: [] });
  } catch (err: any) {
    deps.log('reply posted, but the card could not be updated', { error: err?.message });
  }
}
