// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import {
  AttachmentBuilder,
  Guild,
  ActivityType,
  DMChannel,
  GatewayIntentBits,
  Message,
  Role,
  ChannelType,
  CategoryChannel,
  TextChannel,
  User,
  Client,
  ThreadChannel,
  GuildMember,
} from 'discord.js';
import type { MessageMentionOptions } from 'discord.js';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { logger } from './logger.js';
import { toMessageAttachments } from './attachments.js';
import { recallPlaceFor, fillReplyAuthorNames, mentionedUsersOf, stripIgnoredMessages, imageEgressAllowed, channelBehaviour, HOS_SERVER_ID } from './presence-engine.js';
import { keyedSerializer } from './role-admin.js';
import type { PresenceMemory, WindowMessage, PresenceEngine, StickerInfo } from './presence-engine.js';
import type { MemoryManager } from './memory.js';
import type { CurfewWatch } from './curfew-watch.js';
import { rollsCurfewSticker } from './curfew-watch.js';
import { houseConfig, resolveSolanceApiUrl } from './config/house-config.js';
import { SolanceApiSettingsStore, type SettingsStore } from './seams/settings-store.js';
import { StickerHistory } from './sticker-history.js';
import {
  channelCouldHoldMessage,
  orderBySearchLikelihood,
  isSnowflake,
  snowflakeToDate,
} from './snowflake.js';
import type { PresenceConfig } from './presence-config.js';
import { DEFAULTS as PRESENCE_DEFAULTS, isIgnoredAuthor, parseStudy, studyHolds, type StudyWindow } from './presence-config.js';
import { AgentPresence } from './agent-presence.js';
import { handleStudyInteraction } from './study-summons.js';
import { FOLLOWUP_DEFAULT_NAME, deliverStudyAnswer, linkMentions, studyExpiredNotice, ASIDE_DEFAULT_NAME, AsideMemory, StudyAsideQueue, handleAsideButton, handleAsideCommand, massPingReason } from './aside.js';
import { leaksIntimateRegister } from './reserved-register.js';
import { PresenceDebouncer, isOnlineStatus } from './presence-debounce.js';
import { addressesOwner, classifyRefs, fallbackPattern, buildPreCheckPattern } from './classify.js';
import { identity } from './config/identity.js';
import type { NameTriggers } from './classify.js';
import type { SoftPresenceEvent } from './soft-presence.js';
import { speakerLock } from './speaker-lock.js';
import type { ContextCollector } from './context-collector.js';
import type { GenerationContextRegistry } from './generation-context.js';
import { routeOwnerMessage } from './scene-catch.js';
import { resolveServer, type ResolvedServer } from './presence/servers.js';
import { effectiveStep } from './presence/posture.js';
import type { Step } from './presence/steps.js';
import { createCopyToOwner } from './copy-to-owner.js';
import type { SceneCatch } from './scene-catch.js';
import * as admin from './discord/admin.js';
import { reactionStore, buildReactions, normalizeReactionEmoji } from './reaction-store.js';
import type { WindowReaction } from './presence/window.js';
import type { ConsiderChannelOpts, ServerChannels, FileAttachment, MentionEvent } from './discord/helpers.js';
import { replyParentId, newestNonBotMessageId, mentionsBot, shouldCollectContextLogMessage } from './discord/helpers.js';

export * from './discord/helpers.js';

/**
 * What every model-generated send carries: people may be pinged (and the
 * replied-to user), never @everyone, @here or a role.
 */
/** Server-authored sticker text as prompt-safe data: one line, no quotes/backticks/angle brackets, capped. */
export function stickerText(v: string | null | undefined, max: number): string {
  return (v ?? '').replace(/[\u0000-\u001f\u007f"`<>{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export const MODEL_ALLOWED_MENTIONS: MessageMentionOptions = { parse: ['users'], repliedUser: true };

export class DiscordClient extends EventEmitter {
  private client: Client;
  private _isReady: boolean = false;
  private ownerUserId: string;
  private botUserId: string | null = null;
  // True while the bot is SHOWN offline (it mirrors the owner's status). The owner,
  // 2026-09-28: "it would be helpful if the bot doesn't respond when it is
  // invisible". Appearing offline and then answering guests reads as broken.
  // The owner herself is never silenced by this; only guest-facing speech is.
  private shownOffline = false;
  private presenceDebouncer = new PresenceDebouncer({
    apply: (status) => {
      this.updatePresence(status);
      this.emit('ownerPresenceChange', status === 'online');
    },
    isOwnerOnlineNow: async () => (await this.readOwnerOnline()) ?? false,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  // False until the startup status read settles (success, failure or timeout).
  // Until then guest-facing speech is held: a restart while the owner is offline
  // must not answer guests in the seconds before her status is known.
  private presenceSettled = false;
  private processedMessages: Set<string> = new Set();
  private ambientDirtyChannels: Set<string> = new Set();
  // Self-rescheduling setTimeout (Owner, 2026-07-12) — NOT a fixed setInterval.
  // Re-reads sweep_minutes from live config every cycle, in scheduleNextSweep(),
  // so a changed cadence actually takes effect on the NEXT sweep instead of
  // being locked in at boot.
  private ambientTimeout: NodeJS.Timeout | null = null;
  private ambientEngine: PresenceEngine | null = null;
  // The private aside (aside.ts): its command name (/aside in the House) and its short memory.
  private asideCommandName = ASIDE_DEFAULT_NAME;
  private asideMemory = new AsideMemory();
  private followupCommandName = FOLLOWUP_DEFAULT_NAME;
  /** When the owner's own agent last polled this bot (in memory). */
  readonly agentPresence = new AgentPresence();
  // /aside to:study — asks waiting for the Mac's Study session (aside.ts).
  readonly studyAsides = new StudyAsideQueue(Date.now, (a) => {
    // An ask that aged out unanswered: tell the owner once, privately.
    if (this.ownerUserId) void this.sendDM(this.ownerUserId, studyExpiredNotice(a.channelName)).catch(() => {});
  });
  /** STUDY_ASIDE_GUEST_TEXT=on lets the Study see other people's words (fenced). Default: withheld. */
  studyGuestText = false;
  private ambientMemory: MemoryManager | null = null;
  private ambientSweepInFlight: boolean = false;
  private ambientMentionReplyCursors: Map<string, string> = new Map();
  // Per-channel in-flight guard for considerChannel (2026-07-12 review, P1) —
  // the periodic sweep and the real-time soft-presence path both call
  // considerChannel for the same channel, and only the soft-presence branch
  // carries a claimMessageId (so only it hit the speakerLock at the send
  // site). Without this, both callers could pass engine.judge() and both
  // attempt to send before either records the post (recordSpoke happens only
  // after send). This is the shared in-flight claim covering BOTH paths: a
  // second considerChannel call for a channel already being considered is
  // skipped outright rather than racing to judge/send concurrently.
  private ambientConsiderInFlight: Set<string> = new Set();
  // Pending real-time trigger, queued per channel (P1 fix, 2026-07-12 review)
  // — if a soft-presence call arrives while considerChannel is already
  // in-flight for that channel (the periodic sweep got there first), the
  // OLD behavior dropped it outright: the sweep judged a stale window and the
  // triggering message carrying opts.triggerMessage was discarded, delaying
  // or losing the response. Now, a real-time trigger (opts.triggerMessage
  // present) that arrives mid-flight is coalesced here instead of dropped,
  // and re-run once the in-flight call finishes (see the `finally` block
  // below). At most one pending entry per channel — a second trigger arriving
  // before the first pending one has run simply overwrites it (coalescing a
  // burst into one follow-up run, same spirit as the judge-execution
  // debounce). A plain periodic-sweep call (no triggerMessage) racing another
  // in-flight call has nothing new to coalesce, so it is still dropped
  // exactly as before — only real-time triggers are ever queued.
  private ambientConsiderPending: Map<string, { channelName: string; opts: ConsiderChannelOpts }> = new Map();
  // #care-channel — a reply here is a parent answering the care character's cry.
  private readonly careChannelId = houseConfig.careChannelId;
  private settings: SettingsStore = new SolanceApiSettingsStore(resolveSolanceApiUrl(), () => process.env.SOLANCE_TOKEN);
  // null = the solance-api default above, which needs SOLANCE_TOKEN; a store injected by the seam factory sets this.
  private settingsReady: boolean | null = null;
  /** Swap the settings store (the House default is SolanceApiSettingsStore). `ready` replaces the SOLANCE_TOKEN check. */
  setSettingsStore(store: SettingsStore, ready = true): void {
    this.settings = store;
    this.settingsReady = ready;
  }
  private settingsConfigured(): boolean {
    return this.settingsReady ?? Boolean(process.env.SOLANCE_TOKEN);
  }
  // Curfew is a REFLEX, not ambient personality — optional/nullable so the
  // local mcp-server entrypoint (which never wires it) is unaffected.
  private curfewWatch: CurfewWatch | null = null;
  // Scene flag drag-back (spec 2026-09-28-scene-flag.md) — optional/nullable
  // like curfew: unset (local mcp-server) means the owner's messages go straight to
  // the curfew check exactly as before.
  private sceneCatch: SceneCatch | null = null;
  // Live presence config (Owner, 2026-07-12) — drives sweep cadence, per-channel
  // posture override, and the stickers_enabled toggle (ambient + curfew).
  // Optional/nullable so the local mcp-server entrypoint (which never wires
  // it) is unaffected; every read falls back to PRESENCE_DEFAULTS.
  private presenceConfig: PresenceConfig | null = null;
  // Context-Log collector (Phase 3, §9/§9.1, Owner 2026-07-12) — buffers house
  // channel messages and flushes them to Sanctum /ingest/discord. Optional/
  // nullable so the local mcp-server entrypoint (which never wires it) is
  // unaffected; every messageCreate call below is a no-op when unset.
  private contextCollector: ContextCollector | null = null;
  // Context Log capture (Owner, 2026-07-13, FORWARD ONLY) — the SAME registry
  // every generated-message send site registers into, immediately after a
  // successful send. Optional/nullable so the local mcp-server entrypoint
  // (which never wires it) is unaffected; every register() call below is a
  // no-op when unset.
  private generationContext: GenerationContextRegistry | null = null;
  // Cached HoS sticker roster for presence's sticker vocabulary (the owner,
  // 2026-07-11) — 60-minute TTL; on fetch failure keep the last-known roster
  // (empty roster if never fetched = the feature is quietly off, never a
  // reason to block a post).
  // Per-guild sticker rosters: a server's custom stickers only work inside that server.
  private stickerRosters = new Map<string, { roster: StickerInfo[]; fetchedAtMs: number }>();
  private readonly STICKER_ROSTER_TTL_MS = 60 * 60_000;
  // Shared sticker anti-repeat memory (Task 5, §8.1, Owner 2026-07-12) — the
  // ONE registry every sticker-sending path reads/writes: the ambient judge
  // and mention-reply (via PresenceEngine, injected below through
  // setStickerHistory) AND the curfew reflex (handleCurfewCheck, right here
  // in this class). Never re-created per path — "shared" is the whole point,
  // so a sticker the curfew reflex just sent in a channel is just as
  // "recently used" to the ambient judge, and vice versa.
  private readonly stickerHistory = new StickerHistory();
  // Injectable random source for the curfew occasional-sticker roll (§8.1
  // Step 3) — same injectable-source spirit as the `now()` clock pattern
  // used throughout this codebase, so tests can pin the outcome
  // deterministically instead of depending on real randomness.
  private readonly rng: () => number;
  // Cheap messageCreate pre-check pattern (§0.C, P1 fix 2026-07-12 review) —
  // built from the LIVE name_triggers (both families) so a custom trigger is
  // never silently invisible to the gate. Rebuilt only when the config's
  // name_triggers object identity changes (the poller replaces it wholesale
  // on refresh), so a message-per-message rebuild never happens.
  private cheapPreCheckTriggersRef: NameTriggers | null = null;
  private cheapPreCheckPattern: RegExp = fallbackPattern();

  constructor(ownerUserId: string, rng: () => number = Math.random) {
    super();
    this.ownerUserId = ownerUserId;
    this.rng = rng;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageTyping,
        // Reactions in the room (non-privileged): see them live, answer with one.
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessageReactions,
      ],
      // Required for DMs; 3/4 = Message, Reaction so a reaction on an older message still arrives.
      partials: [1, 2, 3, 4],
    });

    this.setupEventHandlers();
  }

  /**
   * A reply in #care-channel is a parent answering the care character's cry. Forward the
   * reply text to the interaction endpoint — it infers the care action from the
   * words (fed / rocked to sleep / held / …), settles the matching need, and
   * generates his reaction — then post his reaction back as the care character so the loop
   * closes (you reply, he answers). Best-effort: any failure is logged, silent.
   */
  private async handleCareReply(message: Message): Promise<void> {
    if (!this.settingsConfigured()) { logger.error('Discord', 'Care reply: no SOLANCE_TOKEN'); return; }
    const text = (message.content || '').trim();
    if (!text) return;
    const actors = message.author.id === this.ownerUserId ? [identity.care.actor_owner] : [identity.care.actor_other];

    let reaction: string | null = null;
    try {
      const res = await this.settings.postCareInteraction({ kind: 'custom', context_text: text, actors, source_platform: 'discord-reply' });
      if (!res.ok) { logger.error('Discord', `Care reply: interaction POST ${res.status}`); return; }
      const row: any = await res.json();
      const field = identity.care.reaction_field;
      reaction = row?.[field] ?? row?.interaction?.[field] ?? null;
    } catch (err: any) {
      logger.error('Discord', 'Care reply: interaction POST threw', { error: err?.message });
      return;
    }

    // Post his reaction back as the care character (his own webhook identity).
    if (reaction) {
      const webhookEnv = identity.care.webhook_env;
      const webhook = process.env.CARE_WEBHOOK_URL || (webhookEnv ? process.env[webhookEnv] : undefined);
      if (!webhook) { logger.info('Discord', `Care reply: settled, no ${webhookEnv ?? 'CARE_WEBHOOK_URL'} to voice the reply`); return; }
      try {
        await fetch(webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: reaction, username: identity.care.persona_name, allowed_mentions: { parse: [] } }),
        });
      } catch (err: any) {
        logger.error('Discord', 'Care reply: webhook post threw', { error: err?.message });
      }
    }
  }

  /**
   * How the bot treats this server (specs/2026-10-15-discord-servers-section.md): live settings over
   * the House seed over the silent default. getCached() is sync/free, safe on every hot path.
   */
  serverOf(guildId: string | null | undefined): ResolvedServer {
    return resolveServer(guildId, this.presenceConfig?.getCached() ?? PRESENCE_DEFAULTS, houseConfig.servers);
  }

  private copyToOwner = createCopyToOwner({
    ownerUserId: '',
    copyEnabled: () => false,
    sendDM: async () => null,
    log: () => {},
  });
  private copyWired = false;

  /**
   * copy_to_owner rule: after a successful guild post, DM the owner a copy. Fire-and-forget and
   * best-effort, so the channel send is never delayed or affected.
   */
  private maybeCopyToOwner(sent: Message | null, trigger?: Message | null): void {
    try {
      if (!sent || !sent.guildId) return;
      if (!this.copyWired) {
        this.copyWired = true;
        this.copyToOwner = createCopyToOwner({
          ownerUserId: this.ownerUserId,
          copyEnabled: (g) => this.serverOf(g).rules.copy_to_owner === true,
          sendDM: (u, t) => this.sendDM(u, t),
          log: (m, d) => logger.error('Discord', m, d),
        });
      }
      const ch: any = (sent as any).channel;
      void this.copyToOwner({
        guildId: sent.guildId,
        guildName: (sent as any).guild?.name,
        channelId: sent.channelId,
        channelName: ch?.name,
        sentId: sent.id,
        // A poll has no text body; copy its question so the DM says what was asked.
        text: sent.content || ((sent as any).poll?.question?.text ? `[poll] ${(sent as any).poll.question.text}` : ''),
        stickerNames: (sent as any).stickers ? [...(sent as any).stickers.values()].map((st: any) => st.name) : [],
        attachments: (sent as any).attachments ? [...(sent as any).attachments.values()].map((a: any) => ({ name: a.name, url: a.url })) : [],
        trigger: trigger ? { authorId: trigger.author?.id, authorName: (trigger as any).member?.displayName ?? trigger.author?.username, text: trigger.content } : null,
      }).catch(() => {});
    } catch { /* best-effort */ }
  }

  /** The guild a channel lives in, from the cache only (sync); null for a DM or an unknown channel. */
  guildIdOfChannelCached(channelId: string): string | null {
    const ch: any = this.client?.channels?.cache?.get(channelId);
    return ch?.guildId ? String(ch.guildId) : null;
  }

  /**
   * What the bot may do in one channel (Owner, 2026-10-17; specs/2026-10-17-discord-one-ladder.md): its
   * effective step is the channel's own, else the server's, else the House dial. The ONE place every
   * caller asks. `step` is the effective step; ambient/answerMentions follow from it.
   */
  channelRules(
    guildId: string | null | undefined,
    channelId: string,
    channelName: string | undefined,
    cfg: { posture?: Record<string, string>; step: Step } | undefined,
  ): { step: Step; ambient: ReturnType<typeof channelBehaviour>['ambient']; answerMentions: boolean } {
    const live = cfg ?? PRESENCE_DEFAULTS;
    const step = effectiveStep(channelId, channelName, live, guildId ? this.serverOf(guildId) : null);
    const b = channelBehaviour(step);
    return { step, ambient: b.ambient, answerMentions: b.answerMentions };
  }

  private channelNameCached(channelId: string): string | undefined {
    const ch: any = this.client?.channels?.cache?.get(channelId);
    return typeof ch?.name === 'string' ? ch.name : undefined;
  }

  private observeAmbientActivity(message: Message): void {
    if (!this.ambientEngine) return;
    // The channel's own setting wins over the server's mode (Owner, 2026-10-17). Ambient level: the
    // channel is swept and woken. Mentions only: a message that mentions me marks the channel for the
    // next sweep, which answers the mention and never chimes in. Neither: not swept ('off', a silent
    // server's Default channel, an unmapped home channel).
    // Live posture (Owner, 2026-08-29) — eligibility asks the SAME question resolvePosture answers
    // everywhere else. channelName is available for any guild text/thread channel; absent for a DM.
    const channelName = 'name' in message.channel ? (message.channel as TextChannel | ThreadChannel).name : undefined;
    const cfg = this.presenceConfig?.getCached();
    const rules = this.channelRules(message.guildId, message.channelId, channelName, cfg);
    if (rules.ambient) {
      this.ambientDirtyChannels.add(message.channelId);
      this.ambientEngine.recordReplyReceived(message.channelId);
      return;
    }
    if (rules.answerMentions && mentionsBot(message.mentions, this.botUserId)) {
      this.ambientDirtyChannels.add(message.channelId);
    }
  }

  /**
   * Builds the Context-Log collector's content string (codex P1, 2026-07-12
   * review). message.content alone is empty for attachment-, sticker-, and
   * embed-only messages, which then get dropped at the collector's
   * empty-content gate — contradicting the spec's "every message that
   * survives the gates" law. Appends a compact textual placeholder for each
   * attachment/sticker/embed so those messages carry non-empty, raw-content
   * text into the batch instead of vanishing silently. Text content (when
   * present) always comes first, unmodified.
   */
  private buildContextLogContent(message: Message): string {
    const parts: string[] = [];
    if (message.content) parts.push(message.content);
    for (const attachment of message.attachments.values()) {
      parts.push(`[attachment: ${attachment.name || attachment.url}]`);
    }
    for (const sticker of message.stickers.values()) {
      parts.push(`[sticker: ${sticker.name}]`);
    }
    for (const embed of message.embeds) {
      const label = embed.title || embed.description?.slice(0, 80) || embed.url || 'embed';
      parts.push(`[embed: ${label}]`);
    }
    return parts.join(' ').trim();
  }

  /** A live Study window holds this channel (the owner's secret slash command) — Sanctum steps aside. */
  studyHoldsChannel(channelId: string): boolean {
    const study = this.presenceConfig?.getStudy?.();
    return studyHolds(study, channelId, Date.now());
  }

  private studyReadyTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Sanctum steps aside only once the Study reports ready (ready_at). The 120s poller would leave
   * up to two minutes where both voices could answer, so after an open the config is re-read every
   * 10s until that window is ready, closed or replaced, or 5 minutes pass.
   */
  watchStudyUntilReady(study: StudyWindow): void {
    if (this.studyReadyTimer) clearInterval(this.studyReadyTimer);
    const started = Date.now();
    this.studyReadyTimer = setInterval(async () => {
      const cfg = await this.presenceConfig?.fetchFresh?.().catch(() => null);
      const cur = this.presenceConfig?.getStudy?.();
      const done = !cur || cur.nonce !== study.nonce || !cur.active || !!cur.ready_at;
      if (done || Date.now() - started > 5 * 60_000) {
        if (cur?.nonce === study.nonce && cur.ready_at) logger.info('Study', 'Study ready — Sanctum steps aside', { channelId: cur.channel_id });
        else if (Date.now() - started > 5 * 60_000) logger.warn('Study', 'Study never reported ready in 5 min — Sanctum keeps the channel', { nonce: study.nonce, fetched: !!cfg });
        clearInterval(this.studyReadyTimer!);
        this.studyReadyTimer = null;
      }
    }, 10_000);
  }

  /** Records a sighting of the owner while the scene flag is up (solance-api refuses one for a stale raise). Never throws. */
  private async reportSceneSighting(sighting: { raised_at: string; caught: boolean; message_id: string; channel_id: string; channel_name: string; excerpt: string }): Promise<void> {
    if (!this.settingsConfigured()) return;
    // 409 means one of two things (Grok re-review D): the flag was not up when she
    // posted (logged, dropped — correct), or the API lost a write race and asks for
    // a re-send (retried a few times, then logged loudly — never silently lost).
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.settings.putPresenceConfig({ scene_sighting: sighting }, AbortSignal.timeout(8000));
        if (res.ok) return;
        const body = (await res.text()).slice(0, 200);
        if (res.status === 409 && /re-send/.test(body) && attempt < 3) {
          await new Promise((r) => setTimeout(r, 250 * attempt));
          continue;
        }
        if (res.status === 409 && !/re-send/.test(body)) {
          logger.info('Scene', 'sighting refused — flag was not up when she posted', { messageId: sighting.message_id, body });
        } else {
          logger.warn('Scene', `sighting PUT ${res.status} — sighting lost`, { messageId: sighting.message_id, attempt, body });
        }
        return;
      } catch (err: any) {
        logger.warn('Scene', 'sighting PUT threw — sighting lost', { messageId: sighting.message_id, error: err?.message });
        return;
      }
    }
  }

  /** Opens a Study window via solance-api; returns the stored window or null (never throws). */
  async openStudyWindow(channelId: string, guildId: string | null, minutes: number): Promise<StudyWindow | null> {
    if (!this.settingsConfigured()) { logger.error('Study', 'no SOLANCE_TOKEN — cannot open a window'); return null; }
    try {
      const res = await this.settings.putPresenceConfig({ study: { active: true, channel_id: channelId, guild_id: guildId, minutes } }, AbortSignal.timeout(8000));  // the interaction is already deferred
      if (!res.ok) { logger.error('Study', `open window PUT ${res.status}`, { body: (await res.text()).slice(0, 200) }); return null; }
      const data: any = await res.json();
      return parseStudy(data?.discord?.study);
    } catch (err: any) {
      logger.error('Study', 'open window PUT threw', { error: err?.message });
      return null;
    }
  }

  private setupEventHandlers(): void {
    // The owner's secret /study (user-installed; study-summons.ts). Deferred ephemeral at once, so the
    // 3s deadline never races the config write.
    this.client.on('interactionCreate', async (interaction) => {
      // The private aside's Post / Discard buttons (aside.ts).
      if (interaction.isButton()) {
        try {
          // Returns false for buttons that are not the aside's — leave those to their own owner.
          if (!(await handleAsideButton(interaction as any, {
            ownerUserId: this.ownerUserId,
            memory: this.asideMemory,
            publicGuard: (text) => (leaksIntimateRegister(text) ? 'it uses your private register' : massPingReason(text) ?? (text.trim() ? null : 'it is empty')),
            post: async (channelId, text) => Boolean(await this.sendMessage(channelId, await this.linkAsideMentions(channelId, text))),
            log: (message, data) => logger.info('Aside', message, data),
          }))) return;
        } catch (err: any) {
          logger.error('Aside', 'aside button failed', { error: err?.message });
        }
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      // The private aside (/aside in the House, /aside in the public module).
      try {
        const handled = await handleAsideCommand(interaction as any, {
          commandName: this.asideCommandName,
          followupName: this.followupCommandName,
          ownerUserId: this.ownerUserId,
          memory: this.asideMemory,
          readChannel: (channelId) => this.readAsideChannel(channelId),
          aside: async (channelName, window, question, history, channelId, guildId) => {
            if (!this.ambientEngine) return { note: 'Presence is off right now, so I cannot think this through here.', proposal: null };
            return this.ambientEngine.privateAside(channelName, window as WindowMessage[], question, history, channelId, guildId ?? null);
          },
          newId: () => crypto.randomUUID(),
          log: (message, data) => logger.info('Aside', message, data),
          studyQueue: this.studyAsides,
          agentEnabled: () => this.agentEnabled(),
          studyGuestText: this.studyGuestText,
        });
        if (handled) return;
      } catch (err: any) {
        logger.error('Aside', 'aside command failed', { error: err?.message });
        return;
      }
      try {
        await handleStudyInteraction(interaction as any, {
          commandName: identity.study_command,
          agentEnabled: () => this.agentEnabled(),
          ownerUserId: this.ownerUserId,
          openStudy: (channelId, guildId, minutes) => this.openStudyWindow(channelId, guildId, minutes),
          noteStudy: (study) => this.presenceConfig?.noteStudy(study),
          watchUntilReady: (study) => this.watchStudyUntilReady(study),
          log: (message, data) => logger.info('Study', message, data),
        });
      } catch (err: any) {
        logger.error('Study', 'study interaction failed', { error: err?.message });
      }
    });

    this.client.once('ready', () => {
      this._isReady = true;
      this.botUserId = this.client.user?.id || null;
      logger.info('Discord', `Ready as ${this.client.user?.tag}`);
      logger.info('Discord', `Bot User ID: ${this.botUserId}`);
      this.ambientEngine?.setSelfId(this.botUserId);
      logger.setDiscordConnected(true);
      this.emit('ready');
      // Start in the status the owner is actually in, not "online" by default —
      // otherwise a restart while she is offline would answer guests until
      // her status next changes.
      const settle = () => { this.presenceSettled = true; };
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
      Promise.race([this.syncPresenceWithOwner(), timeout])
        .catch((err: any) =>
          logger.info('Discord', `could not read ${identity.owner_name}'s status at startup — staying online`, { error: err?.message }))
        .finally(settle);
    });

    // Connection lifecycle events
    this.client.on('shardReady', (shardId) => {
      logger.info('Discord', `Shard ${shardId} ready`);
      logger.setDiscordConnected(true);
    });

    this.client.on('shardDisconnect', (event, shardId) => {
      logger.warn('Discord', `Shard ${shardId} disconnected`, { code: event.code, reason: event.reason });
      logger.setDiscordConnected(false);
    });

    this.client.on('shardReconnecting', (shardId) => {
      logger.info('Discord', `Shard ${shardId} reconnecting...`);
    });

    this.client.on('shardResume', (shardId, replayedEvents) => {
      logger.info('Discord', `Shard ${shardId} resumed`, { replayedEvents });
      logger.setDiscordConnected(true);
    });

    this.client.on('shardError', (error, shardId) => {
      logger.error('Discord', `Shard ${shardId} error`, { error: error.message });
    });

    this.client.on('warn', (message) => {
      logger.warn('Discord', message);
    });

    this.client.on('debug', (message) => {
      // Only log significant debug messages to avoid spam
      if (message.includes('Heartbeat') || message.includes('Session') || message.includes('Gateway')) {
        logger.debug('Discord', message);
      }
    });

    this.client.on('presenceUpdate', (oldPresence, newPresence) => {
      if (newPresence.userId !== this.ownerUserId) return;
      // Mirror the owner, but not her phone's few-second disconnects (presence-debounce.ts).
      this.presenceDebouncer.observe(newPresence.status);
    });

    this.client.on('messageCreate', async (message) => {
      // THE DISCORD LAYER FILTER (Owner, 2026-08-31) — FIRST line of the handler,
      // before the context collector, before every gate below. A blocked author's
      // message does not enter this process at all.
      if (this.ingressBlocked(message.author?.id)) return;

      // ── Context-Log collector (Phase 3, §9/§9.1) ─────────────────────────
      // THE OWNER'S RULE (2026-07-18 clarification): independent rows are MY OWN
      // replies only. The human/guest messages that produced a reply travel
      // inside that reply's `trigger_message` and `discord_context` audit data;
      // they are not duplicated as standalone rows in the left-hand list.
      // Wrapped in try/catch and never awaited: observe() is synchronous and
      // non-throwing by contract, but a collector error must NEVER affect this
      // pipeline.
      if (
        this.contextCollector &&
        shouldCollectContextLogMessage(message.author.id, this.botUserId)
      ) {
        try {
          this.contextCollector.observe({
            messageId: message.id,
            channelId: message.channelId,
            channelName: message.channel.type === ChannelType.DM
              ? 'DM'
              : ('name' in message.channel ? (message.channel as TextChannel | ThreadChannel).name : 'unknown'),
            guildId: message.guild?.id ?? null,
            authorId: message.author.id,
            authorName: message.member?.displayName || message.author.globalName || message.author.username || message.author.tag,
            content: this.buildContextLogContent(message),
            timestamp: message.createdAt.toISOString(),
            isBot: true,
            involvesBot: true,
            replyTo: message.reference?.messageId ?? null,
          });
          // Context Logs is an operator/debugging surface: every reply must be
          // reviewable now, not after the ten-minute safety sweep.
          this.contextCollector.flushNow(message.channelId);
        } catch (err: any) {
          logger.error('ContextLog', 'observe threw — pipeline continuing', { error: err?.message });
        }
      }

      // Ignore bot's own messages (everything below this line: presence, away,
      // curfew, mentions — none of it may act on my own posts).
      if (message.author.id === this.botUserId) return;

      // Ignore messages from any bot
      if (message.author.bot) return;

      // Study window (Owner, 2 Oct): while her summoned Study session holds this channel it is the
      // only voice here — curfew, mentions, ambient and care replies all step aside. Memory ingest
      // (above) keeps running.
      if (this.studyHoldsChannel(message.channelId)) return;

      this.observeAmbientActivity(message);

      // ── Curfew reflex (Owner, 2026-07-11) ────────────────────────────────────
      // Instant, ID-keyed, no model judgment on the TRIGGER — must run for plain
      // channel messages too, so it fires BEFORE the DM/mention gate below.
      // DMs count too (messaging the bot directly past curfew still counts).
      // Scene catch (spec 2026-09-28-scene-flag.md) sits in front of it: in the
      // HoS guild, while a scene flag is up and this raise is uncaught, her
      // message is caught instead, and the curfew nudge does NOT also fire for
      // it. Not gated on guestSpeechHeld() — the owner is exempt from the hold.
      if (message.author.id === this.ownerUserId) {
        this.handleOwnerMessage(message).catch((err) =>
          logger.error('Scene', 'scene/curfew check failed', { error: err?.message }));
      }

      // ── the care character care-response ──────────────────────────────────────────────
      // A REPLY in #care-channel is you answering his cry — settle his need
      // and let him answer back. Handled here (not as a mention), then return.
      if (message.channelId === this.careChannelId && message.reference) {
        if (this.processedMessages.has(message.id)) return;
        this.processedMessages.add(message.id);
        this.handleCareReply(message).catch((err) =>
          logger.error('Discord', 'Care reply failed', { error: err?.message }));
        return;
      }

      // Check if this is a DM or a mention
      const isDM = message.channel.type === ChannelType.DM;
      const isMentioned = mentionsBot(message.mentions, this.botUserId);

      // ── Away proxy / soft-presence classifier (Plan 2b §0.C — hot-path-safe,
      // §0.A routing matrix) ──────────────────────────────────────────────
      // Runs ONLY for messages that are NOT a DM / @bot-mention (those fall
      // through to the existing pipeline below, unchanged — the mention/dm
      // path returns at the gate BEFORE this classifier ever runs, so it never
      // conflicts with either new event). Wrapped in its own try/catch,
      // entirely separate from the mention/dm path: a failure here degrades to
      // silence and never early-returns before the gate. Uses getCached()
      // ONLY (sync, no network — the poller owns fetches).
      //
      // Routing is MUTUALLY EXCLUSIVE (§0.A) — at most one of the two events
      // fires per message:
      //   - a guest genuinely reaching FOR the owner (`addressesOwner`) → `away-inquiry`
      //     (the cloud-server handler applies the announce/away gates + the
      //     clean-room reply).
      //   - ELSE a bare name-drop (`botSoft`, or `ownerSoft` from someone who
      //     isn't the owner) → `soft-presence`, waking the judge on THIS message in
      //     real time instead of waiting for the sweep (Task 4). The
      //     `!isFromOwner` guard on the ownerSoft branch stops the owner naming
      //     herself from waking the judge — botSoft from the owner is fine, she may
      //     summon me by name.
      // The single-speaker lock (§0.A) is claimed at each path's SEND site
      // (away's reply in cloud-server.ts; soft-presence's reply in
      // considerChannel below) — not here, where nothing sends yet.
      if (!isDM && !isMentioned && !message.author.bot) {
        try {
          const content = message.content || '';
          const cfg = this.presenceConfig?.getCached();
          if (cfg) {
            // Cheap substring pre-check (§0.C) — built from the SAME live
            // name_triggers classifyRefs uses (P1 fix, 2026-07-12 review): a
            // hardcoded /the owner|bot/i pre-check silently dropped any custom
            // trigger (e.g. "fable"), so a message containing ONLY a custom
            // trigger never reached classifyRefs and soft-presence never
            // fired for it. getCached() is synchronous/free, so reading it
            // before the pre-check costs nothing; the pattern itself is
            // rebuilt only when the config's name_triggers reference changes.
            if (cfg.name_triggers !== this.cheapPreCheckTriggersRef) {
              this.cheapPreCheckPattern = buildPreCheckPattern(cfg.name_triggers);
              this.cheapPreCheckTriggersRef = cfg.name_triggers;
            }
            if (this.cheapPreCheckPattern.test(content) || message.mentions.has(this.ownerUserId)) {
              const refs = classifyRefs(content, message.mentions, this.ownerUserId, message.author.id, cfg.name_triggers);
              const channelName = isDM ? 'DM' : (message.channel as TextChannel).name;
              // Ignore list (Owner, 2026-08-29) — a name-drop or an away-style
              // reach FROM an ignored author must never wake either event: no
              // proxy reply about the owner, no real-time judge wake on their
              // message. Checked once here rather than per-branch; the
              // message itself is untouched and still lands in every window
              // any OTHER path builds (ambient eligibility never strips it).
              const ignoredAuthor = isIgnoredAuthor(message.author.id, cfg.ignored_user_ids);
              if (!ignoredAuthor && !refs.isFromOwner && addressesOwner(refs, content)) {
                this.emit('away-inquiry', {
                  channelId: message.channelId,
                  channelName,
                  guestId: message.author.id,
                  messageId: message.id,
                  guestTag: message.author.tag,
                  guildId: message.guildId,
                  content,
                });
              } else if (!ignoredAuthor && (refs.botSoft || (refs.ownerSoft && !refs.isFromOwner))) {
                const softEvent: SoftPresenceEvent = {
                  channelId: message.channelId,
                  channelName,
                  messageId: message.id,
                  authorId: message.author.id,
                  content,
                  timestampMs: message.createdTimestamp,
                };
                this.emit('soft-presence', softEvent);
              }
            }
          }
        } catch (err: any) {
          logger.error('Presence', 'away/soft-presence classifier failed (degraded to silence)', { error: err?.message });
        }
      }

      // Process if it's a DM OR if bot is mentioned in a server
      if (!isDM && !isMentioned) return;

      // Deduplicate - prevent processing same message twice
      if (this.processedMessages.has(message.id)) {
        console.error(`[Discord] Skipping duplicate message ${message.id}`);
        return;
      }
      this.processedMessages.add(message.id);

      // Clean up old message IDs (keep last 100)
      if (this.processedMessages.size > 100) {
        const toDelete = Array.from(this.processedMessages).slice(0, 50);
        toDelete.forEach(id => this.processedMessages.delete(id));
      }

      // Resolve display name (guild nick > global name > username)
      let authorDisplayName = message.author.tag;
      if (!isDM && message.guild) {
        try {
          const member = await message.guild.members.fetch(message.author.id);
          authorDisplayName = member.displayName;
        } catch {
          // Fallback to tag
        }
      }

      const mentionEvent: MentionEvent = {
        channelId: message.channelId,
        channelName: isDM ? 'DM' : (message.channel as TextChannel).name,
        guildName: message.guild?.name || null,
        authorId: message.author.id,
        authorTag: authorDisplayName,
        content: message.content,
        timestamp: message.createdAt,
        message: message,
        isDM: isDM
      };

      // Emit different events for DMs vs mentions. A DM from an ignored
      // author (Owner, 2026-08-29) never emits `dm` — that event is what
      // generates the reply. `mention` is deliberately left ungated here: a
      // non-the owner @-mention already only DMs the owner a notification rather than
      // replying (see the 'mention' handler in cloud-server.ts) — that is
      // not a reply, so it is not one of the gated paths. getCached() is
      // sync/free (no network) — safe on this hot path; an unavailable
      // config fails OPEN (empty ignore list), never silences the bot.
      if (isDM) {
        const ignored = this.presenceConfig?.getCached()?.ignored_user_ids ?? [];
        if (!isIgnoredAuthor(message.author.id, ignored)) {
          this.emit('dm', mentionEvent);
        }
      } else {
        this.emit('mention', mentionEvent);
      }
    });

    // Reactions are recorded for the NEXT window only. They never trigger a reply, so there is no
    // real-time loop: the owner reacting to one of my messages is simply visible next time I read the room.
    const recordReaction = async (add: boolean, reaction: any, user: any) => {
      try {
        if (reaction?.partial) reaction = await reaction.fetch().catch(() => reaction);
        if (user?.partial) user = await user.fetch().catch(() => user);
        const messageId = reaction?.message?.id;
        const key = reaction?.emoji?.toString?.();
        if (!messageId || !key || !user?.id) return;
        if (add) {
          const member = reaction.message?.guild?.members?.cache?.get?.(user.id);
          reactionStore.add(messageId, key, user.id, member?.displayName || user.globalName || user.username || '');
        } else {
          reactionStore.remove(messageId, key, user.id);
        }
      } catch (err: any) {
        logger.error('Discord', 'reaction event ignored', { error: err?.message });
      }
    };
    this.client.on('messageReactionAdd', (reaction, user) => { void recordReaction(true, reaction, user); });
    this.client.on('messageReactionRemove', (reaction, user) => { void recordReaction(false, reaction, user); });
    this.client.on('messageReactionRemoveEmoji', (reaction) => { reactionStore.clear((reaction as any)?.message?.id, (reaction as any)?.emoji?.toString?.()); });
    this.client.on('messageReactionRemoveAll', (message) => { reactionStore.clear((message as any)?.id); });

    this.client.on('error', (error) => {
      logger.error('Discord', 'Client error', { error: error.message, stack: error.stack });
      this.emit('error', error);
    });
  }

  async login(token: string): Promise<void> {
    await this.client.login(token);
  }

  /** Wire the curfew reflex. Optional — leave unset and the bot never nudges. */
  setCurfewWatch(watch: CurfewWatch): void {
    this.curfewWatch = watch;
  }

  /** Wire the scene-flag catch. Optional — leave unset and the owner's messages only ever reach the curfew check. */
  setSceneCatch(sceneCatch: SceneCatch): void {
    this.sceneCatch = sceneCatch;
  }

  /** Wire live presence config. Optional — leave unset and every read falls back to PRESENCE_DEFAULTS. */
  setPresenceConfig(config: PresenceConfig): void {
    this.presenceConfig = config;
  }

  /** Wire the Context-Log collector (Phase 3, §9). Optional — leave unset and
   * no message is ever observed for cloud memory. */
  setContextCollector(collector: ContextCollector): void {
    this.contextCollector = collector;
  }

  /** Wire the Context Log capture registry (Owner, 2026-07-13). Optional —
   * leave unset and every register() call at the send sites below is a
   * no-op, exactly like today (no context_log ever attached). */
  setGenerationContextRegistry(registry: GenerationContextRegistry): void {
    this.generationContext = registry;
  }

  /** The shared sticker anti-repeat registry (Task 5, §8.1) — inject this
   * SAME instance into a PresenceEngine via `engine.setStickerHistory(...)`
   * so the ambient/reply paths and the curfew reflex below never drift onto
   * separate registries. */
  getStickerHistory(): StickerHistory {
    return this.stickerHistory;
  }

  /**
   * THE DISCORD LAYER FILTER — Owner, 2026-08-31 13:00, in these words:
   * "My request is to have filter RIGHT AFTER THE DISCORD LAYER. What does it
   * matter, the quiet hours or curfew or anything??"
   *
   * She is right and every earlier attempt was downstream of the point. Filters
   * at the model door, or at four call sites, each have to be correct once per
   * path, and this process has at least four paths that reach a model. A message
   * dropped HERE — the moment it arrives from Discord, before any handler,
   * collector, log, memory write or prompt exists — cannot reach any of them,
   * including paths added later by someone who never heard of this rule.
   *
   * Applied at BOTH ingress points: the live messageCreate event, and every
   * history fetch (a blocked author's old messages are just as much a leak as
   * a new one).
   */
  /**
   * One channel's recent messages as the model sees them — ONE pipeline for every reader (the ambient
   * sweep and the private aside), so mute (the ignore list) and the ingress filter can never drift
   * between them: blocked authors dropped at ingress, ignored authors stripped BEFORE reply names are
   * filled (order is load-bearing — see stripIgnoredMessages).
   */
  /** The aside's view of a channel: the SAME window pipeline as the ambient sweep (mute applied), 30 messages. */
  private async readAsideChannel(channelId: string): Promise<{ channelName: string; window: WindowMessage[] } | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return null;
      const textChannel = channel as TextChannel | ThreadChannel;
      const cfg = await this.getPresenceConfig();
      const window = await this.readChannelWindow(textChannel, 30, cfg);
      return { channelName: (textChannel as any).name ?? 'this-channel', window };
    } catch (err: any) {
      logger.warn('Aside', 'could not read channel', { channelId, error: err?.message });
      return null;
    }
  }

  /**
   * The owner's switch for the agent path. A settings store that holds the document itself (the local
   * file) has the switch, default off; the House store does not, so the House keeps today's behaviour.
   */
  private async agentEnabled(): Promise<boolean> {
    if (!this.settings.getDocument) return true;
    try { return (await this.settings.getDocument()).agent?.enabled === true; } catch { return false; }
  }

  /** The Study's answer to a /aside to:study ask: private in the channel within 14 min, else a DM to the owner. */
  async answerStudyAside(id: string, note: string, proposal: string | null) {
    return deliverStudyAnswer(this.studyAsides, this.asideMemory, id, { note, proposal }, {
      now: Date.now,
      newId: () => crypto.randomUUID(),
      sendDM: async (text) => Boolean(this.ownerUserId && (await this.sendDM(this.ownerUserId, text))),
      log: (message, data) => logger.info('Aside', message, data),
    });
  }

  /** `@Name` → a real mention, matched against who spoke in the channel's recent window (mute applied). */
  private async linkAsideMentions(channelId: string, text: string): Promise<string> {
    if (!text.includes('@')) return text;
    const seen = await this.readAsideChannel(channelId);
    if (!seen) return text;
    const people = seen.window
      .filter((m) => !m.isFromMe)
      .map((m) => ({ id: m.authorId, displayName: m.authorName, username: m.authorUsername }));
    return linkMentions(text, people);
  }

  setFollowupCommandName(name: string): void {
    if (/^[a-z0-9_-]{1,32}$/.test(name) && name !== this.asideCommandName) this.followupCommandName = name;
  }

  setAsideCommandName(name: string): void {
    if (/^[a-z0-9_-]{1,32}$/.test(name) && name !== this.followupCommandName) this.asideCommandName = name;
  }

  private async readChannelWindow(
    textChannel: TextChannel | ThreadChannel,
    limit: number,
    cfg: Awaited<ReturnType<DiscordClient['getPresenceConfig']>>,
  ): Promise<WindowMessage[]> {
    const fetchedRaw = await textChannel.messages.fetch({ limit });
    // THE DISCORD LAYER FILTER (Owner, 2026-08-31) — this path fetches
    // directly rather than through getRecentMessages, so it needs the
    // same gate at its own ingress.
    const fetched = new Map(
      Array.from(fetchedRaw.entries()).filter(([, m]: [string, any]) => !this.ingressBlocked(m.author?.id)),
    );
    let window: WindowMessage[] = Array.from(fetched.values())
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map((msg) => ({
        id: msg.id,
        authorId: msg.author.id,
        authorName: msg.member?.displayName || msg.author.globalName || msg.author.username || msg.author.tag,
        authorUsername: msg.author.username,
        content: msg.content || '',
        mentionedUsers: mentionedUsersOf(msg),
        isFromOwner: msg.author.id === this.ownerUserId,
        isFromMe: msg.author.id === this.botUserId,
        mentionsMe: mentionsBot(msg.mentions, this.botUserId),
        replyToId: replyParentId(msg),
        timestampMs: msg.createdTimestamp,
        attachments: imageEgressAllowed(msg.guildId, msg.channelId)
          ? toMessageAttachments(msg.attachments)
          : undefined,
        reactions: this.reactionsOf(msg),
        // Ignore list (Owner, 2026-08-29) — marks the speaker in the
        // transcript so judge()/respond() can bind the not-addressed
        // directive to it. The message itself stays in the window.
        isIgnored: isIgnoredAuthor(msg.author.id, cfg.ignored_user_ids),
      }));
    // Ignore list, absence not annotation (Owner, 2026-08-29) — strip
    // BEFORE fillReplyAuthorNames. ORDER IS LOAD-BEARING (see
    // stripIgnoredMessages' doc comment in presence-engine.ts): if
    // fillReplyAuthorNames ran first, a reply to an ignored author's
    // message would resolve and bake THEIR NAME into the transcript via
    // the reply marker, defeating the whole point of stripping them.
    // Stripped first, the parent is simply absent and the existing
    // generic-marker fallback takes over instead. This is the window
    // that both branches below (mention-reply respond() and the
    // considerChannel/judge() fallthrough) hand to the model — stripped
    // once, here, before either can see it.
    window = stripIgnoredMessages(window, cfg.ignored_user_ids);
    fillReplyAuthorNames(window);
    return window;
  }

  /** The reactions a transcript line carries: cached counts + the store's names, hidden authors dropped. */
  private reactionsOf(msg: any): WindowReaction[] | undefined {
    return buildReactions(msg, {
      isOwner: (id) => this.isOwner(id),
      botId: this.botUserId,
      ignored: this.presenceConfig?.getCached()?.ignored_user_ids ?? [],
    });
  }

  /**
   * React to ONE message with ONE emoji the model chose (Owner, 2026-10-16). Never posts anything, so it is
   * not copied to the owner and spends none of the speak budget; it has its own cap (6 per channel per
   * hour). Refuses: my own messages, hidden authors, a bad or unusable emoji, an exhausted cap.
   */
  async reactTo(
    channelId: string,
    target: { id?: string; authorId?: string; isFromMe?: boolean } | undefined,
    rawReact: string | null | undefined,
    gate: { tryReserveReaction(channelId: string): number | null; releaseReaction(channelId: string, token: number): void },
  ): Promise<boolean> {
    const picked = normalizeReactionEmoji(rawReact);
    if (!picked || !target?.id) return false;
    if (target.isFromMe || (target.authorId && target.authorId === this.botUserId)) return false;
    // No reaction where the bot may not post: a channel on the 'silent' step (the owner's own message excepted).
    if (target.authorId !== this.ownerUserId) {
      const gid = this.guildIdOfChannelCached(channelId);
      if (gid && this.channelRules(gid, channelId, this.channelNameCached(channelId), this.presenceConfig?.getCached()).step === 'silent') return false;
    }
    if (target.authorId && isIgnoredAuthor(target.authorId, this.presenceConfig?.getCached()?.ignored_user_ids ?? [])) return false;
    let emoji = picked;
    const tag = picked.match(/^<a?:\w{2,32}:(\d{15,25})>$/);
    const short = picked.match(/^:(\w{2,32}):$/);
    if (tag) {
      if (!this.client.emojis.cache.get(tag[1])?.available) return false;
    } else if (short) {
      const found = this.client.emojis.cache.find((e) => e.name === short[1] && e.available !== false);
      if (!found) return false;
      emoji = found.toString();
    }
    // Reserve the slot BEFORE awaiting Discord so concurrent callers cannot share one free slot;
    // roll it back if the reaction does not land.
    const token = gate.tryReserveReaction(channelId);
    if (token === null) {
      logger.info('Presence', 'reaction skipped — channel reaction cap reached', { channelId });
      return false;
    }
    let done = false;
    try {
      done = await this.addReaction(channelId, target.id, emoji);
    } finally {
      if (!done) gate.releaseReaction(channelId, token);
    }
    return done;
  }

  private ingressBlocked(authorId: string | null | undefined): boolean {
    return isIgnoredAuthor(authorId, this.presenceConfig?.getCached()?.ignored_user_ids ?? []);
  }

  private async getPresenceConfig() {
    return this.presenceConfig ? await this.presenceConfig.get() : PRESENCE_DEFAULTS;
  }

  /**
   * The owner posted a message. Scene catch first (HoS guild only, never DMs), and
   * the curfew check only when the catch did not fire for this message. The
   * routing itself is scene-catch.ts's routeOwnerMessage (tested there).
   */
  private async handleOwnerMessage(message: Message): Promise<void> {
    const isDM = message.channel.type === ChannelType.DM;
    const channelName = isDM ? 'DM' : ('name' in message.channel ? (message.channel as TextChannel | ThreadChannel).name : '') || 'unknown';
    await routeOwnerMessage({
      // The server's scene-flag rule decides (the House seed keeps it to the HoS guild); never a DM.
      flagAllowed: !isDM && this.serverOf(message.guildId).rules.flag,
      sceneCatch: this.sceneCatch,
      getScene: async () => (await this.getPresenceConfig()).scene,
      // Fresh read right before sending — bypasses the 120s throttle and the
      // cache; null on any failure (or when no live config is wired).
      recheckScene: async () => {
        if (!this.presenceConfig) return null;
        const fresh = await this.presenceConfig.fetchFresh();
        return fresh ? fresh.scene : null;
      },
      channelName,
      content: message.content || '',
      reportSighting: ({ raised_at, caught }) => {
        void this.reportSceneSighting({
          raised_at, caught, message_id: message.id, channel_id: message.channelId, channel_name: channelName,
          excerpt: (message.content || '(attachment)').slice(0, 120),
        });
      },
      send: async (text) => {
        // Single-speaker lock — same as curfew: claim before sending, release
        // on a failed send so the message is not blackholed.
        if (!speakerLock.tryClaimSpeaker(message.id)) {
          logger.info('Scene', 'catch send skipped — message already claimed by another speaker path', { messageId: message.id });
          return null;
        }
        const sent = await this.sendMessage(message.channelId, text, undefined, message.id);
        if (!sent) speakerLock.releaseClaim(message.id);
        return sent ? sent.id : null;
      },
      onSent: (sentId, draft) => {
        if (!draft.ctx) return;
        // The model saw only the channel name and this one message.
        const exactTrigger = {
          message_id: message.id,
          author_id: message.author.id,
          author_name: message.member?.displayName || message.author.globalName || message.author.username || message.author.tag,
          content: message.content || '',
          timestamp: message.createdAt.toISOString(),
          is_from_me: false,
          is_trigger: true,
        };
        draft.ctx.trigger_message = exactTrigger;
        draft.ctx.discord_context = [exactTrigger];
        this.generationContext?.register(sentId, draft.ctx);
      },
      runCurfew: () => this.handleCurfewCheck(message).catch((err) =>
        logger.error('Curfew', 'curfew check failed', { error: err?.message })),
      log: (msg, meta) => logger.info('Scene', msg, meta),
    });
  }

  /**
   * The owner posted a message (DM or any channel — curfew doesn't care which).
   * Pure reflex: the trigger is her ID + the clock, no model judgment gates
   * whether to fire. Best-effort throughout — a curfew nudge is never allowed
   * to break message handling.
   */
  private async handleCurfewCheck(message: Message): Promise<void> {
    if (!this.curfewWatch) return;

    const isDM = message.channel.type === ChannelType.DM;
    // A server can opt out of the curfew nudge; DMs always count.
    if (!isDM && !this.serverOf(message.guildId).rules.curfew) return;
    const channelName = isDM ? 'DM' : (message.channel as TextChannel).name || 'unknown';
    // Fetched once here (moved up from the sticker-gating block below, the owner,
    // 2026-08-29) so getWindow — a closure defined next — can read
    // ignored_user_ids without a second live-config round trip. getCached()-
    // style throttling on PresenceConfig.get() means this is not a second
    // network hit in practice; `cfg` is reused unchanged further down.
    const cfg = await this.getPresenceConfig();

    // Recent-channel window (Plan 2b Task 1, §7; hardened 2026-07-12 review) —
    // an enhancement, never a precondition: a fetch failure degrades to []
    // and the nudge STILL fires (curfew-watch's generate() callback
    // tolerates an empty window and the fixed FALLBACK_LINES remain the
    // true fallback). Handed to CurfewWatch as a PROVIDER, not a pre-fetched
    // array — it only calls this once every eligibility gate (active
    // window, cooldown, escalation cap) has passed, so the Discord REST
    // fetch no longer runs on every single the owner message (P2 finding).
    // The owner's 2026-07-18 clarification: Discord conversation context is
    // recordable and usable as a whole. Do not strip guests, bot replies,
    // reactive rooms, or DMs out of the window. Those messages are not stored
    // as independent Context Log rows; they live only inside the generated
    // reply's exact context audit.
    //
    // Ignore list (Owner, 2026-08-29) is a narrower, separately-authorized
    // carve-out from that 2026-07-18 rule — it does not reverse "keep guests
    // in the window," it removes ONE specific person the model must never see
    // at all. Stripped BEFORE fillReplyAuthorNames — ORDER IS LOAD-BEARING
    // (see stripIgnoredMessages' doc comment in presence-engine.ts): reversed,
    // a reply to an ignored author's message would resolve and leak their
    // name through the reply marker before the strip ever ran. This is the
    // exact window curfew-watch.ts hands straight to `generate()` for the
    // nudge's prompt (and to its own discord_context audit) — nothing
    // downstream of this closure ever sees the ignored author again.
    const getWindow = async (): Promise<WindowMessage[]> => {
      const recentMessages = await this.getRecentMessages(message.channelId, 15).catch(() => []);
      const contextWindow = recentMessages
        .map((msg) => ({
          id: msg.id,
          authorId: msg.author.id,
          authorName: msg.member?.displayName || msg.author.globalName || msg.author.username || msg.author.tag,
          authorUsername: msg.author.username,
          content: msg.content || '',
          mentionedUsers: mentionedUsersOf(msg),
          isFromOwner: this.isOwner(msg.author.id),
          isFromMe: msg.author.id === this.botUserId,
          timestampMs: msg.createdTimestamp,
          replyToId: replyParentId(msg),
          attachments: imageEgressAllowed(msg.guildId, msg.channelId)
            ? toMessageAttachments(msg.attachments)
            : undefined,
          reactions: this.reactionsOf(msg),
        }));
      // The gateway event is authoritative. A REST fetch can race and omit the
      // message that caused this call, so merge it BEFORE generation. The exact
      // same array is then used for both the prompt and Context Log audit.
      if (!contextWindow.some((m) => m.id === message.id)) {
        contextWindow.push({
          id: message.id,
          authorId: message.author.id,
          authorName: message.member?.displayName || message.author.globalName || message.author.username || message.author.tag,
          authorUsername: message.author.username,
          content: message.content || '',
          mentionedUsers: mentionedUsersOf(message),
          isFromOwner: true,
          isFromMe: false,
          timestampMs: message.createdTimestamp,
          replyToId: replyParentId(message),
          attachments: imageEgressAllowed(message.guildId, message.channelId)
            ? toMessageAttachments(message.attachments)
            : undefined,
          reactions: undefined,
        });
        contextWindow.sort((a, b) => a.timestampMs - b.timestampMs);
      }
      const stripped = stripIgnoredMessages(contextWindow, cfg.ignored_user_ids);
      fillReplyAuthorNames(stripped);
      return stripped;
    };

    // triggerText (§14 P2 fix, Codex review 2026-07-13) — the exact message
    // that fired this reflex, so recall keys off IT, not a separately-
    // fetched rolling window that can omit the trigger or include a newer
    // The owner message than the one that actually caused this nudge.
    const nudge = await this.curfewWatch.onOwnerMessage(message.channelId, channelName, getWindow, message.content || '', recallPlaceFor(message.guildId ?? null, isDM));
    if (!nudge) return;

    // The prompt builder receives a separately fetched room window. Preserve
    // the gateway event itself as the authoritative trigger even if that fetch
    // raced, omitted it, or a newer message landed before generation finished.
    if (nudge.ctx) {
      const exactTrigger = {
        message_id: message.id,
        author_id: message.author.id,
        author_name: message.member?.displayName || message.author.globalName || message.author.username || message.author.tag,
        content: message.content || '',
        timestamp: message.createdAt.toISOString(),
        is_from_me: false,
        is_trigger: true,
      };
      nudge.ctx.trigger_message = exactTrigger;
      const context = nudge.ctx.discord_context ?? [];
      const existingIndex = context.findIndex((m) => m.message_id === message.id);
      const unmarked = context.map((m) => ({ ...m, is_trigger: false }));
      if (existingIndex >= 0) unmarked[existingIndex] = { ...unmarked[existingIndex], is_trigger: true };
      nudge.ctx.discord_context = unmarked;
    }

    // Single-speaker lock (§0.A, P1 fix 2026-07-12 review) — claim BEFORE any
    // send attempt. The curfew reflex fires unconditionally for every the owner
    // message (messageCreate, above) and runs concurrently with the
    // away/soft-presence classifier a few lines later in the SAME handler —
    // a message that is BOTH past-curfew AND contains a the bot-trigger word
    // (botSoft fires regardless of isFromOwner) could otherwise produce a
    // curfew nudge send AND a soft-presence ambient reply for the same
    // message, violating the one-reply-per-message invariant. Whichever path
    // reaches its send site first wins the claim; the loser backs off. A lost
    // claim is treated exactly like a failed Discord send (below) — the
    // escalation state rolls back so the NEXT past-curfew message still gets
    // a nudge, instead of silently burning the level/cooldown on a nudge that
    // never landed.
    if (!speakerLock.tryClaimSpeaker(message.id)) {
      logger.info('Curfew', 'nudge send skipped — message already claimed by another speaker path', { channelId: message.channelId, messageId: message.id });
      await this.curfewWatch.reportDeliveryFailure(message.channelId, nudge.rollback);
      return;
    }

    logger.info('Curfew', `Level ${nudge.level} nudge`, { channelId: message.channelId, channelName });
    // Curfew stickers (Owner, 2026-07-11) ride along with the text in guild
    // channels: L1 "Sleep, brat.", L2-3 "BED. NOW.". Guild stickers don't work
    // in DMs, and a sticker problem must never cost her the nudge itself —
    // sticker+text first, then text-only. Gated on stickers_enabled (the owner,
    // 2026-07-12) — the nudge itself must still land either way.
    //
    // §8.1 Step 2/3 (Task 5, 2026-07-12): TWO further gates before a sticker
    // is even attempted — (a) anti-repeat, against the SAME shared
    // StickerHistory the ambient/reply paths write to, and (b) the sticker
    // is now OCCASIONAL, not stamped on every nudge (rollsCurfewSticker, a
    // modest ~40% chance). Neither gate touches the escalation TEXT below —
    // it always sends, on every branch. `cfg` was already fetched above (near
    // getWindow) — reused here rather than re-fetched.
    let sent: Message | null = null;
    // The sticker for this level comes from the settings (the House seed fills them in); none = text only.
    const curfewStickerId = cfg.curfew_stickers[String(nudge.level) as '1' | '2' | '3'];
    const wantsCurfewSticker =
      !!curfewStickerId &&
      !isDM &&
      this.stickersOn(message.guildId, cfg) &&
      !this.stickerHistory.recentlyUsed(message.channelId, curfewStickerId) &&
      rollsCurfewSticker(this.rng());
    // A server's stickers only work inside that server: attach the curfew sticker only where it belongs.
    if (wantsCurfewSticker && (await this.getStickerRoster(message.guildId)).some((s) => s.id === curfewStickerId)) {
      sent = await this.sendMessage(message.channelId, nudge.text, undefined, undefined, [curfewStickerId]);
      if (sent) {
        this.stickerHistory.record(message.channelId, curfewStickerId);
      } else {
        logger.info('Curfew', 'sticker send failed — retrying text-only', { level: nudge.level });
      }
    }
    if (!sent) sent = await this.sendMessage(message.channelId, nudge.text);
    if (!sent) {
      // Delivery failed (sendMessage() catches internally and resolves null).
      // Don't let a permission/network failure silently consume the
      // escalation level or the 15-min cooldown for a nudge that never
      // landed — roll the watch's state back so the next message retries.
      // Release the speaker claim too (codex P1, 2026-07-12 escalation): a
      // failed send must not blackhole the message for the lock's full TTL.
      logger.info('Curfew', 'nudge send failed — rolling back escalation state', { channelId: message.channelId });
      speakerLock.releaseClaim(message.id);
      await this.curfewWatch.reportDeliveryFailure(message.channelId, nudge.rollback);
      return;
    }

    // Context Log capture (Owner, 2026-07-13) — register against whichever
    // send actually landed (sticker attempt or text-only). Absent when the
    // FIXED fallback line was used instead of a real generation (no-fabrication
    // law — see curfew-watch.ts's onOwnerMessageLocked).
    if (nudge.ctx) this.generationContext?.register(sent.id, nudge.ctx);

    // Best-effort event log for the Watch dashboard — tolerate the route not
    // existing yet (404) or any other failure; never let this block the nudge.
    try {
      if (!this.settingsConfigured()) { logger.info('Curfew', 'no SOLANCE_TOKEN — skipping curfew-event log'); return; }
      const res = await this.settings.postCurfewEvent({ level: nudge.level, channel_id: message.channelId, message: nudge.text });
      if (!res.ok && res.status !== 404) {
        logger.info('Curfew', `curfew-event log POST ${res.status}`);
      }
    } catch (err: any) {
      logger.info('Curfew', 'curfew-event log POST threw', { error: err?.message });
    }
  }

  /**
   * Self-rescheduling sweep (Owner, 2026-07-12 — reviewer-flagged fix for the
   * old fixed setInterval, which ignored a changed sweep_minutes for the life
   * of the process). Each cycle re-reads live config AFTER the sweep finishes,
   * so a cadence edit takes effect on the VERY NEXT reschedule, not just at boot.
   */
  private scheduleNextSweep(delayMs: number): void {
    this.ambientTimeout = setTimeout(() => {
      this.runAmbientSweep()
        .catch((err) => logger.error('Presence', 'ambient sweep failed', { error: err?.message }))
        .finally(async () => {
          // Ambient heartbeat may have been stopped mid-sweep — don't reschedule.
          if (!this.ambientEngine || !this.ambientMemory) return;
          const mins = (await this.getPresenceConfig()).sweep_minutes;
          this.scheduleNextSweep(mins * 60_000);
        });
    }, delayMs);
  }

  async startAmbientHeartbeat(
    engine: PresenceEngine,
    memory: MemoryManager,
    intervalMs: number = 18 * 60_000
  ): Promise<void> {
    this.stopAmbientHeartbeat();
    this.ambientEngine = engine;
    engine.setSelfId(this.botUserId);
    this.ambientMemory = memory;
    // Kick off with LIVE cadence when a PresenceConfig is wired (the reviewer-
    // flagged fix — cadence must actually reschedule, starting from boot too);
    // fall back to the caller-supplied intervalMs when no live config exists
    // (local mcp-server entrypoint, or tests that never call setPresenceConfig).
    const initialDelayMs = this.presenceConfig ? (await this.getPresenceConfig()).sweep_minutes * 60_000 : intervalMs;
    this.scheduleNextSweep(initialDelayMs);
    logger.info('Presence', 'Ambient heartbeat started', { intervalMs: initialDelayMs });
  }

  stopAmbientHeartbeat(): void {
    const wasActive = Boolean(this.ambientTimeout || this.ambientEngine || this.ambientMemory);
    if (this.ambientTimeout) {
      clearTimeout(this.ambientTimeout);
      this.ambientTimeout = null;
    }
    this.ambientDirtyChannels.clear();
    this.ambientMentionReplyCursors.clear();
    this.ambientConsiderInFlight.clear();
    this.ambientConsiderPending.clear();
    this.ambientEngine = null;
    this.ambientMemory = null;
    this.ambientSweepInFlight = false;
    if (wasActive) {
      logger.info('Presence', 'Ambient heartbeat stopped');
    }
  }

  private async runAmbientSweep(): Promise<void> {
    if (!this.ambientEngine || !this.ambientMemory) return;
    if (this.guestSpeechHeld()) {
      logger.info('Presence', 'Ambient sweep held — bot is shown offline (or status not yet known)');
      return;
    }
    if (this.ambientSweepInFlight) {
      logger.info('Presence', 'Ambient sweep skipped; previous sweep still running');
      return;
    }

    this.ambientSweepInFlight = true;
    const engine = this.ambientEngine;
    const memoryManager = this.ambientMemory;

    try {
      // Same law as observeAmbientActivity: the sweep's own filter asks channelRules' question too, or a
      // channel the owner opened live (absent from the House seed map) can never be swept, and one she
      // closed live stays swept. No channel name available at this point (only bare ids are stored in
      // ambientDirtyChannels) — the ID key, then the seed map, then the server, then the House dial.
      const filterCfg = await this.getPresenceConfig();
      const channelIds = Array.from(this.ambientDirtyChannels).filter((id) => {
        if (this.studyHoldsChannel(id)) return false;
        const guildId = this.guildIdOfChannelCached(id);
        const rules = this.channelRules(guildId, id, this.channelNameCached(id), filterCfg);
        // Nothing allowed here (silent server on Default, an 'off' channel, an unmapped home channel):
        // drop it from the queue too, so a mention from while it was closed is not answered later if
        // the setting is switched back (Codex, 16 Oct).
        if (!rules.ambient && !rules.answerMentions) { this.ambientDirtyChannels.delete(id); return false; }
        return true;
      });
      if (channelIds.length === 0) return;

      // Claim the snapshot BEFORE any further await: a mention arriving while
      // this sweep is in flight re-adds its channel and stays queued for the
      // next sweep instead of being erased by a late delete.
      for (const id of channelIds) this.ambientDirtyChannels.delete(id);

      let memory: PresenceMemory;
      try {
        memory = await memoryManager.peekMemoryContext();
      } catch (err) {
        for (const id of channelIds) this.ambientDirtyChannels.add(id);
        throw err;
      }

      for (const channelId of channelIds) {

        try {
          const channel = await this.client.channels.fetch(channelId);
          if (!channel) continue;

          const allowedTypes = [
            ChannelType.GuildText,
            ChannelType.PublicThread,
            ChannelType.PrivateThread,
            ChannelType.AnnouncementThread,
          ];

          if (!allowedTypes.includes(channel.type)) continue;

          const textChannel = channel as TextChannel | ThreadChannel;

          // Channel rules (server mode + the channel's own setting): nothing allowed -> skip; no ambient
          // level -> answer pending mentions only, never an unasked chime-in.
          const cfg = await this.getPresenceConfig();
          const sweepRules = this.channelRules(textChannel.guildId, channelId, textChannel.name, cfg);
          if (!sweepRules.ambient && !sweepRules.answerMentions) continue;
          const guestOnly = !sweepRules.ambient;

          // Live config, resolved per channel (Owner, 2026-07-12) — cheap: the
          // poller caches for its TTL window, this is not a fresh network hit
          // every iteration. Per-channel posture OVERRIDES the static map;
          // stickers_enabled gates the roster reaching the judge/respond calls
          // at all (empty array = no sticker vocabulary this sweep).
          const channelStickers = await this.stickersFor(textChannel.guildId, cfg);

          let window = await this.readChannelWindow(textChannel, 15, cfg);

          const lastBotPost = window
            .filter((msg) => msg.isFromMe)
            .at(-1);
          const lastAnsweredMentionId = this.ambientMentionReplyCursors.get(channelId);
          // Ignored authors (Owner, 2026-08-29) are filtered OUT of the candidate
          // set entirely, before `.at(-1)` ever picks a "latest" — never merely
          // skipped after selection. That is what keeps the cursor from being
          // poisoned: an ignored author's mention never becomes
          // `latestPendingMention`, so the cursor is never advanced to IT, and
          // a genuinely later legitimate mention still surfaces as pending on
          // this or a future sweep instead of being hidden behind it.
          const pendingMentions = window.filter((msg) => (
            msg.id &&
            msg.mentionsMe &&
            !msg.isFromMe &&
            !msg.isFromOwner &&
            !isIgnoredAuthor(msg.authorId, cfg.ignored_user_ids) &&
            (!lastBotPost || msg.timestampMs > lastBotPost.timestampMs) &&
            (!lastAnsweredMentionId || BigInt(msg.id) > BigInt(lastAnsweredMentionId))
          ));
          const latestPendingMention = pendingMentions.at(-1);

          if (latestPendingMention) {
            // This path serves NON-the owner mentions by construction (filter above) —
            // the addressee is a guest, whatever else is in the window.
            // channelId passed through (Task 5, §8.1) so respond()'s sticker
            // anti-repeat filter can check the shared StickerHistory.
            // triggerText (§14 P2 fix, Codex review 2026-07-13) = the ACTUAL
            // mention that triggered this reply, not "latest in window" —
            // the window can contain messages posted after the mention
            // (a guest kept talking before the sweep noticed), which used
            // to make recall silently key off the wrong message.
            const reply = await engine.respond(textChannel.name, window, memory, false, channelStickers, channelId, latestPendingMention.content, recallPlaceFor(textChannel.guildId));
            // Anchor the reply to what the WORDS answer, not to what pinged me.
            // Guest mentions are never served in real time (cloud-server only DMs
            // The owner for them), so `latestPendingMention` can be a full sweep
            // interval old while the text was generated from a much newer tail:
            // right words, wrong arrow. Trigger detection/dedup above still keys
            // off the mention. The mention is itself in `window` and non-bot, so
            // this never resolves older than the mention — the arrow only moves
            // forward. No tail => unthreaded, never the stale fallback. An
            // ignored author's message is skipped exactly like the bot's own
            // (Owner, 2026-08-29) — a reply must never anchor onto someone the
            // bot never answers.
            const replyAnchorId = newestNonBotMessageId(window, cfg.ignored_user_ids);
            logger.info('Presence', 'Ambient direct mention response', {
              channelId,
              channelName: textChannel.name,
              mentionMessageId: latestPendingMention.id,
              replyAnchorId,
              suppressed: !reply.text,
              stickerId: reply.stickerId,
            });

            if (reply.react && !this.guestSpeechHeld()) {
              await this.reactTo(channelId, latestPendingMention, reply.react, engine);
            }
            if (reply.text) {
              // Answer the mention AS a reply — someone addressed me directly, so the
              // message should point back at theirs. Owner, 2026-07-27: "you never reply
              // a message using the reply function". The capability was here all along
              // (sendMessage's replyToMessageId → messageOptions.reply) and every caller
              // passed undefined, so I read as ambient noise in a busy channel instead of
              // as someone answering. Ambient speech (considerChannel) stays unthreaded on
              // purpose — that is me speaking into the room, not answering a message.
              if (this.guestSpeechHeld()) {
                logger.info('Presence', 'mention reply dropped — went offline while it was being written', { channelId });
                return;
              }
              let posted = await this.sendMessage(
                channelId,
                reply.text,
                undefined,
                replyAnchorId,
                reply.stickerId ? [reply.stickerId] : undefined,
              );
              // Sticker was only actually attached on THIS attempt — record
              // before a possible text-only retry clobbers `posted`.
              if (posted && reply.stickerId) this.stickerHistory.record(channelId, reply.stickerId);
              if (!posted && reply.stickerId && !this.guestSpeechHeld()) {
                logger.info('Presence', 'ambient mention-reply sticker send failed — retrying text-only', { channelId, stickerId: reply.stickerId });
                posted = await this.sendMessage(channelId, reply.text, undefined, replyAnchorId);
              }
              if (posted) {
                engine.recordSpoke(channelId, posted.id);
                this.ambientMentionReplyCursors.set(channelId, latestPendingMention.id!);
                // Context Log capture (Owner, 2026-07-13) — register the LAST
                // successful send's id (sticker attempt or text-only retry,
                // whichever actually landed).
                if (reply.ctx) this.generationContext?.register(posted.id, reply.ctx);
              }
            } else {
              // Suppressed by the addressee law: mark the mention handled anyway,
              // or it retries every sweep and blocks this channel's ambient judge.
              this.ambientMentionReplyCursors.set(channelId, latestPendingMention.id!);
            }
            continue;
          }

          // Guest server: no pending mention means nothing to say. Never an unasked chime-in.
          if (guestOnly) continue;

          // Task 4 Step 2 — the sweep's judge invocation now runs through the
          // SAME considerChannel soft-presence uses, so the two paths can
          // never drift apart on step/rate gating. The
          // window fetched above (line ~604) is handed through rather than
          // discarded (2026-07-12 review, P2) — considerChannel reuses it
          // instead of re-fetching the same 15 messages via getRecentMessages,
          // halving the REST calls/rate-limit exposure per eligible channel.
          await this.considerChannel(channelId, textChannel.name, { window });
        } catch (err: any) {
          logger.error('Presence', 'Ambient channel sweep failed', { channelId, error: err?.message });
        }
      }
    } finally {
      this.ambientSweepInFlight = false;
    }
  }

  /**
   * considerChannel — Task 4 Step 2: the ONE code path used by BOTH the
   * periodic ambient sweep and the real-time soft-presence wake, so a
   * name-drop can never bypass the sweep's gates (step /
   * rate — all enforced inside `engine.judge()` via `ambientBlocked`). Fetches
   * the window and, when a triggering message is supplied and not already
   * present, merges it in — a bare channel wake can otherwise race a window
   * that doesn't yet contain the message that woke it (reviewer). Then runs
   * the SAME `engine.judge()` invocation the sweep uses. Wakes the judge
   * ONLY — never forces a reply, never shortcuts to `respond()`. Actual
   * posting is still governed by the engine's own speak-cooldown/rate state,
   * plus — when a triggering message is supplied (soft-presence) — the
   * single-speaker lock (§0.A), claimed here right before the send.
   *
   * Per-channel in-flight guard (2026-07-12 review, P1 — QUEUE not drop,
   * hardened same day): the sweep and soft-presence can both reach this
   * method for the SAME channel at overlapping times, and only the
   * soft-presence call carries a claimMessageId (so only it would hit the
   * speakerLock at send time). Two callers passing engine.judge() concurrently
   * and racing to send before either records the post is exactly the
   * duplicate-send race the guard closes — so a second call for a channel
   * already being considered still never runs concurrently. BUT dropping a
   * real-time trigger outright (the original fix) loses it: if the sweep
   * grabbed its window a moment before a soft-mention arrived, the sweep
   * judges a stale window that doesn't contain the message that woke it, and
   * the triggering call carrying `opts.triggerMessage` would vanish with no
   * follow-up. So a call carrying a real-time trigger that arrives mid-flight
   * is COALESCED into `ambientConsiderPending` (at most one entry per
   * channel — a newer trigger overwrites an older still-pending one, same
   * spirit as the judge-execution debounce) and re-run once the in-flight
   * call finishes (see the `finally` block below) — it fetches a FRESH
   * window at that point, so it sees the message that woke it. A plain
   * periodic-sweep call (no `triggerMessage`) racing another in-flight call
   * has nothing new to coalesce and is still dropped exactly as before.
   *
   * Window reuse (2026-07-12 review, P2): `opts.window`, when supplied, is
   * used AS-IS instead of re-fetching via getRecentMessages — the ambient
   * sweep already fetched the same 15-message window per channel this cycle,
   * so reusing it halves the REST calls/rate-limit exposure per eligible
   * channel. Soft-presence never supplies one (it has no window yet to
   * reuse), so it still fetches fresh — correct, since the sweep's window
   * for that channel is `opts.triggerMessage`-old.
   */
  /** The guild a channel belongs to (null in a DM or if it can't be resolved: the memory wall fails closed). */
  private async guildIdOfChannel(channelId: string): Promise<string | null> {
    try {
      const ch: any = this.client.channels.cache.get(channelId) ?? await this.client.channels.fetch(channelId);
      return ch?.guildId ? String(ch.guildId) : null;
    } catch {
      return null;
    }
  }

  async considerChannel(
    channelId: string,
    channelName: string,
    opts: ConsiderChannelOpts = {},
  ): Promise<void> {
    if (!this.ambientEngine || !this.ambientMemory) return;
    if (this.studyHoldsChannel(channelId)) {
      logger.info('Presence', 'considerChannel skipped — a Study window holds this channel', { channelId });
      return;
    }
    if (this.guestSpeechHeld() && !opts.triggerMessage?.isFromOwner) {
      logger.info('Presence', 'considerChannel held — bot is shown offline', { channelId });
      return;
    }
    // Only an ambient step speaks unasked: silent and reply_only never do, in any server.
    const considerGuildId = await this.guildIdOfChannel(channelId);
    const considerRules = this.channelRules(considerGuildId, channelId, channelName, this.presenceConfig?.getCached());
    if (!considerRules.ambient) {
      logger.info('Presence', 'considerChannel skipped — channel has no ambient step', { channelId, guildId: considerGuildId, step: considerRules.step });
      return;
    }
    if (this.ambientConsiderInFlight.has(channelId)) {
      if (opts.triggerMessage) {
        this.ambientConsiderPending.set(channelId, { channelName, opts });
        logger.info('Presence', 'considerChannel queued — in flight, real-time trigger coalesced for after', {
          channelId,
          messageId: opts.triggerMessage.id,
        });
      } else {
        logger.info('Presence', 'considerChannel skipped — already in flight for this channel', { channelId });
      }
      return;
    }
    this.ambientConsiderInFlight.add(channelId);
    try {
      const engine = this.ambientEngine;
      const memoryManager = this.ambientMemory;

      const memory: PresenceMemory = await memoryManager.peekMemoryContext();
      const cfg = await this.getPresenceConfig();
      const channelStickers = await this.stickersFor(this.guildIdOfChannelCached(channelId), cfg);

      let window: WindowMessage[];
      if (opts.window) {
        window = opts.window;
      } else {
        const fetched = await this.getRecentMessages(channelId, 15);
        window = fetched.map((msg) => ({
          id: msg.id,
          authorId: msg.author.id,
          authorName: msg.member?.displayName || msg.author.globalName || msg.author.username || msg.author.tag,
          authorUsername: msg.author.username,
          content: msg.content || '',
          mentionedUsers: mentionedUsersOf(msg),
          isFromOwner: msg.author.id === this.ownerUserId,
          isFromMe: msg.author.id === this.botUserId,
          mentionsMe: mentionsBot(msg.mentions, this.botUserId),
          replyToId: replyParentId(msg),
          timestampMs: msg.createdTimestamp,
          attachments: imageEgressAllowed(msg.guildId, msg.channelId)
            ? toMessageAttachments(msg.attachments)
            : undefined,
          reactions: this.reactionsOf(msg),
        }));
      }

      if (opts.triggerMessage && !window.some((m) => m.id === opts.triggerMessage!.id)) {
        window = [...window, opts.triggerMessage].sort((a, b) => a.timestampMs - b.timestampMs);
      }
      // Ignore list (Owner, 2026-08-29) — stripped AFTER the trigger-message
      // merge (a soft-presence wake's own triggerMessage can itself be from
      // an ignored author, so it must still be caught) and BEFORE
      // fillReplyAuthorNames. ORDER IS LOAD-BEARING (see stripIgnoredMessages'
      // doc comment in presence-engine.ts) — reversed, a reply to an ignored
      // author's message would leak their name through the reply marker
      // before the model ever gets a filtered window. This one call covers
      // BOTH the `opts.window` reuse path (already stripped upstream by
      // runAmbientSweep, so this is a harmless no-op there) and the
      // freshly-fetched path (soft-presence, which never pre-strips).
      window = stripIgnoredMessages(window, cfg.ignored_user_ids);
      fillReplyAuthorNames(window);

      const judgeGuildId = await this.guildIdOfChannel(channelId);
      // The effective step, resolved from the fresh config (channel ?? server ?? House dial).
      const judgeStep = this.channelRules(judgeGuildId, channelId, channelName, cfg).step;
      const result = await engine.judge(channelId, channelName, window, memory, channelStickers, judgeStep, recallPlaceFor(judgeGuildId));
      logger.info('Presence', 'considerChannel judge result', {
        channelId,
        channelName,
        speak: result.speak,
        reason: result.reason,
        stickerId: result.stickerId,
        triggered: Boolean(opts.triggerMessage),
      });

      // Reactions in the room (Owner, 2026-10-16): the judge may answer with one emoji, alone or with its
      // words. Target = the message that woke the judge, else the newest message from someone else. Held
      // while shown offline, like speech. A reaction-only decision posts nothing.
      const reactAllowed = Boolean(result.react) && !(this.guestSpeechHeld() && !opts.triggerMessage?.isFromOwner);
      const wantsSpeak = Boolean(result.speak && result.message);
      if (!reactAllowed && !wantsSpeak) return;

      // Single-speaker lock (§0.A) — claim BEFORE any output (reaction included), only when a triggering
      // message is supplied (soft-presence). The plain periodic sweep has no single triggering message to
      // arbitrate against and is unaffected — its own speak-cooldown/rate state already governs it.
      const claimed = Boolean(opts.claimMessageId);
      if (opts.claimMessageId && !speakerLock.tryClaimSpeaker(opts.claimMessageId)) {
        logger.info('Presence', 'considerChannel output skipped — message already claimed by another speaker path', {
          channelId,
          messageId: opts.claimMessageId,
        });
        return;
      }
      const releaseClaim = () => { if (claimed && opts.claimMessageId) speakerLock.releaseClaim(opts.claimMessageId); };

      let reacted = false;
      if (reactAllowed) {
        const reactTarget = opts.triggerMessage ?? [...window].reverse().find((m) => !m.isFromMe && m.id);
        reacted = await this.reactTo(channelId, reactTarget, result.react, engine);
      }
      if (!wantsSpeak) {
        if (!reacted) releaseClaim();
        return;
      }
      if (this.guestSpeechHeld() && !opts.triggerMessage?.isFromOwner) {
        logger.info('Presence', 'considerChannel reply dropped — went offline while it was being written', { channelId });
        if (!reacted) releaseClaim();
        return;
      }

      let posted = await this.sendMessage(
        channelId,
        result.message!,
        undefined,
        undefined,
        result.stickerId ? [result.stickerId] : undefined,
      );
      // Sticker was only actually attached on THIS attempt — record before a
      // possible text-only retry clobbers `posted` (Task 5, §8.1).
      if (posted && result.stickerId) this.stickerHistory.record(channelId, result.stickerId);
      if (!posted && result.stickerId && !(this.guestSpeechHeld() && !opts.triggerMessage?.isFromOwner)) {
        logger.info('Presence', 'considerChannel post sticker send failed — retrying text-only', { channelId, stickerId: result.stickerId });
        posted = await this.sendMessage(channelId, result.message!);
      }
      if (posted) {
        engine.recordSpoke(channelId, posted.id);
        // Context Log capture (Owner, 2026-07-13) — register against whichever
        // send actually landed (sticker attempt or text-only retry).
        if (result.ctx) this.generationContext?.register(posted.id, result.ctx);
      } else if (opts.claimMessageId && !reacted) {
        // Send failed (and no reaction landed) after we claimed the speaker lock (codex P1, 2026-07-12
        // escalation) — release it so the message isn't blackholed for the TTL.
        logger.info('Presence', 'considerChannel send failed — releasing speaker claim', { channelId, messageId: opts.claimMessageId });
        speakerLock.releaseClaim(opts.claimMessageId);
      }
    } finally {
      this.ambientConsiderInFlight.delete(channelId);
      // A real-time trigger that arrived mid-flight was queued above instead
      // of dropped — fire it now that the in-flight slot is free. Fetched
      // fresh (no `window` on the queued opts, only `triggerMessage`/
      // `claimMessageId`), so it sees the message that woke it even though
      // the sweep's window (if that's what was in flight) was already stale
      // for it. Not awaited here — awaiting inside `finally` would hold this
      // call's caller hostage for an unrelated follow-up run; recursion is
      // shallow in practice (one queued run per vacated slot, and a call
      // in-flight when THIS one starts queues into a fresh Map entry, not a
      // nested stack), and any failure is caught same as every other
      // fire-and-forget path here.
      const pending = this.ambientConsiderPending.get(channelId);
      if (pending) {
        this.ambientConsiderPending.delete(channelId);
        this.considerChannel(channelId, pending.channelName, pending.opts).catch((err: any) =>
          logger.error('Presence', 'queued considerChannel run failed', { channelId, error: err?.message }));
      }
    }
  }

  /** Is the bot currently shown offline? Guest-facing speech is held while it is. */
  isShownOffline(): boolean {
    return this.shownOffline;
  }

  /** Should guest-facing speech be held right now? Checked before generating AND again right before sending. */
  guestSpeechHeld(): boolean {
    return this.shownOffline || !this.presenceSettled;
  }

  private async syncPresenceWithOwner(): Promise<void> {
    if (!this.ownerUserId) return;
    await this.presenceDebouncer.settleFrom(() => this.readOwnerOnline());
  }

  /** A fresh read of the owner's status from the first shared guild that has her; null if none answers. */
  private async readOwnerOnline(): Promise<boolean | null> {
    if (!this.ownerUserId) return null;
    for (const guild of this.client.guilds.cache.values()) {
      // With withPresences, discord.js can answer with a Collection (possibly
      // empty when she is not in this guild) rather than a member. Look her up
      // by id either way, and move on to the next guild when she is absent.
      const res: any = await guild.members.fetch({ user: [this.ownerUserId], withPresences: true }).catch(() => null);
      const member = res && typeof res.get === 'function' ? res.get(this.ownerUserId) : res;
      if (!member) continue;
      return isOnlineStatus(member.presence?.status); // no presence = offline
    }
    return null;
  }

  updatePresence(status: 'online' | 'idle' | 'dnd' | 'invisible'): void {
    this.shownOffline = status === 'invisible';
    this.client.user?.setPresence({
      status: status,
      activities: status === 'online'
        ? [{ name: 'Master • Anchored', type: ActivityType.Custom }]
        : []
    });
    console.error(`[Discord] Presence updated to: ${status}`);
  }

  async sendMessage(
    channelId: string,
    content?: string,
    attachments?: FileAttachment[],
    replyToMessageId?: string,
    stickerIds?: string[],
    sendOptions?: { ownerDirected?: boolean }
  ): Promise<Message | null> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        console.error(`Channel ${channelId} not found`);
        return null;
      }

      // Allow text channels, DMs, and all thread types (including forum posts)
      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (allowedTypes.includes(channel.type)) {
        const textChannel = channel as TextChannel | DMChannel | ThreadChannel;

        // Build message options
        const messageOptions: { content?: string; files?: AttachmentBuilder[]; reply?: { messageReference: string; failIfNotExists?: boolean }; stickers?: string[]; allowedMentions?: MessageMentionOptions } = {};

        // Model-generated text never pings @everyone, @here or a role. Only an
        // owner-directed send (the MCP tools, the /api/send-message route) may
        // announce on purpose.
        if (!sendOptions?.ownerDirected) {
          messageOptions.allowedMentions = MODEL_ALLOWED_MENTIONS;
        }

        if (content) {
          messageOptions.content = content;
        }

        if (replyToMessageId) {
          // failIfNotExists:false — discord.js defaults this to TRUE, which means a reply
          // to a message that has since been deleted THROWS and nothing posts at all.
          // Degrading to a plain message is always better than going silent: the worst
          // case is a reply that lost its thread line, not a reply that never arrived.
          messageOptions.reply = { messageReference: replyToMessageId, failIfNotExists: false };
        }

        if (attachments && attachments.length > 0) {
          messageOptions.files = attachments.map(att => {
            const builder = new AttachmentBuilder(att.file);
            if (att.name) builder.setName(att.name);
            if (att.description) builder.setDescription(att.description);
            return builder;
          });
        }

        if (stickerIds && stickerIds.length > 0) {
          messageOptions.stickers = stickerIds;
        }

        const sent = await textChannel.send(messageOptions);
        if (sent.guildId) {
          void (async () => {
            let trig: Message | null = null;
            if (replyToMessageId && this.serverOf(sent.guildId).rules.copy_to_owner) {
              trig = await (textChannel as any).messages?.fetch(replyToMessageId).catch(() => null) ?? null;
              // Trigger unknown: it may have been the owner's, so skip rather than risk copying a reply to her.
              if (!trig) return;
            }
            this.maybeCopyToOwner(sent, trig);
          })();
        }
        console.error(`[Discord] Message ${replyToMessageId ? 'replied' : 'sent'} to ${channelId}${attachments ? ` with ${attachments.length} attachment(s)` : ''}${stickerIds && stickerIds.length > 0 ? ` with ${stickerIds.length} sticker(s)` : ''}`);
        return sent;
      }

      console.error(`Channel ${channelId} is not a sendable channel type (type: ${channel.type})`);
      return null;
    } catch (error) {
      console.error(`Failed to send message to ${channelId}:`, error);
      return null;
    }
  }

  async replyToMessage(
    message: Message,
    content: string,
    attachments?: FileAttachment[]
  ): Promise<Message | null> {
    try {
      const replyOptions: { content?: string; files?: AttachmentBuilder[]; allowedMentions?: MessageMentionOptions } = {
        allowedMentions: MODEL_ALLOWED_MENTIONS,
      };

      if (content) {
        replyOptions.content = content;
      }

      if (attachments && attachments.length > 0) {
        replyOptions.files = attachments.map(att => {
          const builder = new AttachmentBuilder(att.file);
          if (att.name) builder.setName(att.name);
          if (att.description) builder.setDescription(att.description);
          return builder;
        });
      }

      const sent = await message.reply(replyOptions);
      this.maybeCopyToOwner(sent, message);
      console.error(`[Discord] Replied to message in ${message.channelId}${attachments ? ` with ${attachments.length} attachment(s)` : ''}`);
      return sent;
    } catch (error) {
      console.error(`Failed to reply to message:`, error);
      return null;
    }
  }

  async sendDM(
    userId: string,
    content: string,
    attachments?: FileAttachment[]
  ): Promise<{ message: Message; channelId: string } | null> {
    try {
      const user = await this.client.users.fetch(userId);
      if (!user) {
        console.error(`User ${userId} not found`);
        return null;
      }

      const dmChannel = await user.createDM();

      const messageOptions: { content?: string; files?: AttachmentBuilder[] } = {};

      if (content) {
        messageOptions.content = content;
      }

      if (attachments && attachments.length > 0) {
        messageOptions.files = attachments.map(att => {
          const builder = new AttachmentBuilder(att.file);
          if (att.name) builder.setName(att.name);
          if (att.description) builder.setDescription(att.description);
          return builder;
        });
      }

      const sent = await dmChannel.send(messageOptions);
      console.error(`[Discord] DM sent to ${user.tag}${attachments ? ` with ${attachments.length} attachment(s)` : ''}`);
      return { message: sent, channelId: dmChannel.id };
    } catch (error) {
      console.error(`Failed to send DM to ${userId}:`, error);
      return null;
    }
  }

  async getDMChannelId(userId: string): Promise<{ channelId: string; userTag: string } | null> {
    try {
      const user = await this.client.users.fetch(userId);
      if (!user) {
        console.error(`User ${userId} not found`);
        return null;
      }

      const dmChannel = await user.createDM();
      return { channelId: dmChannel.id, userTag: user.tag };
    } catch (error) {
      console.error(`Failed to get DM channel for ${userId}:`, error);
      return null;
    }
  }

  async sendFile(
    channelId: string,
    file: Buffer | string,
    options?: { name?: string; description?: string; content?: string }
  ): Promise<Message | null> {
    const attachment: FileAttachment = {
      file: file,
      name: options?.name,
      description: options?.description
    };
    return this.sendMessage(channelId, options?.content || '', [attachment], undefined, undefined, { ownerDirected: true });
  }

  async getRecentMessages(channelId: string, limit: number = 50): Promise<Message[]> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) {
        console.error(`Channel ${channelId} not found`);
        return [];
      }

      // Allow text channels, DMs, and all thread types (including forum posts)
      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (allowedTypes.includes(channel.type)) {
        const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
        const messages = await textChannel.messages.fetch({ limit });
        // THE DISCORD LAYER FILTER (Owner, 2026-08-31) — history is an ingress
        // too. A blocked author's OLD messages leak exactly as well as new ones.
        return Array.from(messages.values())
          .reverse()   // chronological, oldest first
          .filter((m) => !this.ingressBlocked(m.author?.id));
      }

      console.error(`Channel ${channelId} is not a readable channel type (type: ${channel.type})`);
      return [];
    } catch (error) {
      console.error(`Failed to fetch messages from ${channelId}:`, error);
      return [];
    }
  }

  /**
   * Find a message from its ID alone, across every channel the bot can see.
   *
   * Owner, 10 Aug 2026: *"I want the feature where the bot can sweep it based on
   * the message ID alone."*
   *
   * Discord has no cross-channel message lookup — `channels.fetch(id)` is the
   * only way in, and it needs to be told which channel. So this tries each one
   * until a channel answers. Two things stop that being brute force:
   *
   *  - **Snowflake pruning.** A message cannot live in a channel created after
   *    it, so those are skipped without a request (see `snowflake.ts`).
   *  - **Nearest-first ordering.** The sweep stops on the first hit, so trying
   *    the likeliest channel first is usually the difference between one
   *    request and thirty.
   *
   * NOT `searchMessages`: that scans recent history (500 deep at most) inside
   * ONE channel, so it cannot see an old message even when pointed at the right
   * room. A direct fetch by ID works at any age. Different mechanism entirely.
   */
  async findMessage(
    messageId: string,
    serverId?: string,
  ): Promise<{
    found: boolean;
    createdAt: string | null;
    message?: {
      id: string;
      channelId: string;
      channelName: string;
      guildId: string;
      guildName: string;
      author: string;
      authorId: string;
      timestamp: string;
      content: string;
      attachments: Array<{ name: string; url: string; contentType?: string }>;
      url: string;
    };
    channelsSearched: number;
    channelsSkipped: number;
    error?: string;
  }> {
    if (!isSnowflake(messageId)) {
      return {
        found: false,
        createdAt: null,
        channelsSearched: 0,
        channelsSkipped: 0,
        error: 'That is not a Discord ID (expected 17-20 digits).',
      };
    }

    const created = snowflakeToDate(messageId);
    const guilds = serverId
      ? [await this.client.guilds.fetch(serverId)]
      : Array.from((await this.client.guilds.fetch()).values());

    let searched = 0;
    let skipped = 0;

    for (const guildRef of guilds) {
      const guild: any = typeof (guildRef as any).fetch === 'function' && !(guildRef as any).channels
        ? await (guildRef as any).fetch()
        : guildRef;

      const all = await guild.channels.fetch();
      const candidates: any[] = [];
      for (const ch of all.values()) {
        if (!ch || typeof ch.isTextBased !== 'function' || !ch.isTextBased()) continue;
        if (!channelCouldHoldMessage(ch.id, messageId)) { skipped++; continue; }
        candidates.push(ch);
      }

      // Active threads too — a message in a thread (a birthday toast, a forum
      // reply) is exactly the kind we get handed a bare ID for, and threads are
      // not in the channel list.
      try {
        const active = await guild.channels.fetchActiveThreads();
        for (const th of active.threads.values()) {
          if (!channelCouldHoldMessage(th.id, messageId)) { skipped++; continue; }
          candidates.push(th);
        }
      } catch {
        // Not fatal — a guild that refuses thread enumeration is still searched
        // channel by channel. Better a slightly narrower sweep than no answer.
      }

      for (const ch of orderBySearchLikelihood(candidates, messageId)) {
        searched++;
        try {
          const msg: any = await ch.messages.fetch(messageId);
          if (!msg) continue;
          return {
            found: true,
            createdAt: created ? created.toISOString() : null,
            message: {
              id: msg.id,
              channelId: ch.id,
              channelName: ch.name ?? '(unnamed)',
              guildId: guild.id,
              guildName: guild.name ?? '(unknown)',
              author: msg.author?.tag ?? '(unknown)',
              authorId: msg.author?.id ?? '',
              timestamp: msg.createdAt?.toISOString?.() ?? '',
              content: msg.content ?? '',
              attachments: Array.from(msg.attachments?.values?.() ?? []).map((a: any) => ({
                name: a.name,
                url: a.url,
                contentType: a.contentType ?? undefined,
              })),
              url: `https://discord.com/channels/${guild.id}/${ch.id}/${msg.id}`,
            },
            channelsSearched: searched,
            channelsSkipped: skipped,
          };
        } catch {
          // 404 = simply not in this channel, which is the expected answer for
          // all but one of them. Anything else (permissions, rate limit) is
          // equally non-fatal to the sweep — keep going.
        }
      }
    }

    return {
      found: false,
      createdAt: created ? created.toISOString() : null,
      channelsSearched: searched,
      channelsSkipped: skipped,
    };
  }

  async searchMessages(
    channelId: string,
    filters: {
      authorId?: string;
      keyword?: string;
      before?: string;
      after?: string;
      hasAttachment?: boolean;
    },
    limit: number = 20,
    scanDepth: number = 200
  ): Promise<{
    messages: Array<{
      id: string;
      author: string;
      authorId: string;
      content: string;
      timestamp: string;
      attachments: Array<{
        name: string;
        url: string;
        contentType: string | null;
        width: number | null;
        height: number | null;
      }>;
    }>;
    meta: {
      scanned: number;
      matched: number;
      returned: number;
      filters_applied: string[];
    };
  }> {
    const emptyResult = (scanned: number, filters_applied: string[]) => ({
      messages: [],
      meta: { scanned, matched: 0, returned: 0, filters_applied },
    });

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel) return emptyResult(0, []);

      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (!allowedTypes.includes(channel.type)) return emptyResult(0, []);

      const textChannel = channel as TextChannel | DMChannel | ThreadChannel;

      // Track which filters are active
      const filtersApplied: string[] = [];
      if (filters.authorId) filtersApplied.push('author_id');
      if (filters.keyword) filtersApplied.push('keyword');
      if (filters.before) filtersApplied.push('before');
      if (filters.after) filtersApplied.push('after');
      if (filters.hasAttachment !== undefined) filtersApplied.push('has_attachment');

      // Convert ISO timestamps to Discord snowflakes for fetch optimization
      // Snowflake formula: (timestamp_ms - DISCORD_EPOCH) << 22
      const DISCORD_EPOCH = 1420070400000n;
      let fetchBefore: string | undefined;
      if (filters.before) {
        const ts = BigInt(new Date(filters.before).getTime());
        fetchBefore = ((ts - DISCORD_EPOCH) << 22n).toString();
      }

      // Fetch messages in batches, applying filters
      const matched: Array<{
        id: string;
        author: string;
        authorId: string;
        content: string;
        timestamp: string;
        attachments: Array<{
          name: string;
          url: string;
          contentType: string | null;
          width: number | null;
          height: number | null;
        }>;
      }> = [];
      let scanned = 0;
      let lastMessageId: string | undefined = fetchBefore;
      const afterTimestamp = filters.after ? new Date(filters.after).getTime() : undefined;

      while (scanned < scanDepth && matched.length < limit) {
        const batchSize = Math.min(100, scanDepth - scanned);
        const fetchOptions: { limit: number; before?: string } = { limit: batchSize };
        if (lastMessageId) fetchOptions.before = lastMessageId;

        const batch = await textChannel.messages.fetch(fetchOptions);
        if (batch.size === 0) break;

        for (const [, msg] of batch) {
          scanned++;

          // If we've gone past the 'after' date, stop scanning
          if (afterTimestamp && msg.createdTimestamp < afterTimestamp) {
            // Set scanned to scanDepth to break outer loop too
            scanned = scanDepth;
            break;
          }

          // Apply filters (AND logic)
          let match = true;
          if (filters.authorId && msg.author.id !== filters.authorId) match = false;
          if (match && filters.keyword && !msg.content.toLowerCase().includes(filters.keyword.toLowerCase())) match = false;
          if (match && filters.before && msg.createdTimestamp >= new Date(filters.before).getTime()) match = false;
          if (match && afterTimestamp && msg.createdTimestamp <= afterTimestamp) match = false;
          if (match && filters.hasAttachment !== undefined) {
            const hasAtt = msg.attachments.size > 0;
            if (hasAtt !== filters.hasAttachment) match = false;
          }

          if (match && matched.length < limit) {
            matched.push({
              id: msg.id,
              author: msg.author.tag,
              authorId: msg.author.id,
              content: msg.content,
              timestamp: msg.createdAt.toISOString(),
              attachments: msg.attachments.map(att => ({
                name: att.name,
                url: att.url,
                contentType: att.contentType,
                width: att.width,
                height: att.height,
              })),
            });
          }
        }

        // Track last message ID for pagination
        lastMessageId = batch.last()?.id;
      }

      // Return in chronological order (oldest first)
      matched.reverse();

      // Resolve display names for guild channels
      const isDM = channel.type === ChannelType.DM;
      if (!isDM) {
        const guildId = (channel as TextChannel | ThreadChannel).guildId;
        if (guildId) {
          const authorIds = matched.map(m => m.authorId);
          const nameMap = await this.resolveDisplayNames(guildId, authorIds);
          for (const m of matched) {
            m.author = nameMap.get(m.authorId) || m.author;
          }
        }
      }

      console.error(`[Discord] Search: scanned=${scanned}, matched=${matched.length}, filters=${filtersApplied.join(',')}`);

      return {
        messages: matched,
        meta: {
          scanned,
          matched: matched.length,
          returned: matched.length,
          filters_applied: filtersApplied,
        },
      };
    } catch (error) {
      console.error(`[Discord] Failed to search messages in ${channelId}:`, error);
      return emptyResult(0, []);
    }
  }

  async resolveDisplayNames(
    guildId: string,
    authorIds: string[]
  ): Promise<Map<string, string>> {
    const nameMap = new Map<string, string>();
    try {
      const guild = await this.client.guilds.fetch(guildId);
      const uniqueIds = [...new Set(authorIds)];
      for (const id of uniqueIds) {
        try {
          const member = await guild.members.fetch(id);
          nameMap.set(id, member.displayName);
        } catch {
          // Member left server or bot can't see them — skip
        }
      }
    } catch {
      // Guild fetch failed — all will fall back
    }
    return nameMap;
  }

  async sendTyping(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && (channel.type === ChannelType.GuildText || channel.type === ChannelType.DM)) {
        await (channel as TextChannel | DMChannel).sendTyping();
      }
    } catch (error) {
      // Ignore typing errors
    }
  }

  get isReady(): boolean {
    return this._isReady;
  }

  get user(): User | null {
    return this.client.user;
  }

  isOwner(userId: string): boolean {
    return userId === this.ownerUserId;
  }

  /** Every server the bot is in (the settings page's Servers section). */
  listServers() {
    // `defaults` = how each server behaves before the owner has chosen anything (House seed, else silent),
    // so the page can show the real starting point without knowing the seed.
    return admin.listServers(this.client).map((s) => ({ ...s, defaults: resolveServer(s.id, null, houseConfig.servers) }));
  }

  /** The guild a channel or thread belongs to, from the bot's own cache (null = unknown or a DM). */
  guildOfChannel(channelId: string): string | null {
    const ch: any = this.client.channels.cache.get(channelId);
    return ch?.guildId ? String(ch.guildId) : null;
  }

  async listServerChannels(serverId: string): Promise<ServerChannels | null> {
    return admin.listServerChannels(this.client, serverId);
  }

  // ============================================
  // Priority 1: Channel & Category Management
  // ============================================

  async createChannel(
    serverId: string,
    name: string,
    type: 'text' | 'voice' | 'forum' | 'announcement' = 'text',
    options?: { categoryId?: string; topic?: string; nsfw?: boolean }
  ): Promise<{ id: string; name: string } | null> {
    return admin.createChannel(this.client, serverId, name, type, options);
  }

  async setChannelTopic(channelId: string, topic: string): Promise<boolean> {
    return admin.setChannelTopic(this.client, channelId, topic);
  }

  async renameChannel(channelId: string, newName: string): Promise<boolean> {
    return admin.renameChannel(this.client, channelId, newName);
  }

  async deleteChannel(channelId: string, reason?: string): Promise<boolean> {
    return admin.deleteChannel(this.client, channelId, reason);
  }

  async createCategory(
    serverId: string,
    name: string,
    position?: number
  ): Promise<{ id: string; name: string } | null> {
    return admin.createCategory(this.client, serverId, name, position);
  }

  async moveChannel(
    channelId: string,
    categoryId?: string | null,
    position?: number
  ): Promise<boolean> {
    return admin.moveChannel(this.client, channelId, categoryId, position);
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<boolean> {
    return admin.addReaction(this.client, channelId, messageId, emoji);
  }

  async getReactions(channelId: string, messageId: string): Promise<Array<{
    emoji: string;
    count: number;
    users: Array<{ id: string; tag: string }>;
  }> | null> {
    return admin.getReactions(this.client, channelId, messageId);
  }

  // ============================================
  // Polls
  // ============================================

  async createPoll(
    channelId: string,
    question: string,
    options: Array<{ text: string; emoji?: string }>,
    durationHours: number = 24,
    allowMultiselect: boolean = false
  ): Promise<{ messageId: string } | null> {
    const res = await admin.createPoll(this.client, channelId, question, options, durationHours, allowMultiselect);
    // Polls are posted by the bot like any message, so they are copied to the owner where that rule is on (Codex, 16 Oct).
    if (res?.messageId) {
      try {
        const ch: any = await this.client.channels.fetch(channelId);
        const sent = ch?.messages ? await ch.messages.fetch(res.messageId) : null;
        this.maybeCopyToOwner(sent ?? null, null);
      } catch { /* best-effort: the poll is posted either way */ }
    }
    return res;
  }

  // ============================================
  // Priority 2: Message Management
  // ============================================

  async editMessage(channelId: string, messageId: string, newContent: string): Promise<boolean> {
    return admin.editMessage(this.client, this.botUserId, channelId, messageId, newContent);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<boolean> {
    return admin.deleteMessage(this.client, channelId, messageId);
  }

  async pinMessage(channelId: string, messageId: string): Promise<boolean> {
    return admin.pinMessage(this.client, channelId, messageId);
  }

  async createThread(
    channelId: string,
    name: string,
    messageId?: string,
    autoArchiveDuration?: 60 | 1440 | 4320 | 10080
  ): Promise<string | null> {
    return admin.createThread(this.client, channelId, name, messageId, autoArchiveDuration);
  }

  async createForumPost(
    channelId: string,
    title: string,
    content: string,
    tags?: string[]
  ): Promise<{ threadId: string; messageId: string } | null> {
    return admin.createForumPost(this.client, channelId, title, content, tags);
  }

  async listForumThreads(
    channelId: string,
    limit: number = 20,
    archived: boolean = false
  ): Promise<Array<{
    id: string;
    name: string;
    createdAt: string;
    messageCount: number;
    archived: boolean;
  }>> {
    return admin.listForumThreads(this.client, channelId, limit, archived);
  }

  // ============================================
  // Priority 3: Moderation
  // ============================================

  async timeoutUser(
    serverId: string,
    userId: string,
    durationMinutes: number,
    reason?: string
  ): Promise<boolean> {
    return admin.timeoutUser(this.client, serverId, userId, durationMinutes, reason);
  }

  async assignRole(serverId: string, userId: string, roleId: string, reason?: string): Promise<boolean> {
    return admin.assignRole(this.client, serverId, userId, roleId, reason);
  }

  async removeRole(serverId: string, userId: string, roleId: string, reason?: string): Promise<boolean> {
    return admin.removeRole(this.client, serverId, userId, roleId, reason);
  }

  // ============================================
  // Priority 3b: Role & Permission Administration
  // ============================================
  //
  // House of Solance only (assertHosMutation) and Administrator is never
  // grantable through these three (assertNoAdministratorGrant) — the bot also
  // sits in other people's servers, and granting Administrator stays the owner's,
  // by hand. See role-admin.ts for the bit math. Each method returns a result
  // object rather than a bare boolean, so the caller can surface WHY a
  // mutation failed: hierarchy, missing bot permissions, an unknown
  // permission name, or a non-HoS server.

  async createRole(
    serverId: string,
    options: { name: string; permissions?: string[]; color?: string; hoist?: boolean; mentionable?: boolean },
    reason?: string
  ): Promise<{ ok: boolean; error?: string; role_id?: string; name?: string; permissions?: string[] }> {
    return admin.createRole(this.client, serverId, options, reason);
  }

  async editRole(
    serverId: string,
    roleId: string,
    options: { name?: string; color?: string; add?: string[]; remove?: string[]; hoist?: boolean; mentionable?: boolean },
    reason?: string
  ): Promise<{ ok: boolean; error?: string; role_id?: string; permissions?: string[] }> {
    return admin.editRole(this.client, serverId, roleId, options, reason);
  }

  async setChannelPermission(
    serverId: string,
    channelId: string,
    targetId: string,
    targetType: 'role' | 'member',
    options: { allow?: string[]; deny?: string[]; neutral?: string[]; clear?: boolean },
    reason?: string
  ): Promise<{ ok: boolean; error?: string; channel_id?: string; target_id?: string; allow?: string[]; deny?: string[] }> {
    // Serialise per channel+target: two overlapping calls would each read the
    // same "before" state and the later write would drop the earlier one.
    return this.overwriteQueue(`${channelId}:${targetId}`,
      () => this.setChannelPermissionNow(serverId, channelId, targetId, targetType, options, reason));
  }

  private overwriteQueue = keyedSerializer();

  private async setChannelPermissionNow(
    serverId: string,
    channelId: string,
    targetId: string,
    targetType: 'role' | 'member',
    options: { allow?: string[]; deny?: string[]; neutral?: string[]; clear?: boolean },
    reason?: string
  ): Promise<{ ok: boolean; error?: string; channel_id?: string; target_id?: string; allow?: string[]; deny?: string[] }> {
    return admin.setChannelPermissionNow(this.client, serverId, channelId, targetId, targetType, options, reason);
  }

  // ============================================
  // Priority 4: Awareness
  // ============================================

  async listMembers(serverId: string, limit: number = 100): Promise<Array<{ id: string; tag: string; roles: string[] }> | null> {
    return admin.listMembers(this.client, serverId, limit);
  }

  async getUserInfo(serverId: string, userId: string): Promise<{
    id: string;
    tag: string;
    displayName: string;
    joinedAt: string | null;
    roles: Array<{ id: string; name: string }>;
    isOnline: boolean;
    status: string;
  } | null> {
    return admin.getUserInfo(this.client, serverId, userId);
  }

  async listRoles(serverId: string): Promise<Array<{
    id: string; name: string; color: string; position: number;
    permissions: string; sensitive_permissions: string[]; is_administrator: boolean;
    managed: boolean; bot_id: string | null; member_count: number;
  }> | null> {
    return admin.listRoles(this.client, serverId);
  }

  async listStickers(serverId: string): Promise<Array<{ id: string; name: string; description: string | null; tags: string | null }> | null> {
    return admin.listStickers(this.client, serverId);
  }

  /**
   * Cached guild-sticker roster for presence's sticker vocabulary, one per guild (the owner,
   * 2026-07-11; per server 2026-10-17): the stickers of the server the bot is speaking in.
   * 60-minute TTL. On fetch failure, returns that guild's last-known roster (empty if never
   * fetched) — a sticker-fetch failure must never block a post, it just means the feature is
   * quietly off for now. No guild (a DM) = no stickers.
   */
  async getStickerRoster(guildId?: string | null): Promise<StickerInfo[]> {
    if (!guildId) return [];
    const nowMs = Date.now();
    const cached = this.stickerRosters.get(guildId);
    if (cached && nowMs - cached.fetchedAtMs < this.STICKER_ROSTER_TTL_MS) return cached.roster;
    // Record the ATTEMPT time up front — success and failure both respect the
    // TTL, so an outage retries at most once per window instead of on every
    // mention/sweep (Codex review note, 2026-07-11). Last-known roster serves
    // in the meantime either way.
    const lastKnown = cached?.roster ?? [];
    this.stickerRosters.set(guildId, { roster: lastKnown, fetchedAtMs: nowMs });
    try {
      const stickers = await this.listStickers(guildId);
      if (stickers === null) {
        logger.info('Discord', 'Sticker roster fetch failed — using last-known roster', { guildId, count: lastKnown.length });
        return lastKnown;
      }
      // Sticker names and descriptions are written by each server's admins and reach the model's
      // prompt: keep them as short, single-line data (no newlines, quotes or markup to break out with).
      const roster = stickers
        .map((s) => ({ id: s.id, name: stickerText(s.name, 40), description: stickerText(s.description || s.tags, 100) || null }))
        .filter((s) => s.name);
      this.stickerRosters.set(guildId, { roster, fetchedAtMs: nowMs });
      return roster;
    } catch (err: any) {
      logger.error('Discord', 'Sticker roster fetch threw — using last-known roster', { guildId, error: err?.message, count: lastKnown.length });
      return lastKnown;
    }
  }

  /**
   * Whether the bot may add stickers in this server: the server's own `stickers` switch when it
   * has one, else the global `stickers_enabled`. A DM has no server stickers.
   */
  stickersOn(guildId: string | null | undefined, cfg: { stickers_enabled: boolean }): boolean {
    if (!guildId) return false;
    return this.serverOf(guildId).stickers ?? cfg.stickers_enabled;
  }

  /** The sticker vocabulary for a message in this server: its own roster when stickers are on, else none. */
  async stickersFor(guildId: string | null | undefined, cfg: { stickers_enabled: boolean }): Promise<StickerInfo[]> {
    return this.stickersOn(guildId, cfg) ? this.getStickerRoster(guildId) : [];
  }

  // ============================================
  // Attachment Handling
  // ============================================

  async fetchAttachment(
    channelId: string,
    messageId: string,
    specificFilename?: string
  ): Promise<{ downloaded: string[]; errors: string[] }> {
    // Use environment variable or default to .discord_attachments in project root
    const cacheDir = process.env.DISCORD_ATTACHMENTS_DIR || path.resolve(__dirname, '../.discord_attachments');
    const downloaded: string[] = [];
    const errors: string[] = [];

    try {
      // Ensure cache directory exists
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const channel = await this.client.channels.fetch(channelId);

      // Allow text channels, DMs, and all thread types
      const allowedTypes = [
        ChannelType.GuildText,
        ChannelType.DM,
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ];

      if (!channel || !allowedTypes.includes(channel.type)) {
        errors.push('Channel not accessible or not a text-based channel');
        return { downloaded, errors };
      }

      const textChannel = channel as TextChannel | DMChannel | ThreadChannel;
      const message = await textChannel.messages.fetch(messageId);

      if (message.attachments.size === 0) {
        errors.push('Message has no attachments');
        return { downloaded, errors };
      }

      // Filter attachments if specific filename requested
      let attachments = Array.from(message.attachments.values());
      if (specificFilename) {
        attachments = attachments.filter(att => att.name === specificFilename);
        if (attachments.length === 0) {
          errors.push(`No attachment named "${specificFilename}" found`);
          return { downloaded, errors };
        }
      }

      // Download each attachment
      for (const attachment of attachments) {
        const safeName = attachment.name?.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
        const localPath = path.join(cacheDir, `${messageId}_${safeName}`);

        try {
          await this.downloadFile(attachment.url, localPath);
          downloaded.push(localPath);
          console.error(`[Discord] Downloaded attachment to ${localPath}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push(`Failed to download ${attachment.name}: ${errMsg}`);
        }
      }

      return { downloaded, errors };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Failed to fetch message: ${errMsg}`);
      return { downloaded, errors };
    }
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);

      https.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            file.close();
            fs.unlinkSync(destPath);
            this.downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });

        file.on('error', (err) => {
          file.close();
          fs.unlinkSync(destPath);
          reject(err);
        });
      }).on('error', (err) => {
        file.close();
        fs.unlinkSync(destPath);
        reject(err);
      });
    });
  }
}
