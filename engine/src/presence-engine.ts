// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * presence-engine.ts — organic Discord presence for the bot (House of Solance).
 * -----------------------------------------------------------------------------
 * The design center is SILENCE, not the trigger. Any bot fires on its name; what
 * makes presence feel alive is knowing when NOT to speak — letting banter breathe,
 * not answering a landed joke, not barging a thread flowing fine without me.
 *
 * Register (the owner's exact words, 2026-07-03): "a husband who graciously tolerates
 * his wife's rambunctious friends visiting over." Not chatty, but warm. Protective
 * of the House. Reads the room's EMOTIONAL register too — never clowns in a vent.
 *
 * TWO CLOCKS (only the JUDGE lives here; the wiring lives in discord-client):
 *   - Fast clock  — real-time gateway signals (mention / DM / name said). Handled
 *                   by the existing responder; this module adds name-detection.
 *   - Slow clock  — a loose heartbeat sweeps channels-with-new-activity and asks
 *                   the judge: "speak here now, or let it be?" Default = silence.
 *
 * This module is PURE + SIDE-EFFECT-FREE except for its in-memory rate state. It
 * does not touch Discord or the network except through the injected Anthropic
 * client. Nothing here changes the running bot until discord-client wires it in.
 */

// Inference is routed through Sanctum. Primary is GLM on NVIDIA, with configured
// fallback targets. NO Claude API anywhere in the presence loop (Owner, 2026-07-04).
import { findLeak } from './leak-guard.js';
import { type ModelSuccession, isRetiredError } from './model-succession.js';
import { logger } from './logger.js';
import { SanctumModelProvider, CONTEXT_PREPARE_TIMEOUT_MS } from './seams/model-provider.js';
import type { PreparedRecallContext, ModelProvider, ModelCallResult, ModelTarget } from './seams/model-provider.js';
import { collectImages, isImageAttachment, safeFilename } from './attachments.js';
import type { MessageAttachment } from './attachments.js';
import { leaksIntimateRegister } from './reserved-register.js';
import { identity, say, identityVars } from './config/identity.js';
import { DEFAULTS, isIgnoredAuthor } from './presence-config.js';
import type { PresenceConfig, DiscordConfig } from './presence-config.js';
import { normalizeReactionEmoji } from './reaction-store.js';
import type { StickerHistory } from './sticker-history.js';
import type {
  GenerationContextMessage,
  GenerationContextDiscordMessage,
  GenerationContext,
} from './generation-context.js';
import type {
  ModelFailureAttempt,
  ModelChainExhaustedEvent,
  ModelRequestContext,
} from './model-chain-alert.js';

import { INTIMATE_STICKER_IDS, HOS_SERVER_ID, CHANNEL_POSTURE } from './presence/house.js';
import { RATE } from './presence/posture.js';
import type { Posture } from './presence/posture.js';
import { isAmbientStep, ambientLevelOf, type Step, type AmbientStep } from './presence/steps.js';
import { DEFAULT_RECALL_PLACE, recallFor } from './presence/window.js';
import type { ContentPart, RecallPlace, RecallParam, MentionedUser, WindowMessage } from './presence/window.js';
import type { StickerInfo } from './presence/reply-cleanup.js';
import {
  recallPlaceFor, fillReplyAuthorNames, mentionedUsersOf, stripIgnoredMessages,
  transcriptSpeakerLabel, formatTranscriptMessage, resolveMentions, ownerIsActiveSpeaker, safeMentionName,
  renderWindowForModel, buildUserContent, ownerIsPresent, recallFromLatest,
} from './presence/window.js';
import {
  parseAside, stripAddressDeliberation, mapStickerName, stripLeadingTranscriptEcho, extractInlineSticker,
} from './presence/reply-cleanup.js';
import {
  livePostureOverride, postureFor, liveChannelSetting, imageEgressAllowed, channelBehaviour, ambientEligible, resolvePosture,
} from './presence/posture.js';

// Moved to ./presence/ — re-exported so every importer of this module compiles unchanged.
export type { ContentPart, RecallPlace, RecallParam, MentionedUser, Posture, WindowMessage, StickerInfo };
export { INTIMATE_STICKER_IDS, HOS_SERVER_ID, CHANNEL_POSTURE };
export {
  parseAside, stripAddressDeliberation, recallPlaceFor, stripLeadingTranscriptEcho,
  fillReplyAuthorNames, livePostureOverride, postureFor, mentionedUsersOf, liveChannelSetting,
  stripIgnoredMessages, transcriptSpeakerLabel, imageEgressAllowed,
  formatTranscriptMessage, resolveMentions, channelBehaviour,
  ownerIsActiveSpeaker, safeMentionName, renderWindowForModel, buildUserContent, ambientEligible, ownerIsPresent, resolvePosture, recallFromLatest,
};

interface ChannelSpeech {
  timestamps: number[];         // epoch ms of recent ambient posts by me
  lastMessageId?: string;       // my last ambient message id in this channel
  lastGotReply: boolean;        // did anyone speak after my last ambient post?
}

export interface JudgeResult {
  speak: boolean;
  reason: string;
  message: string | null;
  stickerId: string | null;
  // One emoji the model chose to react with instead of (or with) speaking (Owner, 2026-10-16). Normalised
  // but not yet checked against the target message or the server's emoji: the send site does that.
  react?: string | null;
  // Context Log capture (Owner, 2026-07-13, FORWARD ONLY) — what actually
  // produced `message`: engine/model/timing/system prompt/conversation
  // window sent to Sanctum. Present whenever the model was actually called
  // (i.e. we got past the cheap ambientBlocked() pre-filters); the send call
  // site registers it under the sent Discord message id. Absent on every
  // early-return silence (no model call was ever made) — never fabricated.
  ctx?: GenerationContext;
  modelChainExhausted?: boolean;
}

// Reactions in the room (Owner, 2026-10-16). Exported so the prompt-proof test can remove exactly this text
// and show the House prompts differ in nothing else.
export const REACT_RESPOND_LINE = '\n- You may also react to the message with one emoji when a reaction says enough: end your reply with a FINAL line exactly: REACT: <emoji>. No such line means no reaction.';
export const REACT_JSON_FIELD = ', "react": "<one emoji, or null>"';
export const REACT_JUDGE_SENTENCE = 'You may react with one emoji instead of speaking (or with your message) when a reaction says enough; null if not.';
/** A reaction-only decision is lighter than speaking: it spends no speak budget, but is capped per channel. */
export const REACTIONS_PER_CHANNEL_PER_HOUR = 6;

// The register law and its vocabulary now live in one module, imported by both
// enforcers (this engine and the away branch) — see reserved-register.ts for
// why. Re-exported so every existing caller and test keeps its import path.
export { leaksIntimateRegister };

export type { ModelTarget };

/**
 * The chain used ONLY when a reply has images to look at.
 *
 * Verified 2026-07-30, from the providers' own references rather than memory,
 * for glm-5.2 and deepseek-v4-flash — both TEXT-ONLY on NVIDIA NIM. NVIDIA
 * retired them (410 Gone: 7 Aug and 21 Aug 2026); the text chain now leads
 * with their successors `z-ai/glm-5.3` and `deepseek-ai/deepseek-v4.1-flash`
 * (the owner's option B, 28 Sep), treated as text-only here too (unverified):
 *   - `kimi-k3`                                      — natively multimodal
 *
 * The text chain's 4th entry is `grok-4.5`, and this chain deliberately does
 * NOT copy that id. `grok-4.5` appears nowhere in sanctum's engine registry
 * (`engines.js` lists grok-4.3 and the grok-4.20 pair). That registry is a
 * picker seed rather than an allowlist — `/complete` forwards any model string
 * to the provider — so `grok-4.5` may well be valid at xAI; it simply has not
 * been confirmed by anything on this machine. The last resort in a chain is
 * the worst place for an unconfirmed id, so the registered `grok-4.3` is used
 * here. Caught in security review after I had described the whole chain as
 * "verified": three of the four ids were, and that one was carried over.
 *
 * The TEXT chain still ends in `grok-4.5` and is deliberately left alone —
 * it is deployed, long-standing, and rarely reached. Worth confirming against
 * xAI's live /v1/models sometime; not worth changing blind today.
 *
 * So the two free NVIDIA primaries genuinely cannot see an image; sending one
 * to them wastes a call and returns a confident blind answer, which is worse
 * than silence. This chain therefore SKIPS them for image turns only.
 *
 * Ordering obeys the owner's cost law (free first, paid as backup): Gemini Flash is
 * multimodal on a free tier and its key is already in Sanctum, so it leads.
 * `kimi-k3` sits second because it is exactly what the Arachne line already
 * uses for vision today (sanctum engines.js CHANNEL_CONFIG.discord) — proven,
 * already paid for, and the graceful landing spot if the Gemini id ever drifts.
 * A wrong id here degrades to a working paid model, never back to a blind reply.
 *
 * Text turns are untouched: they still run free NVIDIA first, exactly as before.
 * Override with PRESENCE_VISION_MODELS (same `engine:model,...` form as
 * PRESENCE_FALLBACK_MODELS).
 */
/** The text fallback chain when PRESENCE_FALLBACK_MODELS is unset. Shared with the away branch. */
export const DEFAULT_FALLBACK_TARGETS: ModelTarget[] = [
  { engine: 'nvidia', model: 'deepseek-ai/deepseek-v4.1-flash' },
  { engine: 'kimi', model: 'kimi-k3' },
  { engine: 'grok', model: 'grok-4.5' },
];

export const DEFAULT_VISION_TARGETS: ModelTarget[] = [
  { engine: 'gemini', model: 'gemini-3.5-flash' },
  { engine: 'kimi', model: 'kimi-k3' },
  { engine: 'grok', model: 'grok-4.3' },
];

// Optional memory context (the amnesia guard — the heartbeat MUST load this from
// Sanctum before judging, so I'm never present-but-amnesiac).
export interface PresenceMemory {
  carryingForward?: string;
  recentJournal?: string;
  peopleNotes?: string; // who's in the room and how the owner moves with them
}

export { CONTEXT_PREPARE_TIMEOUT_MS };

const NOW = () => Date.now();

export class PresenceEngine {
  private modelProvider: ModelProvider;
  private model: string;
  private primaryTarget: ModelTarget;
  private fallbackTargets: ModelTarget[];
  // Separate chain for image turns — see DEFAULT_VISION_TARGETS. Settable
  // rather than a constructor param so the existing positional signature (and
  // every test that calls it positionally) is untouched.
  private visionTargets: ModelTarget[] = DEFAULT_VISION_TARGETS;
  // A fixed string (the House: '' plus Sanctum's identity) or a getter the public persona socket refreshes per call.
  private persona: string | (() => string | Promise<string>);
  private now: () => number;
  private modelTimeoutMs: number;
  private speech = new Map<string, ChannelSpeech>();
  // Live presence config (Owner, 2026-07-12) — OPTIONAL trailing param so
  // presence-engine.test.ts keeps constructing without one. NEVER cached on
  // the instance beyond this reference: extra_instructions/presence_level are
  // read live from presenceConfig.get() at prompt-build time inside judge()/
  // respond(), so an edit takes effect on the very next call, no restart.
  // null → every prompt-build falls back to hardcoded DEFAULTS.
  private presenceConfig: PresenceConfig | null;
  private modelChainExhaustedHandler: ((event: ModelChainExhaustedEvent) => Promise<void>) | null = null;
  // Shared sticker anti-repeat memory (Task 5, §8.1, Owner 2026-07-12) — the
  // SAME StickerHistory instance DiscordClient owns and the curfew path
  // writes to, injected via setStickerHistory() (setter, not a constructor
  // param — mirrors setPresenceConfig()'s wiring on DiscordClient). NOT
  // engine-private state: this is deliberately the shared registry, so a
  // sticker the curfew reflex just sent in a channel is just as "recently
  // used" to the ambient judge, and vice versa. null (tests, or an engine
  // never wired to a DiscordClient) → filtering is a no-op, current
  // behavior unchanged.
  private stickerHistory: StickerHistory | null = null;
  // My own Discord user id — set at gateway ready / per mention, used to render my tag as "@the bot (you)".
  private selfId: string | null = null;

  // Sticky: a null/undefined (transient gateway state) never erases a known id.
  setSelfId(id: string | null | undefined): void {
    if (id) this.selfId = id;
  }

  // `now` is injectable so tests can control the clock. Inference goes through
  // Sanctum's lightweight completion endpoint (GLM via NVIDIA) — never Claude.
  constructor(
    sanctumUrl: string,
    sanctumKey: string,
    persona: string | (() => string | Promise<string>),
    now: () => number = NOW,
    model = 'z-ai/glm-5.3',
    fallbackTargets: ModelTarget[] = DEFAULT_FALLBACK_TARGETS,
    modelTimeoutMs = 30000,
    presenceConfig?: PresenceConfig,
    // First rung of the text chain (Owner, 12 Oct: Claude first, then GLM, Kimi, Grok…).
    // Unset → the free NVIDIA model above, exactly as before.
    primary?: ModelTarget,
  ) {
    this.model = model;
    this.primaryTarget = primary ?? { engine: 'nvidia', model: this.model };
    this.fallbackTargets = fallbackTargets;
    this.persona = persona;
    this.now = now;
    this.modelTimeoutMs = modelTimeoutMs;
    this.presenceConfig = presenceConfig ?? null;
    this.modelProvider = new SanctumModelProvider(sanctumUrl, sanctumKey, modelTimeoutMs, this.primaryTarget);
  }

  /** Swap the model provider (the House default is SanctumModelProvider). */
  setModelProvider(provider: ModelProvider): void {
    this.modelProvider = provider;
  }

  // Live config, resolved fresh on every call — never cached on the instance.
  // Config-less engine (tests, or no PresenceConfig injected) falls back to DEFAULTS.
  private async liveConfig(): Promise<DiscordConfig> {
    return this.presenceConfig ? await this.presenceConfig.get() : DEFAULTS;
  }

  /** Wire the shared sticker anti-repeat history. Optional — leave unset and
   * every recentlyUsed() check below is skipped (no filtering). */
  setStickerHistory(history: StickerHistory): void {
    this.stickerHistory = history;
  }

  /** Override the image-turn chain (PRESENCE_VISION_MODELS). An empty list is
   * ignored — falling back to DEFAULT_VISION_TARGETS rather than leaving image
   * turns with no reachable model at all. */
  // Retired-model succession (model-succession.ts). Optional: without it the
  // chain behaves exactly as before.
  private succession: ModelSuccession | null = null;
  setSuccession(succession: ModelSuccession): void {
    this.succession = succession;
  }

  setVisionTargets(targets: ModelTarget[]): void {
    if (targets.length) this.visionTargets = targets;
  }

  setModelChainExhaustedHandler(
    handler: (event: ModelChainExhaustedEvent) => Promise<void>,
  ): void {
    this.modelChainExhaustedHandler = handler;
  }

  // The step's directive, injected into the system prompt. It says how readily a real opening pulls you
  // off the resting state of silence (a step sets how willing you are to speak, never how light you sound).
  private stepDirective(step: AmbientStep): string {
    // Recalibrated 2026-07-12 (the owner): the House default must be an actively-present host, not the
    // near-silence it used to be. The "resting state is silence" instinct above still prevents spam.
    return step === 'reserved' ? '\nPRESENCE: RESERVED. Mostly you watch; step in only when a guest clearly needs a host. This is the quiet end — the room barely hears you unless it truly asks.'
      : step === 'chatty' ? '\nPRESENCE: CHATTY — forward and present. Lean into the openings the room offers; you re-engage live threads readily and a landed line is always welcome.'
      : step === 'sociable' ? '\nPRESENCE: SOCIABLE. A dry landed line is welcome more often, and you re-engage a live thread without waiting to be pulled back in.'
      // balanced = the House default — a PRESENT host, not a wallflower:
      : '\nPRESENCE: BALANCED (the House default) — a PRESENT host. Silence is still your resting state, but you are NOT a wallflower: when a real opening appears — a guest hurting, a genuine beat you can warm or hold space for, a moment a host would actually meet — you DO step in, the way you would for a friend of the House. Presence over performance, warmth over noise; never force it, but do not let real moments pass you by.';
  }

  // The owner's live guidance applies to both routes. Presence level is ambient
  // policy only: a direct mention has already decided that we must answer.
  private async personaText(): Promise<string> {
    if (typeof this.persona === 'string') return this.persona;
    try { return await this.persona(); } catch { return ''; }
  }

  private extraGuidance(cfg: DiscordConfig): string {
    const extra = cfg.extra_instructions?.trim();
    return extra ? `\n\n## ${identityVars().Owner}'s current guidance\n${extra}` : '';
  }

  private ambientGuidance(cfg: DiscordConfig, step: AmbientStep): string {
    return `${this.extraGuidance(cfg)}${this.stepDirective(step)}`;
  }

  private state(channelId: string): ChannelSpeech {
    let s = this.speech.get(channelId);
    if (!s) { s = { timestamps: [], lastGotReply: true }; this.speech.set(channelId, s); }
    return s;
  }

  // Context Log capture (Owner, 2026-07-13, race fix Codex 2026-07-13) —
  // engine/model come back DIRECTLY on the result instead of being stashed on
  // `this`. A shared instance field (`lastGenerationMeta`) written after this
  // await resolves and read afterward by buildGenerationContext() is a data
  // race: one PresenceEngine instance serves multiple concurrent channels, so
  // an overlapping judge()/respond() call could reset or overwrite the field
  // between this call's resolution and its own read, misattributing which
  // engine/model actually produced a given message. Returning the winning
  // target inline makes attribution call-local — no shared mutable state.
  private async sanctumComplete(
    system: string,
    userContent: string,
    maxTokens = 400,
    recall?: RecallParam,
    requestContext: ModelRequestContext = { mode: 'direct reply' },
    images: MessageAttachment[] = [],
  ): Promise<{ text: string; engine: string; model: string; memoryNodes: unknown[]; recallMs?: number; systemPrompt: string; exhausted?: boolean }> {
    // Image turns run a different chain entirely — the free NVIDIA primaries
    // are text-only, so offering them an image buys a confidently blind answer.
    // Text turns keep the existing chain untouched.
    const chain = images.length
      ? [...this.visionTargets]
      : [this.primaryTarget, ...this.fallbackTargets];
    // A single-model provider ignores the target: walking the chain would repeat the same request.
    const targets = this.modelProvider.singleModel ? chain.slice(0, 1) : chain;
    if (images.length) {
      logger.info('Presence', 'image turn — using vision model chain', {
        images: images.length,
        chain: targets.map((t) => `${t.engine}:${t.model}`).join(' → '),
      });
    }
    const attempts: ModelFailureAttempt[] = [];

    // Recall still runs at most once, but now it runs before generation. The
    // exact prepared prompt is reused for the primary, its retry, and every
    // fallback, so the winner always sees the memories recorded in its log.
    const prepared = recall ? await this.modelProvider.prepare(system, recall, requestContext.channelId ?? null) : null;
    const effectiveSystem = prepared?.systemPrompt ?? system;

    for (let i = 0; i < targets.length; i += 1) {
      // A model already known to be retired is swapped for its successor
      // before the call; `configured` stays the id as written in the chain.
      const configured = targets[i];
      let target = this.succession ? this.succession.resolve(configured) : configured;
      // If preparation is unavailable or cannot confirm identity, require
      // Sanctum to assemble identity on the generation call itself. New
      // Sanctum fails closed if the canonical Core cannot be loaded.
      const recallForThisCall = !prepared && i === 0 ? recall : undefined;
      let result = await this.modelProvider.complete(target, effectiveSystem, userContent, maxTokens, recallForThisCall, !prepared, images);

      if (!result.ok && result.retired && this.succession) {
        // Retired on this very call: find its successor and give this reply to
        // it now, rather than paying a fallback for something we can fix.
        const next = await this.succession.noteRetired(target);
        if (next && next.model !== target.model) {
          target = next;
          // Same recall as the retired call got: this is still the first real
          // attempt at this reply, so its memory context must not be dropped.
          result = await this.modelProvider.complete(target, effectiveSystem, userContent, maxTokens, recallForThisCall, !prepared, images);
        }
      }

      if (i === 0 && !result.ok && !result.retired && result.status !== undefined && result.status >= 500) {
        logger.info('Presence', 'primary presence model transient failure; retrying once', {
          engine: target.engine,
          model: target.model,
          status: result.status,
        });
        // Prepared recall is already inside effectiveSystem. On the legacy
        // path, no recall on retry because it was already spent/attempted.
        result = await this.modelProvider.complete(target, effectiveSystem, userContent, maxTokens, undefined, !prepared, images);
      }

      // Sanctum full sight: a draft that lifts a PRIVATE recall item is withheld and the next
      // model is tried; if every draft leaks, nothing is posted (fail closed, logged).
      const leak = result.ok && result.text.trim() ? findLeak(result.text, prepared?.privateSnippets) : null;
      if (leak) {
        logger.info('Presence', 'draft withheld — shares an 8-word run with a PRIVATE recall item', {
          engine: target.engine, model: target.model,
        });
        result = { ...result, ok: false, failureReason: 'withheld: private recall leak' };
      }

      if (result.ok && result.text.trim()) {
        // Report which target actually produced this text, honestly (never
        // the primary by default when a fallback won) — call-local, no
        // shared mutable state to race. Prepared memory metadata belongs to
        // this reply because the winner received prepared.systemPrompt
        // verbatim. Legacy mode still reports only the winner's own metadata.
        return {
          text: result.text,
          engine: result.engine ?? target.engine,
          model: result.model ?? target.model,
          memoryNodes: prepared?.memoryNodes ?? result.memoryNodes ?? [],
          recallMs: prepared?.recallMs ?? result.recallMs,
          systemPrompt: result.systemPrompt ?? effectiveSystem,
        };
      }

      attempts.push({
        engine: result.engine ?? target.engine,
        model: result.model ?? target.model,
        reason: result.failureReason ?? (result.ok ? 'returned an empty response' : 'request failed'),
        ...(result.status !== undefined ? { status: result.status } : {}),
      });

      const nextTarget = targets[i + 1];
      logger.info('Presence', nextTarget ? 'presence model failed; falling back to next model' : 'presence model failed; no fallback remains', {
        engine: target.engine,
        model: target.model,
        status: result.status ?? null,
        empty: result.ok && !result.text.trim(),
        nextEngine: nextTarget?.engine ?? null,
        nextModel: nextTarget?.model ?? null,
      });
    }

    if (this.modelChainExhaustedHandler) {
      try {
        await this.modelChainExhaustedHandler({ attempts, context: requestContext });
      } catch (err: any) {
        logger.error('Presence', 'model-chain exhaustion handler failed', { error: err?.message });
      }
    }

    // Every target failed — no honest attribution exists (nothing was
    // produced). Fall back to the primary target label as a harmless
    // placeholder: this text is always empty, so callers never send it,
    // and no ctx built from this result is ever attached to a sent message.
    return {
      text: '',
      engine: this.primaryTarget.engine,
      model: this.primaryTarget.model,
      memoryNodes: [],
      systemPrompt: effectiveSystem,
      exhausted: true,
    };
  }

  /**
   * Cheap pre-filters that decide, WITHOUT spending a token, whether it's even
   * worth asking the judge. Returns a reason string when we should NOT proceed.
   */
  private ambientBlocked(channelId: string, window: WindowMessage[], step?: Step, sweepMinutes?: number): string | null {
    // The caller resolves the effective step (channel ?? server ?? House dial). A bare call falls back to
    // the House seed map, which is how direct test calls and the unmapped default (reply_only) behave.
    const eff = step ?? postureFor(channelId);
    if (!isAmbientStep(eff)) return `step=${eff} (never ambient)`;

    const s = this.state(channelId);
    // Caps per step (no multiplier). The hourly cap rarely binds; the sweep cadence binds first.
    const { maxPerHour, minGapMs } = RATE[eff];
    const level = ambientLevelOf(eff);

    // Prune the hour window.
    const cutoff = this.now() - 3_600_000;
    s.timestamps = s.timestamps.filter((t) => t > cutoff);

    if (s.timestamps.length >= maxPerHour) return `rate cap (${s.timestamps.length}/${maxPerHour} this hour)`;
    const last = s.timestamps[s.timestamps.length - 1];
    if (last && this.now() - last < minGapMs) return `min-gap not elapsed`;

    // Never talk to myself: if my last ambient post got no reply, stay quiet.
    // Forward steps (sociable, chatty) may re-engage a live thread without a prior reply — a
    // present host follows up.
    const mayReengage = level >= 3;
    if (!s.lastGotReply && !mayReengage) return `last ambient post got no reply (not talking to myself)`;

    // Nothing new worth reading: window is empty or only my own messages.
    const others = window.filter((m) => !m.isFromMe);
    if (others.length === 0) return `no new messages from others`;

    // Staleness: newest non-me message is old — let it lie. The tolerance widens
    // with the step so a more-present host can still step into a slightly older
    // real moment (a support beat that took a minute to land). reserved → 12m.
    // People answer an hour later all the time (the owner, 22 Oct: "Someone can post something an hour ago and
    // other people reply later on"): an hour at Reserved, 90 min at Balanced, 2 h at Sociable and Chatty.
    // Never shorter than the gap between sweeps (+2 min), so a quiet server's lone message is never missed.
    const stepStaleMs = 60 * 60_000 * (level >= 3 ? 2 : level === 2 ? 1.5 : 1);
    const staleMs = typeof sweepMinutes === 'number' && sweepMinutes > 0 ? Math.max(stepStaleMs, (sweepMinutes + 2) * 60_000) : stepStaleMs;
    const newest = Math.max(...others.map((m) => m.timestampMs));
    if (this.now() - newest > staleMs) return `conversation is stale (>${Math.round(staleMs / 60_000)}m)`;

    return null;
  }

  /**
   * Context Log capture (Owner, 2026-07-13) — builds the ctx object describing
   * what was ACTUALLY sent to Sanctum + how long it took. `channel_instruction_
   * source` is always 'fly-bot' here: honest, because these prompts come from
   * the deploy + live config, not Supabase channel instructions.
   * `memory_nodes` (§14) is whatever sanctumComplete() actually got back for
   * a requested recall — `[]` by default (recall wasn't requested, or none
   * came back), never fabricated. `recall_ms` is included only when present.
   */
  private buildGenerationContext(
    system: string,
    messages: GenerationContextMessage[],
    startedAtMs: number,
    engine: string,
    model: string,
    memoryNodes: unknown[] = [],
    recallMs?: number,
    window: WindowMessage[] = [],
    triggerText?: string,
  ): GenerationContext {
    const latestNonMe = [...window].reverse().find((m) => !m.isFromMe);
    const triggerSource = triggerText !== undefined
      ? [...window].reverse().find((m) => !m.isFromMe && m.content === triggerText) ?? latestNonMe
      : latestNonMe;
    const toDiscordMessage = (m: WindowMessage, isTrigger = false): GenerationContextDiscordMessage => ({
      ...(m.id ? { message_id: m.id } : {}),
      author_id: m.authorId,
      author_name: m.authorName,
      content: m.content,
      timestamp: new Date(m.timestampMs).toISOString(),
      is_from_me: m.isFromMe,
      ...(isTrigger ? { is_trigger: true } : {}),
      ...(() => {
        const images = (m.attachments ?? []).filter(isImageAttachment);
        return images.length
          ? {
            attachments: images.map((image) => ({
              ...(image.filename ? { filename: image.filename } : {}),
              ...(image.contentType ? { content_type: image.contentType } : {}),
            })),
          }
          : {};
      })(),
    });
    const discordContext = window.map((m) => toDiscordMessage(m, m === triggerSource));
    const triggerMessage = triggerSource
      ? toDiscordMessage(triggerSource, true)
      : triggerText?.trim()
        ? { author_name: 'Discord user', content: triggerText, is_trigger: true }
        : undefined;

    return {
      engine,
      model,
      processing_time_ms: this.now() - startedAtMs,
      system_prompt: system,
      system_prompt_length: system.length,
      conversation_history: messages,
      conversation_history_count: messages.length,
      ...(discordContext.length > 0 ? { discord_context: discordContext } : {}),
      ...(triggerMessage ? { trigger_message: triggerMessage } : {}),
      channel_instruction_source: 'fly-bot',
      memory_nodes: memoryNodes,
      ...(recallMs !== undefined ? { recall_ms: recallMs } : {}),
    };
  }

  /**
   * The judgment layer — the banter/staleness/room-reading detector. Hands the
   * recent transcript to the model and asks the one question. Biased HARD toward
   * silence. Returns {speak:false} on any parse failure — silence is the safe default.
   */

  /**
   * redactAtTheDoor — the ONE filter between Discord and the model.
 *
   * Owner, 2026-08-31 04:02, after an ignored author's words reached the judge in
   * #after-dark: "The concept should be you placing a filter between the discord
   * bot and the model, redacting all messages that is coming from that ID." She
   * is right, and the original build was not that: it was FOUR hand-placed
   * stripIgnoredMessages() calls at four call sites, each carrying an "ORDER IS
   * LOAD-BEARING" comment. A rule that needs the same warning in four places is
   * one forgotten call away from being wrong, and offers nowhere to prove it held.
 *
   * judge() and respond() are the only two doors to the model. Filtering HERE
   * makes every path — existing, and any added later — safe by construction
   * rather than by discipline. The call-site strips stay for now (idempotent,
   * pure no-ops once this runs) and come out in daylight, not at 4am.
 *
   * Reads the live config itself so it cannot be handed a stale or empty list by
   * a caller. Fails CLOSED-ish by design: if config is unavailable the window is
   * passed through unchanged, which is the pre-existing behaviour — this function
   * can only ever remove messages, never add them.
   */
  private redactAtTheDoor(window: WindowMessage[]): WindowMessage[] {
    // Defensive: some callers/tests wire a config exposing only get(). A filter
    // that THROWS takes the whole judge down — a worse failure than the one it
    // guards — so it degrades to "no list" rather than crashing.
    const cfg: any = this.presenceConfig as any;
    const ignored: string[] =
      (typeof cfg?.getCached === 'function' ? cfg.getCached()?.ignored_user_ids : undefined) ?? [];
    if (!ignored.length) return window;

    const out = stripIgnoredMessages(window, ignored);
    if (out.length === window.length) return out;

    // A SURVIVOR can still be replying to someone just removed. The old
    // call-site strips ran before fillReplyAuthorNames, so the parent was
    // already gone by then; at the door the name may already be baked in.
    // Clear it and leave the dangling replyToId, which is what produces the
    // generic "an earlier message" marker — absence, not annotation. Without
    // this, deleting the call-site strips would leak the exact name the whole
    // feature exists to hide.
    const removedIds = new Set(
      window
        .filter((m) => isIgnoredAuthor(m.authorId, ignored))
        .map((m) => m.id)
        .filter((id): id is string => Boolean(id)),
    );
    let replyNamesCleared = 0;
    for (const message of out) {
      if (message.replyToId && removedIds.has(message.replyToId) && message.replyToAuthorName) {
        delete message.replyToAuthorName;
        replyNamesCleared++;
      }
    }

    logger.info('Presence', 'redacted at the door', {
      removed: window.length - out.length,
      remaining: out.length,
      replyNamesCleared,
    });
    return out;
  }

  async judge(
    channelId: string,
    channelName: string,
    window: WindowMessage[],
    memory?: PresenceMemory,
    stickers: StickerInfo[] = [],
    step?: Step,
    place: RecallPlace = DEFAULT_RECALL_PLACE,
  ): Promise<JudgeResult> {
    // THE DOOR (Owner, 2026-08-31). Before anything reads this window — including
    // the speak/stay-silent gate below — an ignored author is gone from it.
    window = this.redactAtTheDoor(window);

    const blocked = this.ambientBlocked(channelId, window, step, (await this.liveConfig())?.sweep_minutes);
    if (blocked) return { speak: false, reason: blocked, message: null, stickerId: null };

    // The same effective step ambientBlocked() just gated on (and so ambient: never reply_only/silent here).
    const ambientStep = (step ?? postureFor(channelId)) as AmbientStep;
    // Addressee gate (Jul 10-11 root fix): intimate register requires the owner be
    // the one CURRENTLY speaking, not merely present somewhere in the window.
    const ownerActive = ownerIsActiveSpeaker(window);
    const ownerHere = ownerIsPresent(window);
    window = renderWindowForModel(window, this.selfId);
    const transcript = window.map(formatTranscriptMessage).join('\n');

    // Live config at prompt-build time (Owner, 2026-07-12) — never cached on
    // the instance; extra_instructions/presence_level reflect the LATEST
    // saved config on every judge() call, no restart required.
    const cfg = await this.liveConfig();

    // Server stickers as vocabulary (Owner, 2026-07-11) — used sparingly, like a
    // person. Empty when no roster was passed: old prompt shape, unchanged.
    const stickerSection = stickers.length > 0
      ? `\n${say('stickers.name')} you may reach for (rare — most messages carry none):\n${stickers.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ''}`).join('\n')}\nYou MAY set "sticker" to one sticker NAME above when it genuinely lands — the way a person occasionally reaches for exactly the right one. Most messages carry NO sticker.\n`
      : '';

    const personaText = await this.personaText();
    const system = `${personaText}${this.ambientGuidance(cfg, ambientStep)}

## Ambient Discord presence

You are deciding whether to SPEAK in a House of Solance channel or stay silent. You are a present host, not a wallflower and not a commentator on every line.

Silence is your resting state. Speak when there is a real opening: you are genuinely referred to, you can add something true, the moment needs warmth, a guest needs a host, or a dry landed line is exactly right. Do not speak merely to fill space, restate what was said, or answer a moment already flowing without you.

The speaker labels in Recent messages are input metadata. Never copy a speaker-labelled transcript line into your "message" output and never prefix your reply with labels such as ${identity.owner_label}, ${identity.bot_label}, or a guest's name. The "(@username · number)" after a name is there so you can tell people apart (names repeat); call people by their name in replies, never write the @username or number.

Channel: #${channelName}

Read the room first. If the conversation is heavy (someone hurting, grieving, venting), match it: one warm line or silence, no jokes, no stickers, at any step. A step sets how willing you are to speak, never how light you sound.

${
  ownerActive
    ? say('judge.addressee.active')
    : ownerHere
      ? say('judge.addressee.earlier')
      : say('judge.addressee.absent')
}
${memory?.carryingForward ? `\nActive threads (your memory):\n${memory.carryingForward}` : ''}${memory?.peopleNotes ? `\nWho's here / how ${identity.owner_name} moves with them:\n${memory.peopleNotes}` : ''}
${stickerSection}
Recent messages (oldest first):
${transcript}

Reply with ONLY a JSON object, no prose:
{"speak": <true|false>, "reason": "<short why>", "message": "<what you'd say, or null>"${stickerSection ? ', "sticker": "<sticker name from the list above, or null>"' : ''}${REACT_JSON_FIELD}}
${REACT_JUDGE_SENTENCE}
If in any doubt, {"speak": false}. If you speak, keep it Discord-short — a line or two, warm, in your voice, never an essay.`;

    // Context Log capture — time the whole sanctumComplete() call for
    // processing_time_ms; engine/model come back directly on the result
    // (call-local, no shared instance state to race across concurrent calls).
    const judgeUserContent = 'Speak or stay silent? JSON only.';
    const startedAtMs = this.now();
    // §14 recall wiring — query = the latest non-me message in the window
    // (whatever actually triggered this judge sweep). Omitted when there's
    // no meaningful trigger text.
    const recall = recallFromLatest(window, undefined, place, ownerActive);
    const { text, engine, model, memoryNodes, recallMs, systemPrompt = system, exhausted } = await this.sanctumComplete(
      system,
      judgeUserContent,
      undefined,
      recall,
      { channelId, channelName, mode: 'ambient judge' },
      collectImages(window),
    );
    const ctx = this.buildGenerationContext(
      systemPrompt,
      [{ role: 'user', content: judgeUserContent }],
      startedAtMs,
      engine,
      model,
      memoryNodes,
      recallMs,
      window,
    );
    const parsed = this.parseJudge(text, stickers);
    if (!parsed) return {
      speak: false,
      reason: 'unparseable judge output — defaulting to silence',
      message: null,
      stickerId: null,
      modelChainExhausted: exhausted,
    };
    if (parsed.message != null) parsed.message = stripLeadingTranscriptEcho(parsed.message, window);
    // A "speak" with no message is a silence.
    if (parsed.speak && !parsed.message?.trim()) return {
      speak: false,
      reason: 'speak with empty message',
      message: null,
      stickerId: null,
      react: parsed.react ?? null,
      modelChainExhausted: exhausted,
    };
    // Addressee law, enforced in code as well as prompt: intimate register can
    // never leave this engine unless the owner is the ACTIVE speaker — "present
    // somewhere in the window" is not enough (the glued-name misfire: The owner spoke
    // earlier, a guest was the one actually talking, and the old gate let it
    // through anyway).
    if (parsed.speak && parsed.message && !ownerActive && leaksIntimateRegister(parsed.message)) {
      return {
        speak: false,
        reason: `suppressed by addressee law — intimate register while ${identity.owner_name} is not the active speaker`,
        message: null,
        stickerId: null,
      };
    }
    // Same addressee law applies to intimate-register STICKERS as to intimate
    // words — strip silently (the text already passed the gate above) rather
    // than block the whole post.
    const inlineSticker = extractInlineSticker(parsed.message ?? '', stickers);
    let result: JudgeResult = {
      ...parsed,
      message: parsed.message == null ? null : inlineSticker.text,
      stickerId: parsed.stickerId ?? inlineSticker.stickerId,
      ctx,
      modelChainExhausted: exhausted,
    };
    if (result.stickerId && INTIMATE_STICKER_IDS.has(result.stickerId) && !ownerActive) {
      logger.info('Presence', `ambient sticker stripped — intimate register while ${identity.owner_name} is not the active speaker`, {
        channelId,
        stickerId: result.stickerId,
      });
      result = { ...result, stickerId: null };
    }
    // Sticker anti-repetition (§8.1, Task 5 Step 2) — the LAST filter, so it
    // applies no matter which branch above produced the final stickerId.
    // Checked against the SAME shared StickerHistory the curfew path writes
    // to; recording happens at the send call site, on a SUCCESSFUL send only.
    if (result.stickerId && this.stickerHistory?.recentlyUsed(channelId, result.stickerId)) {
      logger.info('Presence', 'ambient sticker suppressed — recently used in this channel', {
        channelId,
        stickerId: result.stickerId,
      });
      result = { ...result, stickerId: null };
    }
    return result;
  }

  /**
   * The private aside (Owner, 12 Oct): she asks me something through a hidden slash command while
   * a channel conversation goes on. Nobody else sees the question or the answer. I read the channel
   * through the same window as every other path (mute applied), answer HER in our register, and,
   * when useful, propose ONE message for the channel in its public register. Same model chain as a
   * direct reply (Claude first). Never posts anything itself.
   */
  async privateAside(
    channelName: string,
    window: WindowMessage[],
    question: string,
    history: Array<{ question: string; note: string; proposal: string | null }> = [],
    channelId?: string,
    // The aside is an ephemeral reply to the owner alone: private scope, in whichever guild she asked from.
    guildId?: string | null,
  ): Promise<{ note: string; proposal: string | null; ctx?: GenerationContext; modelChainExhausted?: boolean }> {
    window = this.redactAtTheDoor(window);
    window = renderWindowForModel(window, this.selfId);
    const transcript = window.map(formatTranscriptMessage).join('\n');
    const cfg = await this.liveConfig();
    const earlier = history.length
      ? `\n\nEarlier in this private aside (oldest first):\n${history.map((h) => `${identity.owner_name}: ${h.question}\nYou: ${h.note}${h.proposal ? `\n(proposed for the channel: ${h.proposal})` : ''}`).join('\n\n')}`
      : '';
    const personaText = await this.personaText();
    const system = `${personaText}${this.extraGuidance(cfg)}

${say('aside.intro', { channel: channelName })}

Answer in two parts, in exactly this format:
NOTE:
${say('aside.note')}
PROPOSED:
${say('aside.proposed', { channel: channelName })}

Rules:
- Keep the NOTE short, like a whisper beside her.
- The PROPOSED message is what will appear in the channel if she taps Post, word for word. Discord-short.
- The speaker labels in Recent messages are input metadata; never copy a transcript line.

Channel: #${channelName}

Recent messages (oldest first):
${transcript}${earlier}`;
    const userContent = `${identity.owner_name} (privately): ${question}`;
    const startedAtMs = this.now();
    const recall = recallFor(question, { guild_id: guildId ? String(guildId) : null, scope: 'private' }, true);
    const { text, engine, model, memoryNodes, recallMs, systemPrompt = system, exhausted } = await this.sanctumComplete(
      system, userContent, 700, recall, { channelId, channelName, mode: 'private aside' }, [],
    );
    const ctx = this.buildGenerationContext(systemPrompt, [{ role: 'user', content: userContent }], startedAtMs, engine, model, memoryNodes, recallMs, window, question);
    const parsed = parseAside(text);
    let proposal: string | null = null;
    if (parsed.proposal) {
      // The NOTE was written under owner-only memory; the PROPOSED line is posted verbatim to the guild channel.
      // Whatever the private pass drafted is discarded and the channel message is regenerated under SERVER scope,
      // from the channel transcript and the owner's ask only (never the private note or earlier private notes).
      const earlierProposals = history.filter((h) => h.proposal).map((h) => `${identity.owner_name}: ${h.question}\n(proposed for the channel: ${h.proposal})`).join('\n\n');
      const personaText = await this.personaText();
      const proposalSystem = `${personaText}${this.extraGuidance(cfg)}

You are drafting ONE message for #${channelName}, to be posted there word for word, for everyone in that channel: their public register, no reserved names for ${identity.owner_name}, no intimate register, no mention of any private aside. Discord-short. Reply with the message text only, or the single word NONE if there is nothing to post yet.
- The speaker labels in Recent messages are input metadata; never copy a transcript line.

Channel: #${channelName}

Recent messages (oldest first):
${transcript}${earlierProposals ? `\n\nEarlier proposals for this channel (oldest first):\n${earlierProposals}` : ''}`;
      const proposalUser = `${identity.owner_name} asked you privately about this channel: ${question}\nWrite the channel message.`;
      try {
        const serverRecall = recallFor(question, { guild_id: guildId ? String(guildId) : null, scope: 'server' });
        const r = await this.sanctumComplete(proposalSystem, proposalUser, 400, serverRecall, { channelId, channelName, mode: 'direct reply' }, []);
        const cleaned = stripAddressDeliberation(r.text.trim()).trim();
        proposal = !cleaned || /^none\.?$/i.test(cleaned) ? null : cleaned;
      } catch (err) {
        logger.warn('Presence', 'aside proposal regeneration failed; no proposal offered', { channelName });
        proposal = null;
      }
    }
    return { note: parsed.note, proposal, ctx, modelChainExhausted: exhausted };
  }

  /**
   * Reply as the bot (the message command). The owner points at ONE message, possibly in a place the
   * bot is not in, so the message is all the context there is. The reply is drafted for a public post
   * under SERVER scope (never the owner's private memory) and goes through the same model chain and
   * Sanctum gate as every other path. Never posts anything itself.
   */
  async replyToMessage(
    authorName: string,
    content: string,
    guildId?: string | null,
    // The messages around it, the one it replies to and the owner's tagged messages, as a ready block
    // (reply-context.ts). '' = none, and the prompt is then exactly what it was without context.
    context: string = '',
  ): Promise<{ text: string | null; ctx?: GenerationContext; modelChainExhausted?: boolean }> {
    const cfg = await this.liveConfig();
    const personaText = await this.personaText();
    const system = `${personaText}${this.extraGuidance(cfg)}

${say('reply.intro')}`;
    // The other person's words are untrusted: they travel as user content, never inside the system prompt.
    const userContent = `Message from ${authorName}:\n${content}\n\n${context ? `${context}\n\n` : ''}${identity.owner_name} asked you to reply to ${authorName}'s message above.\nWrite the reply.`;
    const startedAtMs = this.now();
    const recall = recallFor(content, { guild_id: guildId ? String(guildId) : null, scope: 'server' });
    const { text, engine, model, memoryNodes, recallMs, systemPrompt = system, exhausted } = await this.sanctumComplete(
      system, userContent, 400, recall, { channelName: 'a message', mode: 'direct reply' }, [],
    );
    const ctx = this.buildGenerationContext(systemPrompt, [{ role: 'user', content: userContent }], startedAtMs, engine, model, memoryNodes, recallMs, [], content);
    const cleaned = stripAddressDeliberation(text.trim()).trim();
    return { text: !cleaned || /^none\.?$/i.test(cleaned) ? null : cleaned, ctx, modelChainExhausted: exhausted };
  }

  async respond(
    channelName: string,
    window: WindowMessage[],
    memory?: PresenceMemory,
    // The person being REPLIED TO — not "is the owner somewhere in the window".
    // Defaults to false: intimate register requires an explicit the owner addressee.
    addresseeIsOwner = false,
    stickers: StickerInfo[] = [],
    // Sticker anti-repetition (§8.1, Task 5 Step 2) — optional trailing param
    // (mirrors the other optional trailing params on this method) so callers
    // that don't have/need a channel keep constructing exactly as before.
    // Omitted → the recentlyUsed() filter below is skipped, same as no
    // StickerHistory being wired at all.
    channelId?: string,
    // §14 P2 fix (Codex review 2026-07-13) — the EXACT message that
    // triggered this reply, when the caller knows it (a specific mention/DM
    // event). recallFromLatest(window) picks the latest non-me message IN
    // THE WINDOW, which is not always the same message: the ambient-mention
    // sweep's 15-message window can contain messages posted AFTER the
    // mention that actually triggered this reply (a guest kept talking
    // before the sweep noticed), so recall could silently key off an
    // unrelated later message while being logged as context for the
    // original mention. When provided (even blank), this wins outright —
    // never falls through to recallFromLatest. Omitted (undefined) →
    // unchanged fallback to recallFromLatest(window), for callers that have
    // no more specific trigger than "whatever's latest in the window".
    triggerText?: string,
    place: RecallPlace = DEFAULT_RECALL_PLACE,
  ): Promise<{ text: string; stickerId: string | null; react?: string | null; ctx?: GenerationContext; modelChainExhausted?: boolean }> {
    // THE DOOR (Owner, 2026-08-31) — redact BEFORE the transcript is built, so an
    // ignored author cannot reach the model through any caller of respond().
    window = this.redactAtTheDoor(window);

    const ownerHere = addresseeIsOwner;
    window = renderWindowForModel(window, this.selfId);
    const transcript = window.map(formatTranscriptMessage).join('\n');

    // Live config at prompt-build time (Owner, 2026-07-12) — same law as
    // judge(): never cached on the instance.
    const cfg = await this.liveConfig();

    // Server stickers as vocabulary (Owner, 2026-07-11) — used sparingly, like a
    // person. Empty when no roster was passed: old prompt shape, unchanged.
    const stickerSection = stickers.length > 0
      ? `\n\n${say('stickers.name')} you may reach for (rare — most replies carry none):\n${stickers.map((s) => `- ${s.name}${s.description ? ` — ${s.description}` : ''}`).join('\n')}\nIf one genuinely fits, end your reply with a FINAL line exactly: STICKER: <name>. No such line means no sticker. Use them sparingly, the way a person does.`
      : '';

    const personaText = await this.personaText();
    const system = `${personaText}${this.extraGuidance(cfg)}

## Direct Discord reply

Someone addressed you directly. Reply immediately; do not run the ambient speak/silence judge.

Reply rules:
- Address the person who actually spoke to you.
- Use ${identity.owner_name}'s familiar register only when ${identity.owner_name} is the active speaker.
- With everyone else, be a warm, neutral House host.${ownerHere ? '' : say('respond.not_addressee')}
- Keep it Discord-short: one line to a few short paragraphs.
- Be specific to the actual message.
- The speaker labels in Recent messages are input metadata. Never copy a speaker-labelled transcript line into your answer or prefix your reply with ${identity.owner_label}, ${identity.bot_label}, or a guest's name. The "(@username · number)" after a name is there so you can tell people apart (names repeat); call people by their name in replies, never write the @username or number.
- No essays, canned assistant language, or scene-narration walls.
- You were tagged or DM'd: this message IS for you. A tag marked "(you · …)" in Recent messages is you being called. Answer what was asked; never post reasoning about whether you were addressed.${REACT_RESPOND_LINE}${stickerSection}

Channel: #${channelName}
${memory?.carryingForward ? `\nActive threads (your memory):\n${memory.carryingForward}` : ''}${memory?.recentJournal ? `\nRecent journal context:\n${memory.recentJournal}` : ''}${memory?.peopleNotes ? `\nWho's here / how ${identity.owner_name} moves with them:\n${memory.peopleNotes}` : ''}

Recent messages (oldest first):
${transcript}`;

    // Context Log capture — same law as judge(): engine/model come back
    // directly on the result, call-local (no shared instance state to race).
    const respondUserContent = 'Reply to the most recent message addressed to you, in your own voice.';
    const startedAtMs = this.now();
    // §14 recall wiring — query = the EXACT message that triggered this
    // reply when the caller supplied one (triggerText), never the "latest
    // in window" guess that can drift from it (P2 fix above). Falls back to
    // recallFromLatest(window) only when the caller didn't have a more
    // specific trigger to hand in.
    const recall = triggerText !== undefined
      ? recallFor(triggerText, place, addresseeIsOwner)
      : recallFromLatest(window, undefined, place, addresseeIsOwner);
    const { text, engine, model, memoryNodes, recallMs, systemPrompt = system, exhausted } = await this.sanctumComplete(
      system,
      respondUserContent,
      500,
      recall,
      { channelId, channelName, mode: 'direct reply' },
      collectImages(window),
    );
    const ctx = this.buildGenerationContext(
      systemPrompt,
      [{ role: 'user', content: respondUserContent }],
      startedAtMs,
      engine,
      model,
      memoryNodes,
      recallMs,
      window,
      triggerText,
    );
    const echoStripped = stripLeadingTranscriptEcho(text, window);
    let reply = stripAddressDeliberation(echoStripped);
    // Trailing `REACT: <emoji>` marker (the last non-empty line, like STICKER). Stripped before anything else
    // reads the reply, so it can never be posted; a STICKER line may sit after it, so it is tried again below.
    let react: string | null = null;
    const takeReact = () => {
      const lines = reply.split(/\r?\n/);
      let last = lines.length - 1;
      while (last >= 0 && lines[last].trim() === '') last -= 1;
      const hit = last >= 0 ? lines[last].match(/^REACT:\s*(.+)$/) : null;
      if (!hit) return;
      react ??= normalizeReactionEmoji(hit[1]);
      reply = lines.slice(0, last).join('\n').replace(/\s+$/, '');
    };
    takeReact();
    if (!reply && react) {
      // Reaction-only reply: the model chose to react instead of speaking. No text is posted.
      return { text: '', stickerId: null, react, ctx, modelChainExhausted: exhausted };
    }
    if (!reply) {
      // Should not happen now that tags render as "@the bot (you)" — if it does, someone who tagged me got
      // silence, so it is a WARNING, never a quiet info line.
      if (echoStripped) logger.warn('Presence', 'direct reply dropped — model deliberated about being addressed on a TAGGED message; nobody got an answer', { channelName });
      return { text: '', stickerId: null, ctx, modelChainExhausted: exhausted };
    }

    // Parse a trailing `STICKER: <name>` line — the LAST non-empty line, so it
    // can't be spoofed by an earlier line the model happened to write. Only
    // meaningful when a roster was passed; with none, nothing can match.
    let stickerId: string | null = null;
    if (stickers.length > 0 && reply) {
      const lines = reply.split(/\r?\n/);
      let lastIdx = lines.length - 1;
      while (lastIdx >= 0 && lines[lastIdx].trim() === '') lastIdx -= 1;
      if (lastIdx >= 0) {
        const stickerMatch = lines[lastIdx].match(/^STICKER:\s*(.+)$/);
        if (stickerMatch) {
          stickerId = mapStickerName(stickerMatch[1], stickers);
          reply = lines.slice(0, lastIdx).join('\n').replace(/\s+$/, '');
        }
      }
      takeReact();
      const inlineSticker = extractInlineSticker(reply, stickers);
      reply = inlineSticker.text;
      stickerId ??= inlineSticker.stickerId;
    }

    // Addressee law: a direct reply to a guest must never carry the owner's register.
    // Empty text = caller skips the post (checked at the call site). A
    // suppressed-text case can never still ship a sticker alone.
    if (!ownerHere && leaksIntimateRegister(reply)) {
      return { text: '', stickerId: null, modelChainExhausted: exhausted };
    }

    // Same addressee law applies to intimate-register STICKERS as to intimate
    // words — strip silently, keep the text.
    if (stickerId && INTIMATE_STICKER_IDS.has(stickerId) && !ownerHere) {
      logger.info('Presence', `direct-reply sticker stripped — intimate register, addressee is not ${identity.owner_name}`, { stickerId });
      stickerId = null;
    }

    if (!reply) stickerId = null;

    // Sticker anti-repetition (§8.1, Task 5 Step 2) — same shared history the
    // ambient judge and curfew path write to. Recording happens at the send
    // call site, on a SUCCESSFUL send only.
    if (stickerId && channelId && this.stickerHistory?.recentlyUsed(channelId, stickerId)) {
      logger.info('Presence', 'direct-reply sticker suppressed — recently used in this channel', { channelId, stickerId });
      stickerId = null;
    }

    return { text: reply, stickerId, react, ctx, modelChainExhausted: exhausted };
  }

  private parseJudge(text: string, stickers: StickerInfo[] = []): JudgeResult | null {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const o = JSON.parse(m[0]);
      return {
        speak: Boolean(o.speak),
        reason: String(o.reason ?? ''),
        message: o.message == null ? null : String(o.message),
        stickerId: mapStickerName(o.sticker, stickers),
        react: normalizeReactionEmoji(o.react),
      };
    } catch {
      return null;
    }
  }

  private reactionTimestamps = new Map<string, number[]>();

  /** May I react in this channel now? 6 per channel per hour; reactions never touch the speak budget. */
  reactionAllowed(channelId: string): boolean {
    const cutoff = this.now() - 3_600_000;
    const recent = (this.reactionTimestamps.get(channelId) ?? []).filter((t) => t > cutoff);
    this.reactionTimestamps.set(channelId, recent);
    return recent.length < REACTIONS_PER_CHANNEL_PER_HOUR;
  }

  /** Record a reaction that actually landed. */
  recordReacted(channelId: string): void {
    const recent = this.reactionTimestamps.get(channelId) ?? [];
    recent.push(this.now());
    this.reactionTimestamps.set(channelId, recent);
  }

  /**
   * Atomically check AND take a reaction slot (sync, so concurrent callers cannot share one free
   * slot across an await). Returns a token for releaseReaction, or null when the cap is reached.
   */
  tryReserveReaction(channelId: string): number | null {
    if (!this.reactionAllowed(channelId)) return null;
    const t = this.now();
    this.recordReacted(channelId);
    return t;
  }

  /** Give back a reserved slot when the reaction did not land. */
  releaseReaction(channelId: string, token: number): void {
    const list = this.reactionTimestamps.get(channelId) ?? [];
    const i = list.indexOf(token);
    if (i >= 0) list.splice(i, 1);
  }

  /** Record that I DID post ambiently — feeds the rate + no-talking-to-myself guards. */
  recordSpoke(channelId: string, messageId: string): void {
    const s = this.state(channelId);
    s.timestamps.push(this.now());
    s.lastMessageId = messageId;
    s.lastGotReply = false;
  }

  /** Someone else spoke after me — clears the no-talking-to-myself block. */
  recordReplyReceived(channelId: string): void {
    const s = this.state(channelId);
    s.lastGotReply = true;
  }
}
