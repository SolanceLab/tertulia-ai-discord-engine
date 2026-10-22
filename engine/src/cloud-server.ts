#!/usr/bin/env node
// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)

/**
 * Cloud Entry Point for the bot Discord Bot
 *
 * Runs on Fly.io (or similar). Starts:
 * 1. Discord client (WebSocket to Gateway)
 * 2. HTTP API server (for MCP clients to call)
 * 3. Mention/DM handlers (auto-response via Sanctum)
 *
 * No MCP stdio — that's handled by the local mcp-server.ts proxy.
 * No lock file — Fly.io guarantees single instance.
 */

import './load-env.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { replyParentId, DiscordClient, MentionEvent } from './discord-client.js';
import { buildReactions, mentionReplyOutcome } from './reaction-store.js';
import { toMessageAttachments } from './attachments.js';
import { MemoryManager } from './memory.js';
import { recallPlaceFor, fillReplyAuthorNames, mentionedUsersOf, stripIgnoredMessages, imageEgressAllowed, PresenceEngine, HOS_SERVER_ID, DEFAULT_FALLBACK_TARGETS, recallFromLatest } from './presence-engine.js';
import type { ModelTarget, WindowMessage } from './presence-engine.js';
import { resolveSanctumUrl, houseConfig, resolveSolanceApiUrl } from './config/house-config.js';
import { resolveOwnerUserId, identity, identityVars } from './config/identity.js';
import { resolveCommandNames } from './config/identity-defaults.js';
import { createSeams } from './seams/index.js';
import { startAuditCopy } from './audit-log-copy.js';
import { DirectModelProvider } from './seams/direct-model-provider.js';
import { recallFor } from './presence/window.js';
import { buildCurfewSanctumBody, buildCurfewSystemPrompt, CurfewWatch } from './curfew-watch.js';
import type { GenerateNudge } from './curfew-watch.js';
import { PresenceConfig } from './presence-config.js';
import { SceneCatch, buildSceneCatchPrompt } from './scene-catch.js';
import type { GenerateSceneCatch } from './scene-catch.js';
import { MAX_CHANNEL_BUFFER, MAX_FLUSH_BATCH, ContextCollector } from './context-collector.js';
import type { IngestMessage } from './context-collector.js';
import { GenerationContextRegistry } from './generation-context.js';
import type { GenerationContext } from './generation-context.js';
import { createHttpServer } from './http-server.js';
import { logger } from './logger.js';
import { walkChain } from './model-chain.js';
import { ModelSuccession, isRetiredError, fetchNvidiaCatalog } from './model-succession.js';
import { buildAwaySanctumBody, registerCheck, type AwayModelTarget, quoteForDM, messageLink, AWAY_PRIMARY_TARGET, type AwayInquiryEvent, handleAwayInquiry, type SanctumPrompt, isSideCallSystem } from './away-handler.js';
import { fetchAwayStatus } from './away-status.js';
import { createAwayNoticeTracker } from './away-tracker.js';
import { type SoftPresenceEvent, createJudgeDebounce, handleSoftPresence } from './soft-presence.js';
import { speakerLock } from './speaker-lock.js';
import { ModelChainAlertReporter } from './model-chain-alert.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const OWNER_USER_ID = resolveOwnerUserId();
const BOT_API_SECRET = process.env.BOT_API_SECRET || '';
const BOT_API_PORT = parseInt(process.env.BOT_API_PORT || '3000', 10);
const SANCTUM_URL = resolveSanctumUrl();
const SANCTUM_KEY = process.env.SANCTUM_KEY || '';
const SOLANCE_API_URL = resolveSolanceApiUrl();
const SOLANCE_TOKEN = process.env.SOLANCE_TOKEN || '';
const PRESENCE_ENABLED = process.env.PRESENCE_ENABLED === 'true';
// Default = 30 min, the owner's ruling for the ambient sweep cadence. The Fly env
// var sets the same value; this default exists so losing the env var can never
// silently change the cadence she chose (it used to default to 18 min — a trap).
const PRESENCE_HEARTBEAT_INTERVAL_MS = parseInt(process.env.PRESENCE_HEARTBEAT_INTERVAL_MS || `${30 * 60_000}`, 10);
const PRESENCE_ERROR_CHANNEL_ID = process.env.PRESENCE_ERROR_CHANNEL_ID || houseConfig.presenceErrorChannelId || '';
// `engine:model,engine:model` — a bare token means the nvidia engine. Shared by
// PRESENCE_FALLBACK_MODELS (text chain) and PRESENCE_VISION_MODELS (image chain)
// so both env vars accept exactly one format.
function parseModelTargets(spec: string | undefined): ModelTarget[] | undefined {
  return spec
    ?.split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const colonIndex = token.indexOf(':');
      if (colonIndex === -1) return { engine: 'nvidia', model: token };
      return {
        engine: token.slice(0, colonIndex).trim(),
        model: token.slice(colonIndex + 1).trim(),
      };
    })
    .filter((target) => target.engine && target.model);
}

const PRESENCE_FALLBACK_TARGETS: ModelTarget[] | undefined = parseModelTargets(process.env.PRESENCE_FALLBACK_MODELS);
// First rung of every TEXT reply chain — ambient, direct, away and curfew (Owner, 12 Oct:
// "Claude as the first one, then the next layer GLM, Kimi, Grok"). `engine:model`, e.g.
// `claude:claude-sonnet-5-5`. Unset → GLM on NVIDIA, as before. Image turns keep their own chain.
const PRESENCE_PRIMARY_TARGET: ModelTarget | undefined = parseModelTargets(process.env.PRESENCE_PRIMARY_MODEL)?.[0];
// Image-turn chain. Unset → DEFAULT_VISION_TARGETS (gemini free → kimi → grok).
const PRESENCE_VISION_TARGETS: ModelTarget[] | undefined = parseModelTargets(process.env.PRESENCE_VISION_MODELS);

// Validate required config
if (!DISCORD_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN is required');
  process.exit(1);
}
if (!BOT_API_SECRET) {
  console.error('❌ BOT_API_SECRET is required for cloud deployment');
  process.exit(1);
}
// OWNER_USER_ID must be a well-formed Discord snowflake (15-21 digits) for the away
// branch to run (§0.B Rule 4 — grok: don't guess who the owner is). Away is a feature,
// not the whole bot, so this degrades the away branch rather than exiting.
if (!/^\d{15,21}$/.test(OWNER_USER_ID)) {
  logger.error('Cloud', 'OWNER_USER_ID missing/malformed — away branch will be dormant');
}

// Initialize components
const discordClient = new DiscordClient(OWNER_USER_ID);
// The private aside's slash-command name: the env var wins, else identity.aside_command (generic `/aside`).
const commandNames = resolveCommandNames(identity, { ASIDE_COMMAND_NAME: process.env.ASIDE_COMMAND_NAME, FOLLOWUP_COMMAND_NAME: process.env.FOLLOWUP_COMMAND_NAME });
discordClient.setAsideCommandName(commandNames.aside);
discordClient.setFollowupCommandName(commandNames.followup);
discordClient.studyGuestText = process.env.STUDY_ASIDE_GUEST_TEXT === 'on';
const memory = new MemoryManager(path.resolve(__dirname, '../memory-ledger.json'), undefined, houseConfig.plugs.memory !== 'off');
let presenceEngine: PresenceEngine | null = null;

// Context Log capture registry (Owner, 2026-07-13, FORWARD ONLY, no backfill) —
// the ONE registry every generation site (presence-engine's judge()/respond(),
// the curfew nudge generator, the away generator below) builds a ctx for, and
// every send site (discord-client.ts's sendMessage callers, the away
// sendMessage wrapper below) registers into immediately after a successful
// send. context-collector.ts takes() it at flush time — see contextCollector
// construction below.
const generationContext = new GenerationContextRegistry();
discordClient.setGenerationContextRegistry(generationContext);

// Curfew reflex wording — Sanctum flavors the line, but a fixed fallback
// (inside CurfewWatch) covers any failure. Pattern matches PresenceEngine's
// callModel: single attempt, 10s AbortController timeout, no retries here —
// the escalation-level fallback line IS the retry.
// Walks the same model chain as ambient presence. It used to call GLM alone
// with a 10s timeout that also had to cover memory recall (up to 7s), so the
// fixed FALLBACK_LINES went out 20 times between 11 and 26 Sep 2026: most
// curfew nights the owner got a template instead of me.
// Retired-model succession (model-succession.ts), shared by every Discord
// model path so each retired model is reported to the owner once. The DM is sent
// lazily, so discordClient being declared further down is fine.
// Seams: settings, model calls and memory are reached only through these, chosen in ONE place
// (seams/index.ts) from the house config `plugs`. The House file gives Sanctum + solance-api.
const seams = createSeams({
  sanctum: { url: SANCTUM_URL, key: SANCTUM_KEY, timeoutMs: 30000, primaryTarget: PRESENCE_PRIMARY_TARGET ?? { engine: 'nvidia', model: 'z-ai/glm-5.3' } },
  solance: { url: SOLANCE_API_URL, token: SOLANCE_TOKEN },
});
const settingsStore = seams.settingsStore;
const modelProvider = seams.modelProvider;
const MODEL_READY = seams.modelReady;
const SETTINGS_READY = seams.settingsReady;
discordClient.setSettingsStore(settingsStore, SETTINGS_READY);
if (modelProvider instanceof DirectModelProvider) modelProvider.setChannelGuildResolver((id) => discordClient.guildOfChannel(id));
const modelSuccession = new ModelSuccession({
  fetchCatalog: () => fetchNvidiaCatalog(),
  notify: async (message) => {
    if (!/^\d{15,21}$/.test(OWNER_USER_ID)) return;
    await discordClient.sendDM(OWNER_USER_ID, message);
  },
  log: (msg, meta) => logger.info('Models', msg, meta),
});

/**
 * POST one Sanctum /complete for a chain target, swapping in a successor when
 * the model has been retired (known already, or discovered on this call).
 * Returns the response and the model that actually produced it, or null.
 */
async function completeWithSuccession(
  configured: AwayModelTarget,
  bodyFor: (target: AwayModelTarget) => unknown,
  signal: AbortSignal,
): Promise<{ response: Response; target: AwayModelTarget } | null> {
  const post = (target: AwayModelTarget) => modelProvider.postComplete(bodyFor(target), signal);
  if (modelProvider.singleModel && modelProvider.identity) {
    // One configured model: no retirement succession (that is an NVIDIA catalog affair), and the
    // generation is attributed to the model that actually ran.
    const response = await post(modelProvider.identity);
    return response.ok ? { response, target: modelProvider.identity } : null;
  }
  let target = modelSuccession.resolve(configured);
  let response = await post(target);
  if (!response.ok) {
    const errText = await Promise.resolve().then(() => response.text()).then((t) => String(t).slice(0, 2000)).catch(() => '');
    if (!isRetiredError(errText)) return null;
    const next = await modelSuccession.noteRetired(target);
    if (!next || next.model === target.model) return null;
    target = next;
    response = await post(target);
    if (!response.ok) return null;
  }
  return { response, target };
}

/** A single-model provider gets a one-entry chain: fallbacks would repeat the same request. */
const chainFor = (chain: AwayModelTarget[]): AwayModelTarget[] => (modelProvider.singleModel ? chain.slice(0, 1) : chain);
const CURFEW_CHAIN: AwayModelTarget[] = [PRESENCE_PRIMARY_TARGET ?? AWAY_PRIMARY_TARGET, ...(PRESENCE_FALLBACK_TARGETS ?? DEFAULT_FALLBACK_TARGETS)];
const CURFEW_MODEL_TIMEOUT_MS = 12_000;
const CURFEW_CHAIN_BUDGET_MS = 30_000;

const generateCurfewNudge: GenerateNudge = async (level, channelName, window, triggerText, place) => {
  if (!MODEL_READY) return '';
  const startedAtMs = Date.now();
  try {
    // Context-aware nudge (Plan 2b Task 1, §7) — when the live channel window
    // is non-empty, the nudge is grounded in what the owner is actually saying instead
    // of firing context-blind. An empty/failed window is a silent enhancement
    // miss, never a precondition. Guests, links and my own prior replies stay in
    // their real order, as reference data inside explicit delimiters
    // (buildCurfewSystemPrompt, curfew-watch.ts).
    const stripTags = (s: string) => s.replace(/<\/?discord_recent_messages>/gi, '');
    const contextWindow = window.map((m) => ({
      ...m,
      authorName: stripTags(m.authorName),
      content: stripTags(m.content),
    }));
    const system = buildCurfewSystemPrompt(level, channelName, contextWindow);
    const userMessage = { role: 'user' as const, content: `Write the level ${level} curfew nudge.` };
    // §14 recall wiring — curfew is OWNER-facing (she's the addressee, always),
    // so memory is appropriate and wanted. Built from the EXACT message that
    // triggered THIS nudge (triggerText, §14 P2 fix, Codex review 2026-07-13)
    // — never from `window`, a separately-fetched rolling fetch that can omit
    // the triggering message entirely or include a newer the owner message that
    // landed while the nudge was being generated, either of which would
    // recall against the wrong turn. Falls back to the old window-derived
    // pick only if triggerText wasn't supplied at all (defensive — every real
    // caller now passes it). Never a hard dependency: an omitted/failed
    // recall still leaves the tone/fallback lines above intact.
    const recall = triggerText !== undefined
      ? recallFor(triggerText, place, true)
      : recallFromLatest(window, (m) => m.isFromOwner, place, true);
    type CompleteResponse = { text?: string; memory_nodes?: unknown[]; recall_ms?: number; system_prompt?: string };
    const won = await walkChain<{ d: CompleteResponse; target: AwayModelTarget }>(chainFor(CURFEW_CHAIN), async (target, signal) => {
      const hit = await completeWithSuccession(target, (t) => buildCurfewSanctumBody(system, userMessage, recall, t), signal);
      if (!hit) return null;
      const d = (await hit.response.json()) as CompleteResponse;
      return d?.text && d.text.trim() ? { d, target: hit.target } : null;
    }, { budgetMs: CURFEW_CHAIN_BUDGET_MS, perModelMs: CURFEW_MODEL_TIMEOUT_MS, log: (msg, meta) => logger.info('Curfew', msg, meta) });
    if (!won) return '';
    const data = won.result.d;
    const used = won.result.target;
    const normalizedTriggerText = triggerText !== undefined ? stripTags(triggerText) : undefined;
    const triggerSource = normalizedTriggerText !== undefined
      ? [...contextWindow].reverse().find((m) => m.isFromOwner && m.content === normalizedTriggerText)
      : [...contextWindow].reverse().find((m) => m.isFromOwner);
    const discordContext = contextWindow.map((m) => ({
      ...(m.id ? { message_id: m.id } : {}),
      author_id: m.authorId,
      author_name: m.authorName,
      content: m.content,
      timestamp: new Date(m.timestampMs).toISOString(),
      is_from_me: m.isFromMe,
      ...(m === triggerSource ? { is_trigger: true } : {}),
    }));
    // Context Log capture (Owner, 2026-07-13) — curfew-watch.ts's caller
    // discards this ctx whenever the returned text is empty (no-fabrication
    // law: the fallback line isn't attributable to this call), so it's safe
    // to always build it here for a 2xx response. memory_nodes/recall_ms
    // (§14) come straight from Sanctum's response — [] when recall wasn't
    // requested/nothing came back, never fabricated.
    const ctx: GenerationContext = {
      engine: used.engine,
      model: used.model,
      processing_time_ms: Date.now() - startedAtMs,
      system_prompt: data.system_prompt || system,
      system_prompt_length: (data.system_prompt || system).length,
      conversation_history: [userMessage],
      conversation_history_count: 1,
      ...(discordContext.length > 0 ? { discord_context: discordContext } : {}),
      ...(triggerSource ? {
        trigger_message: {
          ...(triggerSource.id ? { message_id: triggerSource.id } : {}),
          author_id: triggerSource.authorId,
          author_name: triggerSource.authorName,
          content: triggerSource.content,
          timestamp: new Date(triggerSource.timestampMs).toISOString(),
          is_from_me: false,
          is_trigger: true,
        },
      } : {}),
      channel_instruction_source: 'fly-bot',
      memory_nodes: data.memory_nodes ?? [],
      ...(data.recall_ms !== undefined ? { recall_ms: data.recall_ms } : {}),
    };
    return { text: data.text || '', ctx };
  } catch (err: any) {
    logger.info('Curfew', 'nudge generation failed — falling back to fixed line', { level, error: err?.message });
    return '';
  }
};

// Config + event-log calls need SOLANCE_TOKEN; generation gracefully falls
// back to fixed lines without SANCTUM_KEY, so it is not a hard dependency here.
const curfewWatch = SETTINGS_READY
  ? new CurfewWatch(SOLANCE_API_URL, SOLANCE_TOKEN, generateCurfewNudge, undefined, settingsStore)
  : null;
if (curfewWatch) {
  discordClient.setCurfewWatch(curfewWatch);
} else {
  logger.error('Cloud', 'Curfew reflex DORMANT: settings store is not configured (SOLANCE_TOKEN is missing)');
}

// Scene-flag drag-back (spec specs/2026-09-28-scene-flag.md). Same chain,
// same body builder and same timeouts as the curfew nudge. No recall: the model
// gets the channel name and her one message as fenced data, nothing else. No
// fallback line — an empty result means SceneCatch sends nothing and releases
// the claim (scene-catch.ts), and the a gated name-name gate runs there, in code.
const generateSceneCatch: GenerateSceneCatch = async (channelName, messageText) => {
  if (!MODEL_READY) return { text: '' };
  const startedAtMs = Date.now();
  const { system, userMessage } = buildSceneCatchPrompt(channelName, messageText);
  type CompleteResponse = { text?: string; system_prompt?: string };
  const won = await walkChain<{ d: CompleteResponse; target: AwayModelTarget }>(chainFor(CURFEW_CHAIN), async (target, signal) => {
    const hit = await completeWithSuccession(target, (t) => buildCurfewSanctumBody(system, userMessage, undefined, t), signal);
    if (!hit) return null;
    const d = (await hit.response.json()) as CompleteResponse;
    return d?.text && d.text.trim() ? { d, target: hit.target } : null;
  }, { budgetMs: CURFEW_CHAIN_BUDGET_MS, perModelMs: CURFEW_MODEL_TIMEOUT_MS, log: (msg, meta) => logger.info('Scene', msg, meta) });
  if (!won) return { text: '' };
  const data = won.result.d;
  const used = won.result.target;
  // trigger_message/discord_context are filled at the send site
  // (discord-client.ts), where the exact gateway message is known.
  const ctx: GenerationContext = {
    engine: used.engine,
    model: used.model,
    processing_time_ms: Date.now() - startedAtMs,
    system_prompt: data.system_prompt || system,
    system_prompt_length: (data.system_prompt || system).length,
    conversation_history: [userMessage],
    conversation_history_count: 1,
    channel_instruction_source: 'fly-bot',
    memory_nodes: [],
  };
  return { text: data.text || '', ctx };
};
discordClient.setSceneCatch(new SceneCatch(generateSceneCatch, undefined, (msg, meta) => logger.info('Scene', msg, meta)));

// Live presence config (Owner, 2026-07-12) — one instance, shared by the engine
// (live extra_instructions at prompt-build) and the client (sweep
// cadence, per-channel posture override, sticker toggle). 120s TTL, keep-last-
// known on failure, DEFAULTS until the first successful fetch — see
// presence-config.ts. Constructed unconditionally: a missing SOLANCE_TOKEN just
// means every fetch fails and the poller quietly serves DEFAULTS forever.
const presenceConfig = new PresenceConfig(SOLANCE_API_URL, SOLANCE_TOKEN, { store: settingsStore });
discordClient.setPresenceConfig(presenceConfig);

// --- Context-Log collector (Phase 3, §9/§9.1, Owner 2026-07-12 23:59) ---
//
// EMBEDDING COST LAW (the owner): this flush closure calls Sanctum POST
// /ingest/discord and NOTHING ELSE — no embedding, no Vectorize, no other
// endpoint. Ingestion writes PLAIN D1 rows; the Mac-local Qwen replica
// embeds them free on its own sync (§9 sub-decision 4). Contract: body
// {messages:[...]}, max 100/call — the collector's own 50-msg batch cap
// keeps this under budget in the common case, and flushChannel() also
// splits any oversized buffer (e.g. one that grew past 100 while a prior
// flush was in-flight) into ≤100-message chunks before ever calling this
// closure, so a single call here can never exceed the limit regardless of
// buffer size (root-cause fix, 2026-07-13 re-review). Returns {inserted,
// skipped} — a non-2xx is one failure signal this closure needs; the OTHER
// is the parsed body itself, handed back to the collector so its
// systematic-failure alarm (panel P0) can catch a 2xx response that
// silently inserted nothing.
// Named (not inlined) so SHUTDOWN_FLUSH_TIMEOUT_MS below can be derived from
// the SAME number that bounds each individual /ingest/discord call, instead
// of drifting out of sync with it.
const INGEST_HTTP_TIMEOUT_MS = 10_000;
const contextIngestFlush = async (batch: IngestMessage[]): Promise<{ inserted: number; skipped: number } | void> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INGEST_HTTP_TIMEOUT_MS);
  try {
    const r = await fetch(`${SANCTUM_URL}/ingest/discord`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SANCTUM_KEY}` },
      // guild_id is REQUIRED by the hardened route (panel P0, 2026-07-13): the
      // Worker validates the bot's ingest authority before accepting the batch.
      // It is an API security value, not a filter on which Discord surfaces the
      // bot may record.
      body: JSON.stringify({ guild_id: HOS_SERVER_ID, messages: batch.map(({ reply_to: _replyTo, ...row }) => row) }),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error(`status ${r.status}`);
    // root-cause fix (2026-07-13, Codex NO-SHIP finding): a 2xx status with a
    // body that fails to parse, or parses to something missing numeric
    // inserted/skipped, used to fall through and return `void` — the SAME
    // sentinel this closure returns for the legitimate "no response to give"
    // case (SANCTUM_KEY missing, handled entirely outside this function).
    // recordFlushResult() only inspects a truthy result, so that made a
    // broken-but-2xx Sanctum response indistinguishable from "nothing to
    // report" — the batch was still dropped (drop-on-handoff, by design) but
    // NEITHER the alarm NOR the ordinary "flush failed" log ever fired: a
    // fully silent message-loss path. Throwing here instead routes it through
    // flushChannel's existing catch (the same one non-2xx responses already
    // use), so it is logged every single time, not swallowed.
    let body: any;
    try {
      body = await r.json();
    } catch (err: any) {
      throw new Error(`malformed /ingest/discord response body (2xx, unparseable JSON): ${err?.message}`);
    }
    // The hardened route (panel P0, 2026-07-13) returns {inserted, duplicates,
    // errors} — duplicates are benign idempotent re-sends, errors are real
    // row-level failures. Older shape {inserted, skipped} is still accepted so
    // a bot deployed ahead of the Worker (or vice-versa) degrades instead of
    // throwing on every flush. `skipped` = duplicates + errors for the alarm's
    // purposes; a non-zero `errors` count is surfaced loudly on its own.
    if (!body || typeof body.inserted !== 'number') {
      throw new Error(
        `malformed /ingest/discord response body (2xx, missing/non-numeric inserted): ${JSON.stringify(body)}`
      );
    }
    const duplicates = typeof body.duplicates === 'number' ? body.duplicates : 0;
    const errors = typeof body.errors === 'number' ? body.errors : 0;
    const skipped = typeof body.skipped === 'number' ? body.skipped : duplicates + errors;
    if (errors > 0) {
      logger.error('ContextLog', 'ingest reported row-level ERRORS (not duplicates)', {
        inserted: body.inserted,
        duplicates,
        errors,
        warnings: Array.isArray(body.warnings) ? body.warnings.slice(0, 3) : undefined,
      });
    }
    return { inserted: body.inserted, skipped };
  } finally {
    clearTimeout(timer);
  }
};

// Skip entirely (one boot log, never a per-flush log spam) when SANCTUM_KEY
// is missing — the collector still buffers and gates exactly as configured,
// it just has nowhere to send, so every flush is a silent, logged-once drop.
const CONTEXT_SINK_READY = seams.plugs.memory === 'off' ? true : Boolean(SANCTUM_KEY);
if (!CONTEXT_SINK_READY) {
  logger.info('ContextLog', 'context collector: SANCTUM_KEY missing — flushes will be dropped (buffering continues)');
}
const contextCollector = new ContextCollector({
  getConfig: () => presenceConfig.getCached(),
  // A server can carry its own level for what it remembers; null = the global dial.
  getServerContextLog: (guildId) => discordClient.serverOf(guildId).context_log,
  involvesBot: (msg) => Boolean(msg.involvesBot),
  // memory 'off' → the public sink (local JSONL, or CONTEXT_LOG_URL over http); memory 'sanctum' → Sanctum /ingest/discord (no-op without the key).
  flush: seams.contextLogFlush
    ? (batch) => seams.contextLogFlush!(batch)
    : SANCTUM_KEY ? contextIngestFlush : async () => { /* no-op — boot log above covers it */ },
  // Context Log capture (Owner, 2026-07-13) — the SAME registry every
  // generation/send site above shares; takes() the ctx for a row at flush
  // time, omitted entirely when there is none.
  takeContextLog: (messageId) => generationContext.take(messageId),
  subscribeContextLog: (listener) => generationContext.subscribe(listener),
});
discordClient.setContextCollector(contextCollector);

function truncateForDiscord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function reportMentionFailure(event: MentionEvent, reason: string): Promise<void> {
  try {
    const location = event.guildName
      ? `#${event.channelName} in ${event.guildName}`
      : 'a DM';
    const guildId = event.message.guild?.id || '@me';
    const messageLink = `https://discord.com/channels/${guildId}/${event.channelId}/${event.message.id}`;
    const message = truncateForDiscord(event.content || '(empty)', 800);
    const report = `**${identityVars().Bot} mention failed**\n\n` +
      `**Where:** ${location}\n` +
      `**When:** ${event.timestamp.toISOString()}\n` +
      `**Reason:** ${reason}\n` +
      `**Message:** "${message}"\n\n` +
      `No public reply was sent. **[Jump to message](${messageLink})**`;

    const sent = await discordClient.sendMessage(PRESENCE_ERROR_CHANNEL_ID, truncateForDiscord(report, 1900));
    if (sent) {
      logger.info('Cloud', '✅ Mention failure report posted', { reason, channelId: PRESENCE_ERROR_CHANNEL_ID });
    } else {
      logger.error('Cloud', 'Mention failure report was not posted', { reason, channelId: PRESENCE_ERROR_CHANNEL_ID });
    }
  } catch (err: any) {
    logger.error('Cloud', 'Failed to post mention failure report', { reason, channelId: PRESENCE_ERROR_CHANNEL_ID, error: err?.message });
  }
}

// --- Away proxy handler (Plan 2b Task 3 — clean-room reply when a guest reaches for the owner while she's away) ---

// Sanctum /complete wrapped to the SanctumCall shape the away core expects.
// Same engine/model/timeout as the curfew nudge; returns { text } (empty on any failure).
//
// §14.1 — DO NOT add a `recall` param here. Away is the CLEAN ROOM (§0.B
// Rule 2): a guest-facing reply must draw on NOTHING intimate. Memory for
// away is explicitly gated behind the owner's separate go (spec §14.1) and she
// has NOT given it. The body is built by buildAwaySanctumBody() (away-
// handler.ts) — the single, tested source of truth for this request shape,
// which structurally cannot include `recall` (away-handler.test.ts pins
// this hard) — so a future edit can't "helpfully" add it here without that
// test catching it.
//
// Walks the SAME model chain as ambient presence (GLM first, then
// PRESENCE_FALLBACK_MODELS). It used to call GLM alone, so an NVIDIA outage
// meant every away reply failed (28 Sep 2026: two in one morning).
const AWAY_CHAIN_BUDGET_MS = 25_000;
const AWAY_CHAIN: AwayModelTarget[] = [PRESENCE_PRIMARY_TARGET ?? AWAY_PRIMARY_TARGET, ...(PRESENCE_FALLBACK_TARGETS ?? DEFAULT_FALLBACK_TARGETS)];

const awaySanctumCall = async (req: SanctumPrompt): Promise<{ text: string; target?: AwayModelTarget }> => {
  if (!MODEL_READY) return { text: '' };
  // The whole walk is bounded, not just each model: four targets x 10s, twice
  // over with the register check, would leave a guest waiting minutes.
  const won = await walkChain(chainFor(AWAY_CHAIN), async (target, signal) => {
    const hit = await completeWithSuccession(target, (t) => buildAwaySanctumBody(req, t), signal);
    if (!hit) return null;
    const data = (await hit.response.json()) as { text?: string };
    return data.text && data.text.trim() ? { text: data.text, target: hit.target } : null;
  }, { budgetMs: AWAY_CHAIN_BUDGET_MS, perModelMs: 10_000, log: (msg, meta) => logger.info('Away', msg, meta) });
  return won ? won.result : { text: '' };
};

// Per-channel away cooldown (§0.D) — reserve BEFORE async, 30-min window.
const AWAY_COOLDOWN_MS = 30 * 60_000;
const awayCooldowns = new Map<string, number>();
function tryClaimAwayCooldown(channelId: string, kind: string): boolean {
  const key = `${channelId}:${kind}`;
  const until = awayCooldowns.get(key);
  const now = Date.now();
  if (until && until > now) return false;
  awayCooldowns.set(key, now + AWAY_COOLDOWN_MS);
  if (awayCooldowns.size > 200) { // bound the map — drop expired entries
    for (const [k, exp] of awayCooldowns) if (exp <= now) awayCooldowns.delete(k);
  }
  return true;
}
function releaseAwayCooldown(channelId: string, kind: string): void {
  awayCooldowns.delete(`${channelId}:${kind}`);
}
// Who has already heard that the owner is away, and where — one notice per person
// and per channel for the whole stretch (Owner, 2026-10-03; away-tracker.ts).
const awayNoticeTracker = createAwayNoticeTracker();

discordClient.on('away-inquiry', (event: AwayInquiryEvent) => {
  // This server's away rule 'off' means nothing at all: no reply, no offline heads-up, no DM.
  if (discordClient.serverOf(event.guildId).rules.away === 'off') return;
  // Shown offline (Owner, 2026-09-28): say nothing in the channel, but still
  // tell the owner who reached for her. Same cooldown as a normal away reply, so a
  // chatty guest cannot turn this into a stream of DMs.
  const sendOfflineHeadsUp = () => {
    const quote = quoteForDM(event.content);
    const lines = [
      `${event.guestTag} reached for you in #${event.channelName}. I'm shown offline, so I stayed quiet.`,
      quote ? `> ${quote}` : '',
      messageLink(event.guildId, event.channelId, event.messageId),
    ].filter(Boolean);
    discordClient.sendDM(OWNER_USER_ID, lines.join('\n')).catch((err: any) =>
      logger.error('Away', 'offline heads-up DM failed', { error: err?.message }));
  };
  if (discordClient.guestSpeechHeld()) {
    if (!/^\d{15,21}$/.test(OWNER_USER_ID)) return;
    if (!tryClaimAwayCooldown(event.channelId, 'away')) return;
    sendOfflineHeadsUp();
    return;
  }

  // A channel on the 'silent' step is one the bot never posts in: no away notice there either (Owner,
  // 2026-10-17). After the offline heads-up above, which is a DM to the owner, not a post.
  {
    const gid = event.guildId;
    const awayCfg = presenceConfig.getCached();
    const chName = event.channelName;
    if (gid && discordClient.channelRules(gid, event.channelId, chName, awayCfg).step === 'silent') return;
  }

  // Boot-assert (§0.B Rule 4): a missing/malformed OWNER_USER_ID must make the
  // guest generative path refuse to run — never guess who the owner is.
  if (!/^\d{15,21}$/.test(OWNER_USER_ID)) {
    logger.error('Away', 'away branch DORMANT: OWNER_USER_ID missing/malformed');
    return;
  }
  // Context Log capture (Owner, 2026-07-13) — scoped to THIS event-handler
  // invocation only (a plain local variable, never module-level state), so
  // concurrent away-inquiries in different channels can never cross-
  // contaminate each other's ctx. Captures ONLY the FIRST deps.generate()
  // call — the guest-reply generation (away-handler.ts step 4) — never the
  // SECOND (registerCheck's own read, step 5, which reuses the same
  // `generate` reference): the ctx must describe what produced the reply the
  // guest actually sees, not the fail-closed safety check that ran after it.
  let capturedAwayCtx: GenerationContext | undefined;
  const generateWithCapture = async (req: SanctumPrompt): Promise<{ text: string }> => {
    const startedAtMs = Date.now();
    const result = await awaySanctumCall(req);
    // Capture by IDENTITY, never by ordinal. This used to take the first call
    // and call it "the guest-reply generation" — true until 2026-07-30, when
    // the privacy judge became the first call for any reason that clears the
    // denylist. Two things broke at once: the Context Log recorded a system
    // prompt that never produced the message (a no-fabrication violation), and
    // the RAW REASON was written into the persisted context_log and shipped to
    // /ingest/discord — for exactly the borderline reasons the judge exists to
    // withhold. Withheld from the room and durably stored is the worst of both.
    const isSideCall = isSideCallSystem(req.system);
    // Overwritten on EVERY guest-generation call, not just the first: a draft
    // can be rejected and redrawn (possibly by a different model in the
    // chain), and the loop stops at the first clean draft, so the LAST
    // generation is the one that shipped. Keeping the first would record a
    // model and prompt that never produced the sent message.
    if (!isSideCall) {
      capturedAwayCtx = {
        engine: result.target?.engine ?? AWAY_PRIMARY_TARGET.engine,
        model: result.target?.model ?? AWAY_PRIMARY_TARGET.model,
        processing_time_ms: Date.now() - startedAtMs,
        system_prompt: req.system,
        system_prompt_length: req.system.length,
        conversation_history: req.messages.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
          content: m.content,
        })),
        conversation_history_count: req.messages.length,
        channel_instruction_source: 'fly-bot',
        // §14.1 — always [], honestly: the away branch never requests recall
        // (see awaySanctumCall above), so there is never anything to report.
        memory_nodes: [],
      };
    }
    return result;
  };

  // Fire-and-forget: a failure here must never disturb the gateway. handleAwayInquiry
  // never throws in practice, but guard anyway.
  handleAwayInquiry(event, {
    getCached: () => presenceConfig.getCached(),
    fetchAwayStatus: () => fetchAwayStatus(SOLANCE_API_URL, SOLANCE_TOKEN, settingsStore),
    generate: generateWithCapture,
    withTyping: (channelId, fn, messageId) => discordClient.withTypingIn(
      channelId,
      fn,
      () => !discordClient.guestSpeechHeld() && !(messageId && speakerLock.isClaimed(messageId)),
    ),
    registerCheck,
    // Text-only by construction (Task 5, §8.1) — this deps.sendMessage never
    // takes a sticker arg, so the away-reply path attaches none today. Left
    // that way deliberately: Task 5 only extends the sticker anti-repeat
    // filter to paths that already send stickers; away sends none to filter.
    sendMessage: (channelId, text, replyToMessageId) => {
      // Went offline while the reply was being written: post nothing, and
      // tell the owner instead (handleAwayInquiry skips its own DM on a null send).
      if (discordClient.guestSpeechHeld()) {
        logger.info('Away', 'away reply dropped — went offline while it was being written', { channelId });
        sendOfflineHeadsUp();
        return Promise.resolve(null);
      }
      // Single-speaker lock (§0.A) — claim BEFORE sending; a message already
      // claimed by another speaker path (soft-presence) is skipped, never
      // double-replied. Routing (Task 2 Step 2) already makes away and
      // soft-presence mutually exclusive per message, so this is
      // defense-in-depth against a race, not the primary guard.
      if (replyToMessageId && !speakerLock.tryClaimSpeaker(replyToMessageId)) {
        logger.info('Away', 'send skipped — message already claimed by another speaker path', { messageId: replyToMessageId });
        return Promise.resolve(null);
      }
      return discordClient.sendMessage(channelId, text, undefined, replyToMessageId).then((sent) => {
        // Context Log capture — the away branch now only ever sends generated
        // text (the fixed fallback line is gone), so every sent reply has a ctx.
        if (sent && capturedAwayCtx) {
          generationContext.register(sent.id, capturedAwayCtx);
        }
        if (!sent && replyToMessageId) {
          // Send failed after claiming (codex P1, 2026-07-12 escalation) —
          // release so the message isn't blackholed for the lock TTL.
          logger.info('Away', 'send failed — releasing speaker claim', { messageId: replyToMessageId });
          speakerLock.releaseClaim(replyToMessageId);
        }
        return sent;
      });
    },
    sendDM: (userId, text) => discordClient.sendDM(userId, text),
    ownerUserId: OWNER_USER_ID,
    hosGuildId: HOS_SERVER_ID,
    awayRule: (guildId) => discordClient.serverOf(guildId).rules.away,
    tryClaimCooldown: tryClaimAwayCooldown,
    releaseCooldown: releaseAwayCooldown,
    noticeTracker: awayNoticeTracker,
    log: (msg, meta) => logger.info('Away', msg, meta),
  }).catch((err: any) => logger.error('Away', 'away-inquiry handler failed', { error: err?.message }));
});

// --- Soft-presence handler (Plan 2b Task 4, §8.2 — a name-drop wakes the judge
// in real time via the SAME considerChannel the ambient sweep uses) ---

// Judge-execution debounce (§0.D) — a burst of soft-mentions in one channel
// runs the real-time judge AT MOST once per ~60s; the engine's own
// speak-cooldown/rate gate still governs actual POSTING separately, so a
// first "no" doesn't lock a lively thread for the full window.
const softJudgeDebounce = createJudgeDebounce();

discordClient.on('soft-presence', (event: SoftPresenceEvent) => {
  handleSoftPresence(event, {
    stepFor: (channelId, channelName) =>
      discordClient.channelRules(discordClient.guildIdOfChannelCached(channelId), channelId, channelName, presenceConfig.getCached()).step,
    tryClaimJudgeDebounce: softJudgeDebounce.tryClaim,
    considerChannel: (channelId, channelName, opts) => discordClient.considerChannel(channelId, channelName, opts),
    isOwner: (authorId) => discordClient.isOwner(authorId),
    log: (msg, meta) => logger.info('Presence', msg, meta),
  }).catch((err: any) => logger.error('Presence', 'soft-presence handler failed', { error: err?.message }));
});

// --- Mention Handler ---

discordClient.on('mention', async (event: MentionEvent) => {
  logger.info('Cloud', `📨 Mention from ${event.authorTag} in ${event.channelName}`);

  if (discordClient.isOwner(event.authorId)) {
    if (!presenceEngine) {
      logger.info('Cloud', `${identity.owner_name} mentioned — auto-response disabled`);
      await reportMentionFailure(event, 'presence_engine_unavailable');
      return;
    }

    try {
      const recentMessages = await discordClient.getRecentMessages(event.channelId, 15);
      const botUserId = event.message.client.user?.id || null;
      presenceEngine?.setSelfId(botUserId);
      let window: WindowMessage[] = recentMessages.map((msg) => ({
        id: msg.id,
        authorId: msg.author.id,
        authorName: msg.member?.displayName || msg.author.globalName || msg.author.username || msg.author.tag,
        authorUsername: msg.author.username,
        content: msg.content || '',
        mentionedUsers: mentionedUsersOf(msg),
        isFromOwner: discordClient.isOwner(msg.author.id),
        isFromMe: botUserId ? msg.author.id === botUserId : false,
        timestampMs: msg.createdTimestamp,
        replyToId: replyParentId(msg),
        attachments: imageEgressAllowed(msg.guildId, msg.channelId)
          ? toMessageAttachments(msg.attachments)
          : undefined,
        reactions: buildReactions(msg, { isOwner: (id) => discordClient.isOwner(id), botId: botUserId, ignored: presenceConfig.getCached().ignored_user_ids }),
      }));
      // A Discord REST window can race the gateway event. Merge the exact
      // mention BEFORE generation if needed, then log this same ordered array.
      if (!window.some((m) => m.id === event.message.id)) {
        window.push({
          id: event.message.id,
          authorId: event.authorId,
          authorName: event.message.member?.displayName || event.message.author.globalName || event.message.author.username || event.authorTag,
          authorUsername: event.message.author.username,
          content: event.content || '',
          mentionedUsers: mentionedUsersOf(event.message),
          isFromOwner: true,
          isFromMe: false,
          timestampMs: event.timestamp.getTime(),
          replyToId: replyParentId(event.message),
          attachments: imageEgressAllowed(event.message?.guildId, event.channelId)
            ? toMessageAttachments(event.message?.attachments)
            : undefined,
        });
        window.sort((a, b) => a.timestampMs - b.timestampMs);
      }
      // Ignore list (Owner, 2026-08-29) — this fires for the owner's own mentions,
      // but an ignored author's messages can still be sitting in HER window
      // (they were talking in the same channel). Stripped BEFORE
      // fillReplyAuthorNames — ORDER IS LOAD-BEARING (see stripIgnoredMessages'
      // doc comment in presence-engine.ts): reversed, a reply to an ignored
      // author's message would resolve and leak their name through the reply
      // marker before the strip ever ran. `presenceConfig.getCached()` is
      // sync/free (no network — the poller owns fetches), same pattern this
      // module already uses elsewhere on hot paths.
      window = stripIgnoredMessages(window, presenceConfig.getCached().ignored_user_ids);
      fillReplyAuthorNames(window);
      const memoryContext = await memory.getMemoryContext();
      const stickerRoster = await discordClient.stickersFor(event.message?.guildId ?? null, presenceConfig.getCached());
      // channelId passed through (Task 5, §8.1) so respond()'s sticker
      // anti-repeat filter can check the shared StickerHistory. triggerText
      // (§14 P2 fix, Codex review 2026-07-13) = the actual mention event's
      // own content, not "latest in window" — same fix as the ambient-
      // mention path in discord-client.ts.
      // Typing while the answer is written — the owner's mention is always answered. Typing stays off once
      // another path (the scene catch) has claimed this message, so it never shows for a reply that will not come.
      const engineNow = presenceEngine;
      const reply = await discordClient.withTypingIn(event.channelId, () => engineNow.respond(event.channelName, window, memoryContext, true, stickerRoster, event.channelId, event.content, recallPlaceFor(event.message?.guildId ?? null)), () => !speakerLock.isClaimed(event.message.id));

      let reactionLanded = false;
      if (reply.react || reply.text) {
        // One answer per message (§0.A). During a scene the catch also answers
        // The owner's message and claims this same lock, so whichever lands first
        // is the only reply she gets — never the catch AND a normal answer. The claim
        // comes BEFORE any output (reaction included) so the loser emits nothing.
        if (!speakerLock.tryClaimSpeaker(event.message.id)) {
          logger.info('Cloud', `${identity.owner_name} mention reply skipped — another path (scene catch) already answered this message`, { messageId: event.message.id });
          return;
        }
        if (reply.react) {
          // Reactions in the room: a reaction on the owner's own message; posts nothing, so never copied.
          const reacted = await discordClient.reactTo(event.channelId, { id: event.message.id, authorId: event.authorId }, reply.react, presenceEngine);
          reactionLanded = reacted;
          if (!reacted && !reply.text) speakerLock.releaseClaim(event.message.id);
        }
      }
      if (reply.text) {
        let sent = await discordClient.sendMessage(
          event.channelId,
          reply.text,
          undefined,
          event.message.id,
          reply.stickerId ? [reply.stickerId] : undefined,
        );
        // Sticker was only actually attached on THIS attempt — record before
        // a possible text-only retry clobbers `sent` (Task 5, §8.1).
        if (sent && reply.stickerId) discordClient.getStickerHistory().record(event.channelId, reply.stickerId);
        if (!sent && reply.stickerId) {
          // Sticker send failed — retry text-only so the reply still lands.
          logger.info('Cloud', 'mention reply sticker send failed — retrying text-only', { stickerId: reply.stickerId });
          sent = await discordClient.sendMessage(event.channelId, reply.text, undefined, event.message.id);
        }
        // Context Log capture (Owner, 2026-07-13) — register against whichever
        // send actually landed (sticker attempt or text-only retry).
        if (sent && reply.ctx) generationContext.register(sent.id, reply.ctx);
        if (!sent) speakerLock.releaseClaim(event.message.id);
        logger.info('Cloud', `✅ Replied to ${identity.owner_name} mention via Sanctum`);
      } else if (mentionReplyOutcome({ text: reply.text, reactionLanded }) === 'reaction') {
        // A reaction-only answer is a success: nothing to post, nothing to alert about.
        logger.info('Cloud', `${identity.owner_name} mention answered with a reaction only`);
      } else {
        logger.info('Cloud', `${identity.owner_name} mentioned — Sanctum returned empty reply`);
        // Total provider exhaustion has already emitted the deterministic
        // model-chain alert. Do not duplicate it with a generic failure card.
        if (!reply.modelChainExhausted) {
          await reportMentionFailure(event, 'sanctum_empty_reply');
        }
      }
    } catch (err: any) {
      logger.error('Cloud', `${identity.owner_name} mention reply failed`, { error: err?.message });
      await reportMentionFailure(event, 'sanctum_exception');
    }
  } else {
    // Someone else mentioned the bot — DM the owner
    logger.info('Cloud', `📩 Non-owner mention from ${event.authorTag} — notifying ${identity.owner_name}`);

    const location = event.guildName
      ? `#${event.channelName} in ${event.guildName}`
      : 'a DM';

    const guildId = event.message.guild?.id || '@me';
    const messageLink = `https://discord.com/channels/${guildId}/${event.channelId}/${event.message.id}`;

    const notification = `**${identityVars().Bot} mentioned**\n\n` +
      `**By:** ${event.authorTag}\n` +
      `**Where:** ${location}\n` +
      `**When:** ${event.timestamp.toISOString()}\n` +
      `**Message:** "${event.content}"\n\n` +
      `**[Jump to message](${messageLink})**`;

    await discordClient.sendDM(OWNER_USER_ID, notification);
    logger.info('Cloud', `✅ ${identity.owner_name} notified via DM`);
  }
});

// --- DM Handler ---

discordClient.on('dm', async (event: MentionEvent) => {
  logger.info('Cloud', `💬 DM from ${event.authorTag}`);

  // Extract forwarded message content
  let fullContent = event.content;
  if (event.message.messageSnapshots && event.message.messageSnapshots.size > 0) {
    const forwardedParts = Array.from(event.message.messageSnapshots.values()).map((snapshot: any) => {
      const fwdContent = snapshot.message?.content ?? snapshot.content;
      const fwdAttachments = snapshot.message?.attachments ?? snapshot.attachments;

      let fwdText = '[Forwarded Message]';
      if (fwdContent) fwdText += `\n${fwdContent}`;
      if (fwdAttachments && fwdAttachments.size > 0) {
        const attachList = Array.from(fwdAttachments.values()).map((att: any) => att.url).join('\n');
        fwdText += `\n[Attachments: ${attachList}]`;
      }
      return fwdText;
    });
    fullContent = fullContent ? `${fullContent}\n\n${forwardedParts.join('\n')}` : forwardedParts.join('\n');
  }

  await memory.addMessage(event.channelId, {
    role: 'user',
    content: fullContent,
    timestamp: event.timestamp.toISOString(),
    author: event.authorTag,
    userId: event.authorId,
  });

  // Forward attachments along with notification
  const dmAttachments = event.message?.attachments;
  let attachmentInfo = '';
  const forwardedFiles: Array<{ file: string; name?: string }> = [];

  if (dmAttachments && dmAttachments.size > 0) {
    const attList = Array.from(dmAttachments.values()).map(att => {
      forwardedFiles.push({ file: att.url, name: att.name || undefined });
      return `- ${att.name} (${att.contentType || 'unknown'})`;
    });
    attachmentInfo = `\n**Attachments:** ${dmAttachments.size} file(s) (forwarded below)\n${attList.join('\n')}\n`;
  }

  const notification = `**New DM received**\n\n` +
    `**From:** ${event.authorTag}\n` +
    `**User ID:** ${event.authorId}\n` +
    `**Channel ID:** ${event.channelId}\n` +
    `**When:** ${event.timestamp.toISOString()}\n` +
    `**Message:** "${fullContent}"` +
    `${attachmentInfo}\n\n` +
    `Use \`discord_get_dm_channel\` with the user ID to read the full conversation.`;

  await discordClient.sendDM(
    OWNER_USER_ID,
    notification,
    forwardedFiles.length > 0 ? forwardedFiles : undefined
  );
  logger.info('Cloud', `✅ DM stored and ${identity.owner_name} notified${forwardedFiles.length > 0 ? ` (${forwardedFiles.length} attachment(s) forwarded)` : ''}`);
});

// --- Presence Handler ---

discordClient.on('ownerPresenceChange', (isOnline: boolean) => {
  logger.info('Cloud', `🔄 ${identity.owner_name} is now ${isOnline ? 'online' : 'offline'}`);
});

// --- Graceful Shutdown ---

// Bounded wait for the shutdown-time flush — flushAll() already resolves
// once every in-flight /ingest/discord call has settled, but this is a hard
// backstop so a hung flush can never wedge process.exit().
//
// root-cause fix (peer review, 2026-07-13) — this MUST be derived from the
// real worst-case drain time, not a hand-picked number: a single stale
// constant here is exactly what went wrong the first time (12s was correct
// back when flushChannel() sent one HTTP call per channel, and silently
// stopped being correct the moment the MAX_FLUSH_BATCH chunking fix landed,
// with nothing forcing this number to be re-derived alongside it).
// flushChannel() sends a channel's buffer as ceil(bufferLen / MAX_FLUSH_
// BATCH) SEQUENTIAL chunks, each with its own independent INGEST_HTTP_
// TIMEOUT_MS-capped call — so the worst case for the single slowest channel
// (buffer at its MAX_CHANNEL_BUFFER cap) is that many timeouts back-to-back.
// A margin on top absorbs scheduling/JSON-parse overhead between chunks.
const MAX_CHUNKS_PER_CHANNEL = Math.ceil(MAX_CHANNEL_BUFFER / MAX_FLUSH_BATCH); // 200 / 100 = 2
// flushAll() is a MULTI-PASS drain, and per-channel flushes are serialized
// (inFlightByChannel): a channel can enter shutdown with a flush ALREADY in
// flight (up to MAX_CHUNKS_PER_CHANNEL chunks) *plus* a second full buffer
// that accumulated behind it while that flight was in progress (bufferRow
// keeps filling to MAX_CHANNEL_BUFFER during an in-flight flush). So the true
// worst case is TWO passes of MAX_CHUNKS_PER_CHANNEL sequential chunks, not
// one — budgeting for one truncated the final chunk at process.exit(), which
// is exactly the loss the multi-pass drain exists to prevent (codex
// escalation finding, 2026-07-13).
const SHUTDOWN_DRAIN_PASSES = 2; // in-flight pass + the buffer that filled behind it
const SHUTDOWN_FLUSH_TIMEOUT_MARGIN_MS = 5_000;
const SHUTDOWN_FLUSH_TIMEOUT_MS =
  SHUTDOWN_DRAIN_PASSES * MAX_CHUNKS_PER_CHANNEL * INGEST_HTTP_TIMEOUT_MS +
  SHUTDOWN_FLUSH_TIMEOUT_MARGIN_MS; // 2 * 2 * 10s + 5s = 45s

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), ms);
    promise.then(
      () => { clearTimeout(timer); resolve(); },
      () => { clearTimeout(timer); resolve(); }
    );
  });
}

let stopAuditCopy: () => void = () => {};

async function shutdown(signal: string) {
  logger.info('Cloud', `Received ${signal}, shutting down...`);
  stopAuditCopy();
  discordClient.stopAmbientHeartbeat();
  // close() BEFORE flushAll() (checker P2) — stop accepting new messages
  // FIRST, so a message arriving while flushAll() is still awaiting an
  // in-flight /ingest/discord call can't spin up a fresh buffer that this
  // flushAll() call never sees and which would then be silently dropped
  // the instant process.exit() runs moments later.
  contextCollector.close();
  // flushAll() BEFORE stop() — AWAIT the in-flight /ingest/discord call(s)
  // (bounded) before stop()/exit(), so a deploy/restart/crash can't cut a
  // flush off mid-request and silently drop buffered House context.
  await withTimeout(contextCollector.flushAll(), SHUTDOWN_FLUSH_TIMEOUT_MS);
  contextCollector.stop();
  logger.stopHeartbeat();
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('uncaughtException', (err) => {
  logger.fatal('Cloud', 'Uncaught exception', { error: err.message, stack: err.stack });
  discordClient.stopAmbientHeartbeat();
  // close() before flushAll() — same ordering law as shutdown() above.
  contextCollector.close();
  withTimeout(contextCollector.flushAll(), SHUTDOWN_FLUSH_TIMEOUT_MS).then(() => {
    contextCollector.stop();
    logger.stopHeartbeat();
    process.exit(1);
  });
});

// --- Main Startup ---

async function main() {
  logger.info('Cloud', `🚀 Starting ${identityVars().Bot} Cloud Server...`);
  logger.startHeartbeat();

  // Initialize memory
  await memory.initialize();

  // Sanctum owns the canonical Identity Core + Marrow for Discord completion.
  // Do not load the optional local persona here: a missing gitignored file used
  // to silently turn the production bot into a generic "helpful assistant".
  // The public build (direct model plug) reads its persona from the persona socket on every prompt,
  // so an edit on the page, a changed file or a refreshed core service takes effect without a restart.
  // The House keeps '' (Sanctum supplies the identity), byte for byte.
  const personaProvider = seams.personaProvider;
  const persona: string | (() => Promise<string>) = personaProvider ? async () => (await personaProvider.get()).text : '';
  presenceEngine = MODEL_READY
    ? new PresenceEngine(SANCTUM_URL, SANCTUM_KEY, persona, undefined, undefined, PRESENCE_FALLBACK_TARGETS, undefined, presenceConfig, PRESENCE_PRIMARY_TARGET)
    : null;
  if (presenceEngine && seams.plugs.model !== 'sanctum') presenceEngine.setModelProvider(modelProvider);
  if (presenceEngine && PRESENCE_VISION_TARGETS) presenceEngine.setVisionTargets(PRESENCE_VISION_TARGETS);
  if (presenceEngine) presenceEngine.setSuccession(modelSuccession);
  const modelChainAlertReporter = new ModelChainAlertReporter({
    channelId: PRESENCE_ERROR_CHANNEL_ID,
    sendMessage: (channelId, content) => discordClient.sendMessage(channelId, content),
  });
  presenceEngine?.setModelChainExhaustedHandler(async (event) => {
    const result = await modelChainAlertReporter.report(event);
    if (result === 'sent') {
      logger.info('Cloud', '✅ Model-chain exhaustion alert posted', { channelId: PRESENCE_ERROR_CHANNEL_ID });
    } else if (result === 'suppressed') {
      logger.info('Cloud', 'Model-chain exhaustion alert suppressed by cooldown', { channelId: PRESENCE_ERROR_CHANNEL_ID });
    } else {
      logger.error('Cloud', 'Model-chain exhaustion alert was not posted', { channelId: PRESENCE_ERROR_CHANNEL_ID });
    }
  });
  // Shared sticker anti-repeat memory (Task 5, §8.1) — inject the SAME
  // StickerHistory instance discordClient owns (and the curfew reflex writes
  // to) into the engine, so the ambient/reply paths and curfew never drift
  // onto separate registries.
  presenceEngine?.setStickerHistory(discordClient.getStickerHistory());

  // Context-Log collector (Phase 3, §9) — start the ~60s flush sweep.
  contextCollector.start();
  logger.info('Cloud', '📝 Context-Log collector started');

  // Connect to Discord
  logger.info('Cloud', '🔌 Connecting to Discord...');
  await discordClient.login(DISCORD_TOKEN);

  // Audit log copy (audit-log-copy.ts): home server only; off at audit_copy_hours 0 or without Sanctum.
  if (houseConfig.audit_copy_hours > 0 && houseConfig.hosServerId && SANCTUM_URL && SANCTUM_KEY) {
    const guildId = houseConfig.hosServerId;
    stopAuditCopy = startAuditCopy({
      hours: houseConfig.audit_copy_hours,
      guildId,
      sanctumUrl: SANCTUM_URL,
      sanctumKey: SANCTUM_KEY,
      fetchPage: (after) => discordClient.fetchAuditLogPage(guildId, after),
      names: () => discordClient.guildNameMaps(guildId),
      isReady: () => discordClient.isReady,
      log: (message, data) => logger.info('AuditCopy', message, data),
      dmOwner: (text) => discordClient.sendDM(OWNER_USER_ID, text),
    });
    logger.info('Cloud', `Audit log copy ON: first run in 2 min, then every ${houseConfig.audit_copy_hours} h`);
  }

  if (PRESENCE_ENABLED && presenceEngine) {
    discordClient.startAmbientHeartbeat(presenceEngine, memory, PRESENCE_HEARTBEAT_INTERVAL_MS);
    logger.info('Cloud', 'Presence heartbeat ENABLED', {
      sanctumUrl: SANCTUM_URL,
      intervalMs: PRESENCE_HEARTBEAT_INTERVAL_MS,
    });
  } else if (PRESENCE_ENABLED) {
    logger.error('Cloud', 'Presence heartbeat DORMANT: PRESENCE_ENABLED=true but no model is configured (SANCTUM_KEY missing)');
  } else {
    logger.info('Cloud', 'Presence heartbeat DORMANT: set PRESENCE_ENABLED=true to enable');
  }

  // Start HTTP API
  logger.info('Cloud', '🌐 Starting HTTP API...');
  createHttpServer(discordClient, memory, BOT_API_SECRET, BOT_API_PORT, {
    settingsStore: seams.settingsStore,
    plugs: seams.plugs,
    memory: () => seams.memoryProvider,
    persona: seams.personaProvider ?? undefined,
    houseLabels: houseConfig.labels,
    listServers: () => discordClient.listServers(),
    listChannels: (serverId) => discordClient.listServerChannels(serverId),
  });

  logger.info('Cloud', `✅ ${identityVars().Bot} Cloud Server running`);
  logger.info('Cloud', `HTTP API: http://0.0.0.0:${BOT_API_PORT}`);
  logger.info('Cloud', `Owner user ID: ${OWNER_USER_ID}`);
  logger.info('Cloud', `Auto-responding to ${identity.owner_name}'s mentions`);
  logger.info('Cloud', `Other mentions notify ${identity.owner_name} via DM`);
}

main().catch((error) => {
  logger.fatal('Cloud', 'Fatal error during startup', { error: error.message, stack: error.stack });
  process.exit(1);
});
