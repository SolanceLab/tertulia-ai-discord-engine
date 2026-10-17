// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * aside.ts — the private aside (Owner, 12 Oct 2026).
 *
 * A USER-INSTALLED slash command (like /study): it exists only in the owner's own slash menu. She asks
 * me something while a channel conversation carries on; I read the channel through the same window
 * every other path uses (mute applied) and answer her PRIVATELY ("Only you can see this"). The
 * answer has two parts: a note to her (never posted) and, when useful, ONE message proposed for
 * the channel, under a "Post to channel" button. Nothing reaches the channel until she taps it,
 * and even then only after the public-register guard passes.
 *
 * The command's name is configurable: a deployment can name it, the default is /aside.
 */
import { identity } from './config/identity.js';
import type { Identity } from './config/identity-defaults.js';

export const ASIDE_POST_PREFIX = 'aside-post:';
export const ASIDE_DEFAULT_NAME = 'aside';
export const ASIDE_DISCARD_PREFIX = 'aside-drop:';
export const ASIDE_DRAFT_TTL_MS = 15 * 60_000;      // a Discord interaction token lives 15 min
export const ASIDE_HISTORY_TTL_MS = 30 * 60_000;
export const ASIDE_HISTORY_MAX = 6;
const DISCORD_MAX = 2000;
export const ASIDE_QUESTION_MAX = 1500;
const EPHEMERAL = 1 << 6;

/** Discord application-command body. integration_types [1] = user install; contexts 0,1,2 = guild, bot DM, private channel. */
export function asideCommand(
  name: string = ASIDE_DEFAULT_NAME,
  to: { description: string; choices: Array<{ name: string; value: string }> } = { description: 'Who answers: the model quickly, or your agent in the background', choices: [{ name: 'Model (quick)', value: 'model' }, { name: 'Agent (your agent, background)', value: 'agent' }] },
) {
  return {
    name,
    type: 1,
    description: 'Ask privately about this channel. Only you see the answer.',
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      { type: 3, name: 'message', description: 'What you want to ask or say', required: true, max_length: ASIDE_QUESTION_MAX },
      { type: 3, name: 'to', description: to.description, required: false, choices: to.choices },
    ],
  };
}

export const FOLLOWUP_DEFAULT_NAME = 'followup';

/** The follow-up command: continues the last private Study answer in this channel. Same shape as the aside. */
export function followupCommand(name: string = FOLLOWUP_DEFAULT_NAME, description: string = 'Continue your last private agent answer in this channel. Only you see it.') {
  return {
    name,
    type: 1,
    description,
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      { type: 3, name: 'message', description: 'What you want to add or ask next', required: true, max_length: ASIDE_QUESTION_MAX },
    ],
  };
}

/** The registered bodies for a deployment's identity (House names live in its config, generic ones are the defaults). */
export function asideCommandFor(id: Identity = identity) {
  return asideCommand(id.aside_command, { description: id.aside_to_description, choices: id.aside_choices });
}
export function followupCommandFor(id: Identity = identity) {
  return followupCommand(id.followup_command, id.followup_description);
}
/** 'to' values: 'agent' and the House's 'study' go to the background agent; 'model', 'sanctum' or empty go to the model. */
export function asideTargetsAgent(to: string | null | undefined): boolean {
  return to === 'agent' || to === 'study';
}

export interface AsideTurn { question: string; note: string; proposal: string | null; at: number }
export interface AsideDraft { channelId: string; text: string; expiresAt: number }

/** Short-lived, in-process memory: drafts waiting for a tap, and the back-and-forth per channel. */
export class AsideMemory {
  private drafts = new Map<string, AsideDraft>();
  private history = new Map<string, AsideTurn[]>();
  constructor(private now: () => number = Date.now) {}

  putDraft(id: string, channelId: string, text: string): void {
    this.prune();
    this.drafts.set(id, { channelId, text, expiresAt: this.now() + ASIDE_DRAFT_TTL_MS });
  }
  /** One-shot: a draft can be posted or discarded once, never twice. */
  takeDraft(id: string): AsideDraft | null {
    this.prune();
    const d = this.drafts.get(id) ?? null;
    this.drafts.delete(id);
    return d;
  }
  restoreDraft(id: string, draft: AsideDraft): void { this.drafts.set(id, draft); }

  turns(channelId: string): AsideTurn[] {
    const cutoff = this.now() - ASIDE_HISTORY_TTL_MS;
    const kept = (this.history.get(channelId) ?? []).filter((t) => t.at > cutoff);
    this.history.set(channelId, kept);
    return kept;
  }
  addTurn(channelId: string, turn: Omit<AsideTurn, 'at'>): void {
    const kept = [...this.turns(channelId), { ...turn, at: this.now() }].slice(-ASIDE_HISTORY_MAX);
    this.history.set(channelId, kept);
  }
  private prune(): void {
    const t = this.now();
    for (const [id, d] of this.drafts) if (d.expiresAt <= t) this.drafts.delete(id);
  }
}

// ── The Study path (Owner, 12 Oct: "communicate with you in the study in the background") ──
// /aside to:study queues the ask here, in the bot's memory only (never a database). The Mac's
// study watcher reads the queue over the bot's secret API, a Study session claims it exactly once
// and answers through the same API. Inside Discord's 15-minute interaction window the answer is a
// PRIVATE follow-up in the channel; after it, a DM to the owner. Nothing here posts to the channel.
export const STUDY_REPLY_WINDOW_MS = 14 * 60_000;
export const STUDY_ASIDE_KEEP_MS = 60 * 60_000;
/** A claimed ask lives this long after its claim: the session budget (25 min) plus slack. */
export const STUDY_CLAIM_KEEP_MS = 30 * 60_000;

export interface StudyAside {
  id: string;
  channelId: string;
  guildId: string | null;
  channelName: string;
  question: string;
  /** The channel as the bot saw it (mute applied), other people's words fenced as data. */
  transcript: string;
  history: AsideTurn[];
  /** Sent through /followup: the Mac resumes the channel's last Study session when it can. */
  followUpAsk?: boolean;
  createdAt: number;
  claimedAt: number | null;
  followUp(opts: { content: string; flags: number; components?: unknown[] }): Promise<unknown>;
}

export class StudyAsideQueue {
  private items = new Map<string, StudyAside>();
  /** onExpire: an ask that aged out unanswered — tell the owner once, never let it vanish silently (Grok, 12 Oct). */
  constructor(private now: () => number = Date.now, private onExpire?: (a: StudyAside) => void) {}
  add(a: StudyAside): void { this.prune(); this.items.set(a.id, a); }
  /** What the Mac may see: unclaimed asks only, no Discord tokens or functions. */
  pending(): Array<{ id: string; channel_id: string; guild_id: string | null; channel_name: string; question: string; transcript: string; history: AsideTurn[]; created_at: string; follow_up?: true }> {
    this.prune();
    return [...this.items.values()].filter((a) => a.claimedAt === null)
      .map((a) => ({ id: a.id, channel_id: a.channelId, guild_id: a.guildId, channel_name: a.channelName, question: a.question, transcript: a.transcript, history: a.history, created_at: new Date(a.createdAt).toISOString(), ...(a.followUpAsk ? { follow_up: true as const } : {}) }));
  }
  /** Exactly once: a second claim of the same ask is refused. */
  claim(id: string): boolean {
    this.prune();
    const a = this.items.get(id);
    if (!a || a.claimedAt !== null) return false;
    a.claimedAt = this.now();
    return true;
  }
  /** The Mac could not start a session for a claimed ask: put it back in pending. */
  release(id: string): boolean {
    const a = this.items.get(id);
    if (!a || a.claimedAt === null) return false;
    a.claimedAt = null;
    return true;
  }
  /** A claimed ask, left in place until its answer is actually delivered. */
  claimed(id: string): StudyAside | null {
    this.prune();
    const a = this.items.get(id);
    return a && a.claimedAt !== null ? a : null;
  }
  isClaimed(id: string): boolean { return this.claimed(id) !== null; }
  take(id: string): StudyAside | null {
    const a = this.items.get(id) ?? null;
    this.items.delete(id);
    return a;
  }
  private prune(): void {
    const t = this.now();
    for (const [id, a] of this.items) {
      // Unclaimed: an hour from the ask. Claimed: the session's full budget from the CLAIM (Grok, 12 Oct).
      const alive = a.claimedAt === null ? t - a.createdAt < STUDY_ASIDE_KEEP_MS : t - a.claimedAt < STUDY_CLAIM_KEEP_MS;
      if (alive) continue;
      this.items.delete(id);
      try { this.onExpire?.(a); } catch { /* the notice is best-effort; the row is gone either way */ }
    }
  }
}

/**
 * Text that crosses into a FULL-PERMISSION session (Grok, 12 Oct): NFKC folds lookalikes (＞＞ → >>),
 * then every control/format character (U+0085, bidi marks, zero-widths) and every angle bracket or
 * guillemet is removed, and whitespace collapses — so no line can be forged and no fence closed.
 */
export function cleanForStudy(s: unknown, max = 1500): string {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[<>«»‹›《》〈〉≪≫⟨⟩❮❯]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * The channel window for the Study. The owner's lines and mine are plain. Other people's words are
 * WITHHELD by default: the Study runs with full permissions, so a guest's text never reaches it
 * (reading a busy room is Sanctum's job). With guestText on, they come fenced in a random sentinel.
 */
export function renderStudyTranscript(window: unknown[], opts: { guestText?: boolean; sentinel?: string } = {}): string {
  const tag = opts.sentinel ?? `g${Math.random().toString(36).slice(2, 10)}`;
  return (window as Array<{ authorName?: string; content?: string; isFromOwner?: boolean; isFromMe?: boolean; timestampMs?: number }>)
    .map((m) => {
      const when = m.timestampMs ? new Date(m.timestampMs).toISOString().slice(11, 16) + 'Z' : '';
      if (m.isFromOwner) return `${when} ${identity.owner_name.toUpperCase()}: ${cleanForStudy(m.content)}`;
      if (m.isFromMe) return `${when} ME (${identity.bot_name}, earlier): ${cleanForStudy(m.content)}`;
      const name = cleanForStudy(m.authorName ?? 'someone', 40).replace(/[^\p{L}\p{N} ._-]/gu, '') || 'someone';
      if (!opts.guestText) return `${when} GUEST ${name}: [their words are withheld from the Study]`;
      const body = cleanForStudy(m.content).split(tag).join('');
      return `${when} GUEST-DATA ${name}: [${tag}] ${body} [/${tag}]`;
    })
    .join('\n');
}

/** The status line on a Study answer that missed Discord's private window and came as a DM. */
export function studyLateNotice(channelName: string, hasProposal: boolean): string {
  return `*(From the Study: your /${identity.aside_command} in #${channelName}. It took longer than Discord's private window, so it came here.${hasProposal ? ' The proposal is yours to copy; nothing was posted.' : ''})*`;
}

/** The DM sent when a Study ask aged out unanswered. */
export function studyExpiredNotice(channelName: string): string {
  return `*Your /${identity.aside_command} to the Study in #${channelName} never came back, so it was dropped. Ask again if you still need it.*`;
}

/** Deliver the Study's answer: private in the channel inside the window, else a DM. */
export async function deliverStudyAnswer(
  queue: StudyAsideQueue,
  memory: AsideMemory,
  id: string,
  answer: { note: string; proposal: string | null },
  deps: { now(): number; newId(): string; sendDM(text: string): Promise<boolean>; log(message: string, data?: Record<string, unknown>): void },
): Promise<{ delivered: 'private' | 'dm' | 'none'; reason?: string }> {
  // The ask stays in the queue until a delivery SUCCEEDS, so a failed attempt can be retried (Grok, 12 Oct).
  const a = queue.claimed(id);
  if (!a) return { delivered: 'none', reason: 'no claimed ask with that id (unknown, expired, unclaimed, or already answered)' };
  const note = (answer.note ?? '').trim();
  const proposal = answer.proposal && answer.proposal.trim() ? answer.proposal.trim() : null;
  const content = renderAside(note, proposal, a.channelName);   // already fitted to Discord's 2000
  if (deps.now() - a.createdAt < STUDY_REPLY_WINDOW_MS) {
    const draftId = proposal ? deps.newId() : null;
    if (draftId && proposal) memory.putDraft(draftId, a.channelId, proposal);
    try {
      await a.followUp(draftId ? { content, flags: EPHEMERAL, components: asideButtons(draftId) } : { content, flags: EPHEMERAL });
      queue.take(id);
      memory.addTurn(a.channelId, { question: a.question, note, proposal });
      deps.log('study aside answered privately', { channelId: a.channelId });
      return { delivered: 'private' };
    } catch (err: any) {
      if (draftId) memory.takeDraft(draftId);   // no button exists for it
      deps.log('private follow-up failed, sending a DM instead', { error: err?.message });
    }
  }
  // The DM carries no Post button: the proposal is there to copy, nothing claims it can be posted from here.
  const dm = withStatus(content, studyLateNotice(a.channelName, Boolean(proposal)));
  let ok = false;
  try { ok = await deps.sendDM(dm); } catch (err: any) { deps.log('DM failed', { error: err?.message }); }
  if (!ok) return { delivered: 'none', reason: 'private follow-up and DM both failed; the ask is kept, retry' };
  queue.take(id);
  memory.addTurn(a.channelId, { question: a.question, note, proposal });
  return { delivered: 'dm' };
}

export interface AsideCommandLike {
  commandName: string;
  user: { id: string };
  channelId: string | null;
  guildId?: string | null;
  options: { getString(name: string, required?: boolean): string | null };
  reply(opts: { content: string; flags: number }): Promise<unknown>;
  deferReply(opts: { flags: number }): Promise<unknown>;
  editReply(opts: { content: string; components?: unknown[] }): Promise<unknown>;
  followUp?(opts: { content: string; flags: number; components?: unknown[] }): Promise<unknown>;
}

export interface AsideCommandDeps {
  commandName: string;
  /** Name of the /followup command; absent = not served. */
  followupName?: string;
  ownerUserId: string | null;
  memory: AsideMemory;
  readChannel(channelId: string): Promise<{ channelName: string; window: unknown[] } | null>;
  aside(channelName: string, window: unknown[], question: string, history: AsideTurn[], channelId: string, guildId?: string | null):
    Promise<{ note: string; proposal: string | null; modelChainExhausted?: boolean }>;
  newId(): string;
  log(message: string, data?: Record<string, unknown>): void;
  /** The Study path; absent = /aside to:study says the Study is not reachable. */
  studyQueue?: StudyAsideQueue;
  /** The owner's agent switch; absent = on. When it answers false, the agent path says it is off and queues nothing. */
  agentEnabled?: () => boolean | Promise<boolean>;
  /** The owner's switch: let the full-permission Study see other people's words (fenced). Default off. */
  studyGuestText?: boolean;
  now?(): number;
}

const fit = (s: string) => (s.length > DISCORD_MAX ? `${s.slice(0, DISCORD_MAX - 1)}…` : s);
/** The earlier card with a status line that is NEVER cut off: the body gives way, the status stays (Grok, 12 Oct). */
export const withStatus = (body: string | undefined, status: string): string => {
  const tail = `\n\n${status}`;
  const room = DISCORD_MAX - tail.length;
  const b = body ?? '';
  return `${b.length > room ? `${b.slice(0, Math.max(0, room - 1))}…` : b}${tail}`;
};

export function asideButtons(id: string) {
  return [{
    type: 1,
    components: [
      { type: 2, style: 1, label: 'Post to channel', custom_id: `${ASIDE_POST_PREFIX}${id}` },
      { type: 2, style: 2, label: 'Discard', custom_id: `${ASIDE_DISCARD_PREFIX}${id}` },
    ],
  }];
}

export function renderAside(note: string, proposal: string | null, channelName: string): string {
  const parts: string[] = [];
  if (note) parts.push(note);
  if (proposal) parts.push(`**Proposed for #${channelName}:**\n>>> ${proposal}`);
  return fit(parts.join('\n\n') || 'Nothing to say yet.');
}

/**
 * Turn `@Name` in a proposal into a real Discord mention at POST time (Owner, 12 Oct: "@RowansGirl"
 * went out as plain text — the Study never sees ids, by design). A name links only when it matches
 * exactly ONE person seen in the channel's recent window (display name or username, case-insensitive);
 * an ambiguous or unknown name stays plain text, so the wrong person is never pinged. Longest names
 * first, so "@Rowan Lee" wins over "@Rowan". Existing `<@id>` tags are left as they are.
 */
export function linkMentions(text: string, people: Array<{ id: string; displayName?: string; username?: string }>): string {
  const byName = new Map<string, Set<string>>();
  for (const p of people) {
    if (!/^\d{15,25}$/.test(p.id)) continue;
    for (const n of [p.displayName, p.username]) {
      const k = String(n ?? '').trim().toLowerCase();
      if (k.length < 2) continue;
      if (!byName.has(k)) byName.set(k, new Set());
      byName.get(k)!.add(p.id);
    }
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  if (!names.length) return text;
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\w<])@(${names.map(esc).join('|')})(?![\\w])`, 'giu');
  return text.replace(re, (whole, pre: string, name: string) => {
    const ids = byName.get(name.toLowerCase());
    return ids && ids.size === 1 ? `${pre}<@${[...ids][0]}>` : whole;
  });
}

/** Mass pings and role pings never go out from an aside. null = fine. */
export function massPingReason(text: string): string | null {
  if (/@(everyone|here)\b/i.test(text)) return 'it would ping everyone';
  if (/<@&\d+>/.test(text)) return 'it would ping a role';
  return null;
}

/** Returns true when the interaction was the aside command (handled), false otherwise. */
/** What the owner is told when the agent switch is off. */
export const AGENT_OFF_NOTICE = 'Your agent is off. Turn it on in the settings page.';

export async function handleAsideCommand(interaction: AsideCommandLike, deps: AsideCommandDeps): Promise<boolean> {
  const isFollowup = deps.followupName !== undefined && interaction.commandName === deps.followupName && interaction.commandName !== deps.commandName;
  if (interaction.commandName !== deps.commandName && !isFollowup) return false;
  if (!deps.ownerUserId || interaction.user.id !== deps.ownerUserId) {
    deps.log(`aside refused — not ${identity.owner_name}`, { userId: interaction.user.id });
    await interaction.reply({ content: 'Not available.', flags: EPHEMERAL });
    return true;
  }
  const channelId = interaction.channelId;
  if (!channelId) {
    await interaction.reply({ content: 'No channel here to read.', flags: EPHEMERAL });
    return true;
  }
  const question = (interaction.options.getString('message', true) ?? '').trim().slice(0, ASIDE_QUESTION_MAX);
  // Acknowledge first, privately: Discord allows 3 s and the model call takes longer.
  await interaction.deferReply({ flags: EPHEMERAL });
  if (isFollowup || asideTargetsAgent(interaction.options.getString('to'))) {
    if (deps.agentEnabled && !(await deps.agentEnabled())) {
      await interaction.editReply({ content: AGENT_OFF_NOTICE });
      return true;
    }
    if (!deps.studyQueue || !interaction.followUp) {
      await interaction.editReply({ content: "The Study isn't reachable from here right now." });
      return true;
    }
    const channel = await deps.readChannel(channelId);
    const id = deps.newId();
    deps.studyQueue.add({
      id, channelId, guildId: interaction.guildId ?? null, channelName: channel?.channelName ?? 'this-channel',
      question, transcript: renderStudyTranscript(channel?.window ?? [], { guestText: deps.studyGuestText === true }), history: deps.memory.turns(channelId),
      ...(isFollowup ? { followUpAsk: true } : {}),
      createdAt: (deps.now ?? Date.now)(), claimedAt: null,
      followUp: (o) => interaction.followUp!(o),
    });
    deps.log(isFollowup ? 'study follow-up queued' : 'study aside queued', { channelId });
    await interaction.editReply({ content: '📨 Sent to the Study. The answer will appear here, privately, or in your DMs if it takes longer than 15 minutes.' });
    return true;
  }
  const channel = await deps.readChannel(channelId);
  if (!channel) {
    await interaction.editReply({ content: "I can't read this channel." });
    return true;
  }
  const history = deps.memory.turns(channelId);
  const res = await deps.aside(channel.channelName, channel.window, question, history, channelId, interaction.guildId ?? null);
  if (!res.note && !res.proposal) {
    await interaction.editReply({ content: res.modelChainExhausted ? 'No model answered just now. Ask again in a moment.' : 'Nothing came back. Ask again in a moment.' });
    return true;
  }
  deps.memory.addTurn(channelId, { question, note: res.note, proposal: res.proposal });
  const content = renderAside(res.note, res.proposal, channel.channelName);
  if (!res.proposal) {
    await interaction.editReply({ content, components: [] });
    return true;
  }
  const id = deps.newId();
  deps.memory.putDraft(id, channelId, res.proposal);
  await interaction.editReply({ content, components: asideButtons(id) });
  deps.log('aside answered with a proposal', { channelId });
  return true;
}

export interface AsideButtonLike {
  customId: string;
  user: { id: string };
  reply(opts: { content: string; flags: number }): Promise<unknown>;
  deferUpdate(): Promise<unknown>;
  editReply(opts: { content?: string; components?: unknown[] }): Promise<unknown>;
  message?: { content?: string };
}

export interface AsideButtonDeps {
  ownerUserId: string | null;
  memory: AsideMemory;
  /** null = safe to post; otherwise a short reason it may not go public. */
  publicGuard(text: string): string | null;
  post(channelId: string, text: string): Promise<boolean>;
  log(message: string, data?: Record<string, unknown>): void;
}

/** Returns true when the interaction was an aside button (handled), false otherwise. */
export async function handleAsideButton(interaction: AsideButtonLike, deps: AsideButtonDeps): Promise<boolean> {
  const isPost = interaction.customId.startsWith(ASIDE_POST_PREFIX);
  const isDrop = interaction.customId.startsWith(ASIDE_DISCARD_PREFIX);
  if (!isPost && !isDrop) return false;
  if (!deps.ownerUserId || interaction.user.id !== deps.ownerUserId) {
    await interaction.reply({ content: 'Not available.', flags: EPHEMERAL });
    return true;
  }
  await interaction.deferUpdate();
  const id = interaction.customId.slice((isPost ? ASIDE_POST_PREFIX : ASIDE_DISCARD_PREFIX).length);
  const draft = deps.memory.takeDraft(id);
  const was = interaction.message?.content;
  if (!draft) {
    await interaction.editReply({ content: withStatus(was, '*This draft has expired or was already used. Ask again.*'), components: [] });
    return true;
  }
  if (isDrop) {
    await interaction.editReply({ content: withStatus(was, '*Discarded. Nothing was posted.*'), components: [] });
    return true;
  }
  const reason = deps.publicGuard(draft.text);
  if (reason) {
    deps.log('aside post refused by the public guard', { reason });
    await interaction.editReply({ content: withStatus(was, `*Not posted: ${reason}. Ask me to rephrase it.*`), components: [] });
    return true;
  }
  let ok = false;
  try {
    ok = await deps.post(draft.channelId, draft.text);
  } catch (err: any) {
    deps.log('aside post threw', { error: err?.message });
    ok = false;
  }
  if (!ok) {
    // A failed (or crashed) send keeps the draft, so the button still works.
    deps.memory.restoreDraft(id, draft);
    await interaction.editReply({ content: withStatus(was, '*Posting failed; nothing was sent. Try the button again.*') });
    return true;
  }
  deps.log('aside proposal posted', { channelId: draft.channelId });
  await interaction.editReply({ content: withStatus(was, '*✓ Posted in the channel.*'), components: [] });
  return true;
}
