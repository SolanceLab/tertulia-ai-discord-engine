// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * context-collector.ts — Phase 3, §9/§9.1: Discord → cloud memory (Context Log).
 * -----------------------------------------------------------------------------
 * The owner's four ANSWERED sub-decisions (§9, 2026-07-12 23:59) are LAW here, with
 * §1 corrected by her explicit 2026-07-18 ruling:
 *  1. Scope: every message sent by the the bot bot, on every Discord surface.
 *     Human/guest messages are not independent rows; the generation path
 *     carries them inside each bot reply's audit context. `house_channels`
 *     remains as the legacy live dial name for compatibility.
 *  2. Privacy: store RAW content, tagged `access: in_house` (the tag is
 *     applied server-side by Sanctum's /ingest/discord — this module ships
 *     the raw content only).
 *  3. Volume: every bot reply is flushed eagerly so the operator log is
 *     current. The 50-message/10-minute batch thresholds remain as safety
 *     drains for non-eager/internal callers.
 *  4. EMBEDDING COST LAW: this module calls /ingest/discord and NOTHING
 *     ELSE. No embedding, no Vectorize, no other endpoint, ever — that is
 *     the caller's (cloud-server.ts) `flush` dependency, and it must never
 *     be pointed anywhere but /ingest/discord.
 *
 * Hot-path law (§0.C, generalized from Plan 2b): observe() is SYNCHRONOUS and
 * NEVER awaits — every dependency it reads (getConfig, involvesBot) is a sync
 * call; the async flush triggered from
 * observe()/bufferRow()/sweep() is NOT awaited there, so a slow/failed
 * Sanctum call can never stall the messageCreate handler that calls
 * observe(). flushChannel() DOES return the flush promise, though — that's
 * what lets flushAll() (called only at shutdown, never on the hot path)
 * await every in-flight flush before the process exits, so a restart/crash
 * doesn't race an in-flight /ingest/discord call and silently drop it.
 *
 * Drop-on-failure, no-retry-storm: a batch is removed from the buffer the
 * instant it's handed to flush() — if flush() rejects, the batch is simply
 * gone (logged once). A lost batch of House chatter is an acceptable loss;
 * a retry storm against Sanctum on an outage is not.
 *
 * Fully dependency-injected (mirrors curfew-watch.ts / soft-presence.ts) —
 * no Discord, no network, no real clock unless the caller wires one.
 */
import { logger as defaultLogger } from './logger.js';
import type { GenerationContext } from './generation-context.js';

/** The subset of live config the collector reads. */
export interface ContextLogConfig {
  context_log: string; // 'off' | 'mentions_only' | 'house_channels' | 'all'
}

/** A raw Discord message, as mapped by the caller (discord-client.ts) from
 * discord.js's Message. `involvesBot`, when supplied by the caller, is used
 * as-is; otherwise deps.involvesBot(msg) decides. */
export interface ObserveMessage {
  messageId: string;
  channelId: string;
  channelName: string;
  guildId: string | null;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string; // ISO 8601
  isBot: boolean;
  involvesBot?: boolean;
  /** Discord id of the message this one replies to, when it is a reply. */
  replyTo?: string | null;
}

/** One row in the batch handed to Sanctum POST /ingest/discord. */
export interface IngestMessage {
  message_id: string;
  channel_id: string;
  channel_name: string;
  author_id: string;
  author_name: string;
  content: string;
  timestamp: string;
  is_bot: boolean;
  // Where it was said (Owner, 2026-10-01) — the real guild, or null for a DM. Sanctum stores it as
  // server_id; before this every row was stamped with the HoS guild, even Harborlight and The Snug.
  guild_id: string | null;
  // The message this one answers (a Discord id). Present only for a reply. Sanctum's route never
  // receives it (cloud-server strips it); the public sinks write it as `reply_to`.
  reply_to?: string;
  // Context Log capture (Owner, 2026-07-13, FORWARD ONLY) — what produced this
  // message (engine/model/timing/system prompt/conversation window), attached
  // at FLUSH time via deps.takeContextLog(message_id). Omitted entirely when
  // there is none (a guest-sent message, a fixed fallback line, an MCP-sent
  // message, or a row whose ctx already expired/was taken) — NEVER null.
  context_log?: GenerationContext;
}

export interface ContextCollectorDeps {
  getConfig: () => ContextLogConfig;
  /**
   * Per-server override of the dial (specs/2026-10-15-discord-servers-section.md): the level that
   * applies to rows from this guild, or null/undefined to use the global one. Optional.
   */
  getServerContextLog?: (guildId: string) => string | null | undefined;
  involvesBot: (msg: ObserveMessage) => boolean;
  /** POST to Sanctum /ingest/discord ONLY — the embedding cost law (the owner).
   * Resolves with the parsed `{inserted, skipped}` response when the caller
   * has one to report (panel P0: the systematic-failure alarm needs it to
   * catch a flush that "succeeds" HTTP-wise but silently inserts nothing),
   * or void when there's no response to give (e.g. Sanctum key missing).
   * Rejects on any hard failure (non-2xx, network error, timeout, OR a 2xx
   * with a malformed/missing-fields body — root-cause fix 2026-07-13: a
   * broken-but-2xx body must never resolve to the same `void` sentinel as
   * "nothing to report", or it silently bypasses both the alarm and the
   * ordinary flush-failure log while the batch is still dropped). */
  flush: (batch: IngestMessage[]) => Promise<{ inserted: number; skipped: number } | void>;
  /** Context Log capture (Owner, 2026-07-13) — reads-and-deletes the
   * GenerationContext registered for a sent message id (typically
   * `GenerationContextRegistry.take`). Optional so this module stays testable
   * without one wired — omitted or returning undefined means every row flushes
   * exactly as before (no context_log key at all, never null/garbage). Called
   * ONLY at flush time, per row, so a row that's never flushed (buffer-cap
   * drop, dial off, or shutdown) simply never consumes its registered ctx
   * — it just ages out of the registry's own TTL/capacity bounds instead. */
  takeContextLog?: (messageId: string) => GenerationContext | undefined;
  /** Subscribe to registrations that may land after the grace window. */
  subscribeContextLog?: (listener: (messageId: string) => void) => () => void;
  /**
   * Send/flush race fix (Codex review, 2026-07-13): the SEND site registers
   * a generation ctx only AFTER its sendMessage() promise resolves (by an
   * HTTP response from Discord's REST API). But the bot's OWN gateway
   * MESSAGE_CREATE event for that same message arrives over a SEPARATE
   * WebSocket connection, and there is no guaranteed ordering between "the
   * REST response landed" and "the gateway event was processed" — the
   * gateway event can win, reach observe() -> bufferRow(), hit the 50-msg
   * threshold, and trigger THIS flush before generationContext.register()
   * for that very row has run. Rather than chase that race at every send
   * call site (fragile — any future send path would need to remember the
   * same trick), flushChannel() re-checks once: if a bot-authored row in
   * the batch has no context after the first takeContextLog() pass, wait a
   * short grace window and take() again for just that row before finalizing
   * the batch. Defaults to a real timer; tests inject a controllable one.
   * Never applied to human-authored rows (they never carry a registered
   * ctx), so a channel with no bot-authored rows in the batch never pays
   * this cost.
   */
  graceDelay?: (ms: number) => Promise<void>;
  now?: () => number;
  /** `level` defaults to 'info'; pass 'error' for conditions that warrant
   * escalated visibility (panel P0 systematic-failure alarm, buffer-cap
   * drops, an unrecognized dial value). */
  log?: (msg: string, meta?: Record<string, unknown>, level?: 'info' | 'error') => void;
}

interface ChannelBuffer {
  messages: IngestMessage[];
  // Real (or injected-clock) ms at which the FIRST message currently in this
  // buffer arrived — the 10-minute flush timer is keyed off this, not per
  // message, so a channel that trickles one message every few minutes still
  // flushes on schedule instead of never hitting the 50-message cap.
  oldestBufferedAtMs: number;
}

const MAX_BATCH = 50;
const FLUSH_AGE_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_CONTENT_LEN = 4000;
// root-cause fix (2026-07-13 re-review) — Sanctum's /ingest/discord accepts
// at most 100 messages per call (cloud-server.ts, contextIngestFlush's
// contract comment). Under normal load the 50-msg MAX_BATCH trigger never
// approaches this — but when a channel's flush is already in-flight,
// bufferRow() keeps accumulating into a FRESH buffer (every threshold
// trigger during that window is a guarded no-op — see flushChannel), and
// that fresh buffer can grow well past 100 before the next flush actually
// fires (bounded only by MAX_CHANNEL_BUFFER below, which is intentionally
// looser than the API limit so a burst doesn't lose messages it doesn't
// have to). flushChannel() therefore ALWAYS splits its outgoing batch into
// pieces of at most MAX_FLUSH_BATCH before calling deps.flush() — sent
// sequentially, never as one oversized call — so the API limit can never be
// violated regardless of how large a stalled buffer grew. This is the fix
// for the reviewer's reproduction (batch sizes [50, 151]).
// Exported (not just module-internal) so cloud-server.ts can derive its
// shutdown-flush timeout from the SAME numbers that determine the actual
// worst-case drain time, instead of a hand-picked constant that silently
// goes stale the next time either of these changes (exactly what happened
// here: the shutdown timeout was set assuming one flush per channel, before
// this chunking fix existed, and nothing re-derived it when the chunking
// was added).
export const MAX_FLUSH_BATCH = 100;
// checker P2 — caps parallel in-flight /ingest/discord HTTP calls under a
// burst; further flush triggers back off and let the next sweep retry.
const MAX_CONCURRENT_FLUSHES = 3;
// Send/flush race fix (Codex review, 2026-07-13) — how long flushChannel()
// waits, ONCE, for a late generationContext.register() to land before
// finalizing a batch that has a bot-authored row still missing its context.
// Chosen to comfortably cover the REST-response-vs-gateway-event ordering
// gap (register() is a synchronous, no-I/O call made the instant the send
// site's own await resolves) without meaningfully delaying a flush that
// doesn't need it — this constant is only ever consulted when at least one
// bot row in the batch is still missing context after the first pass.
const CONTEXT_LOG_GRACE_MS = 300;
// panel P0 — buffer bounds. A single noisy channel can never grow past
// MAX_CHANNEL_BUFFER; the whole collector can never grow past
// MAX_GLOBAL_BUFFERED. Beyond either, the oldest buffered message is
// dropped (never OOM, never silent — drops are counted and logged once per
// sweep tick).
export const MAX_CHANNEL_BUFFER = 200;
const MAX_GLOBAL_BUFFERED = 2000;
// panel P0 — the four valid dial positions the collector itself recognizes.
// getConfig() SHOULD already be sanitized by presence-config's parseConfig,
// but the collector fails closed on its own too (defense in depth): any
// value outside this set is treated as 'off', not as "keep" — the opposite
// of parseConfig's fallback-to-default-on-garbage law, deliberately, since
// an unrecognized value reaching this deep is itself the anomaly worth
// flagging loudly rather than quietly defaulting to "collect everything".
const VALID_CONTEXT_LOG_VALUES = new Set(['off', 'mentions_only', 'house_channels', 'this_server', 'all']);

export class ContextCollector {
  private buffers: Map<string, ChannelBuffer> = new Map();
  // Tracks every flush() promise that hasn't settled yet, independent of
  // `buffers` — flushChannel() deletes a channel's buffer entry BEFORE its
  // async flush() resolves (that's what makes a mid-flight failure a drop,
  // not a retry), so `buffers` alone can't tell flushAll() which flushes are
  // still in-flight from sweep()/the 50-message threshold. This set is the
  // source of truth for that instead: entries are added the instant
  // deps.flush() is called and removed the instant it settles, so flushAll()
  // can await it regardless of buffer-map state.
  private inFlight: Set<Promise<void>> = new Set();
  // checker P2 — channels with a flush currently in flight; a second
  // trigger for the SAME channel while one is running backs off instead of
  // firing an overlapping HTTP call (per-channel serialization).
  private inFlightByChannel: Set<string> = new Set();
  // Channels explicitly requested for eager delivery by the Discord own-
  // message path. The marker stays active while a flush is in flight so a
  // second reply arriving in that window is automatically flushed as soon
  // as the first request settles instead of waiting for the age sweep.
  private eagerChannels: Set<string> = new Set();
  // panel P0 — running count backing the global buffer bound; kept in sync
  // with every push/flush/drop instead of re-summing all buffers each time.
  private totalBuffered = 0;
  // panel P0 — buffer-cap drops since the last sweep tick; flushed to one
  // log line per sweep() call rather than spamming per dropped message.
  private droppedThisSweep = 0;
  // panel P0 — consecutive flushes that "succeeded" (HTTP-wise) but
  // reported inserted===0 for a non-empty batch; escalates the alarm log
  // at 3+ in a row, resets on any flush that reports inserted>0.
  private consecutiveZeroInsertFlushes = 0;
  // checker P2 — set by close(); makes observe() an immediate no-op. Set
  // FIRST in the shutdown sequence, before flushAll(), so messages arriving
  // mid-flush can't spin up a fresh buffer that flushAll() never sees.
  private closed = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly log: (msg: string, meta?: Record<string, unknown>, level?: 'info' | 'error') => void;
  private readonly graceDelay: (ms: number) => Promise<void>;
  private readonly unsubscribeContextLog?: () => void;
  private pendingBareBotRows: Map<string, { row: IngestMessage; expiresAtMs: number }> = new Map();

  constructor(private deps: ContextCollectorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((msg, meta, level) => {
      if (level === 'error') defaultLogger.error('ContextLog', msg, meta);
      else defaultLogger.info('ContextLog', msg, meta);
    });
    this.graceDelay = deps.graceDelay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.unsubscribeContextLog = deps.subscribeContextLog?.((messageId) => this.backfillLateContext(messageId));
  }

  private backfillLateContext(messageId: string): void {
    const pending = this.pendingBareBotRows.get(messageId);
    if (!pending || pending.expiresAtMs <= this.now() || !this.deps.takeContextLog) {
      if (pending) this.pendingBareBotRows.delete(messageId);
      return;
    }
    const contextLog = this.deps.takeContextLog(messageId);
    if (!contextLog) return;
    this.pendingBareBotRows.delete(messageId);
    const promise = this.deps.flush([{ ...pending.row, context_log: contextLog }])
      // The expected successful response is a duplicate/upsert (inserted=0),
      // so do not feed it into the new-insert failure-streak alarm.
      .then(() => undefined)
      .catch((err: any) => {
        this.log('late context backfill failed — receipt dropped', {
          channelId: pending.row.channel_id,
          messageId,
          error: err?.message,
        });
      });
    this.inFlight.add(promise);
    promise.finally(() => this.inFlight.delete(promise));
  }

  /**
   * Stop accepting new messages immediately — observe() becomes a no-op.
   * Call this FIRST in the shutdown sequence, BEFORE flushAll() (checker
   * P2): otherwise a message arriving while flushAll() is still awaiting
   * in-flight HTTP calls would spin up a brand-new buffer that flushAll()
   * already iterated past, and that buffer would then be silently
   * discarded the instant the process exits moments later. Idempotent, and
   * distinct from stop() — stop() only cancels the periodic sweep timer,
   * it does not stop observation on its own.
   */
  close(): void {
    this.closed = true;
    this.eagerChannels.clear();
  }

  /** Start the ~60s sweep that flushes any channel whose oldest buffered
   * message has aged past 10 minutes. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Never let this timer alone keep the process alive (Node-only guard;
    // harmless if unref is unavailable in the runtime).
    (this.sweepTimer as any).unref?.();
  }

  /** Stop the sweep. Does NOT flush — call flushAll() first if that's wanted
   * (the shutdown handler does both, in that order). */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.unsubscribeContextLog?.();
  }

  /**
   * A message landed in a house channel. Synchronous, NEVER awaits (hot-path
   * law). Applies every gate, then buffers. Never throws — a malformed
   * message or a thrown dependency degrades to "message dropped, logged
   * once," never a pipeline break.
   */
  observe(msg: ObserveMessage): void {
    // checker P2 — closed collector (shutdown in progress) drops every
    // message unconditionally, before touching any dependency.
    if (this.closed) return;
    try {
      const base = this.deps.getConfig();
      // Each row's own server decides its level; a DM (no guild) and an unset server use the global dial.
      const perServer = msg.guildId ? this.deps.getServerContextLog?.(msg.guildId) : null;
      const cfg = { ...base, context_log: perServer ?? base.context_log };
      if (cfg.context_log === 'off') return;

      // panel P0 — fail closed on an unrecognized dial value instead of
      // falling through to the "keep" branch below. This is deliberately
      // stricter than presence-config's parseConfig (which defaults garbage
      // to 'house_channels' at the config-parsing boundary) — this is a
      // second, independent gate at the point of use, so a future bug that
      // hands getConfig() something unsanitized can never silently widen
      // into "collect everything" instead of "collect nothing".
      if (!VALID_CONTEXT_LOG_VALUES.has(cfg.context_log)) {
        this.log('unrecognized context_log value — treating as off (fail closed)', { value: cfg.context_log }, 'error');
        return;
      }

      if (cfg.context_log === 'mentions_only') {
        const involves = msg.involvesBot ?? this.deps.involvesBot(msg);
        if (!involves) return;
      }
      // 'house_channels' | 'this_server' | 'all' keep past here — any other value has
      // already failed closed above. Both values intentionally cover every
      // Discord surface; `house_channels` is only a legacy config name.

      const content = (msg.content || '').slice(0, MAX_CONTENT_LEN);
      if (!content) return; // drop empty-content messages

      const row: IngestMessage = {
        message_id: msg.messageId,
        channel_id: msg.channelId,
        channel_name: msg.channelName,
        author_id: msg.authorId,
        author_name: msg.authorName,
        content,
        timestamp: msg.timestamp,
        is_bot: Boolean(msg.isBot),
        guild_id: msg.guildId ?? null,
        ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
      };

      this.bufferRow(msg.channelId, row);
    } catch (err: any) {
      this.log('observe failed — message dropped', { error: err?.message });
    }
  }

  /**
   * Request immediate delivery for one channel. This remains fire-and-forget
   * for the Discord hot path, while flushChannel() keeps the actual requests
   * serialized and bounded. If another message arrives while this channel is
   * already flushing, the eager marker re-drives its fresh buffer as soon as
   * the in-flight request settles.
   */
  flushNow(channelId: string): void {
    if (this.closed) return;
    const buf = this.buffers.get(channelId);
    if (!buf || buf.messages.length === 0) return;
    this.eagerChannels.add(channelId);
    this.flushChannel(channelId);
  }

  private bufferRow(channelId: string, row: IngestMessage): void {
    let buf = this.buffers.get(channelId);
    if (!buf) {
      buf = { messages: [], oldestBufferedAtMs: this.now() };
      this.buffers.set(channelId, buf);
    }
    buf.messages.push(row);
    this.totalBuffered++;

    // panel P0 — per-channel bound. A single noisy channel can never grow
    // its own buffer without limit; drop the oldest message in THAT
    // channel's buffer first.
    if (buf.messages.length > MAX_CHANNEL_BUFFER) {
      buf.messages.shift();
      this.totalBuffered--;
      this.droppedThisSweep++;
    }

    // panel P0 — global bound. Even after per-channel trimming, many
    // channels bursting at once could still add up past budget; trim the
    // single largest remaining buffer, repeatedly, until back under it.
    while (this.totalBuffered > MAX_GLOBAL_BUFFERED) {
      let largest: ChannelBuffer | null = null;
      for (const b of this.buffers.values()) {
        if (b.messages.length > 0 && (!largest || b.messages.length > largest.messages.length)) largest = b;
      }
      if (!largest) break; // nothing left to trim — totalBuffered's own bookkeeping is off, not a live buffer
      largest.messages.shift();
      this.totalBuffered--;
      this.droppedThisSweep++;
    }

    if (buf.messages.length >= MAX_BATCH) {
      this.flushChannel(channelId);
    }
  }

  /** The ~60s sweep body — public so it can also be driven directly (start()
   * wires it to setInterval for production; tests call it directly against
   * an injected clock instead of waiting on real timers). */
  sweep(): void {
    // panel P0 — buffer-cap drop counter, logged once per sweep tick rather
    // than once per dropped message (never OOM, never silent, never spam).
    if (this.droppedThisSweep > 0) {
      this.log(
        'buffer cap reached — oldest messages dropped',
        { droppedSinceLastSweep: this.droppedThisSweep, totalBuffered: this.totalBuffered },
        'error'
      );
      this.droppedThisSweep = 0;
    }

    const cutoff = this.now() - FLUSH_AGE_MS;
    for (const [channelId, buf] of this.buffers) {
      if (buf.oldestBufferedAtMs <= cutoff) {
        this.flushChannel(channelId);
      }
    }
  }

  /**
   * panel P0 — systematic-failure alarm bookkeeping for ONE deps.flush()
   * response. Extracted so it applies identically whether a channel's
   * buffer went out as a single call or was split into multiple
   * MAX_FLUSH_BATCH-sized chunks (flushChannel below) — the alarm has to
   * fire per actual HTTP call, since that's the granularity Sanctum itself
   * reports inserted/skipped at, not per logical "channel flush".
   */
  private recordFlushResult(
    result: { inserted: number; skipped: number } | void,
    chunkLength: number,
    channelId: string
  ): void {
    try {
      if (result && result.inserted === 0 && chunkLength > 0) {
        this.consecutiveZeroInsertFlushes++;
        const escalate = this.consecutiveZeroInsertFlushes >= 3;
        this.log(
          escalate
            ? `CONTEXT-LOG SYSTEMATIC FAILURE? ${this.consecutiveZeroInsertFlushes} consecutive zero-insert flushes — Sanctum ingest may be broken`
            : 'CONTEXT-LOG SYSTEMATIC FAILURE? flush reported inserted=0 for a non-empty batch',
          { channelId, count: chunkLength, skipped: result.skipped, consecutive: this.consecutiveZeroInsertFlushes },
          'error'
        );
      } else if (result) {
        this.consecutiveZeroInsertFlushes = 0;
      }
    } catch (err: any) {
      this.log('systematic-failure alarm check threw', { error: err?.message }, 'error');
    }
  }

  /**
   * Returns the flush promise so flushAll() can await it at shutdown.
   * Callers on the hot path (bufferRow(), sweep()) deliberately DON'T await
   * this return value — that's what keeps observe() synchronous per the
   * hot-path law. The promise itself always resolves (never rejects): a
   * failed chunk is caught, logged once, and treated as a completed drop —
   * a later chunk in the same batch still gets its own attempt.
   *
   * The returned promise is also registered in `inFlight` for the FULL
   * duration of every chunk's flush() call — added before the first
   * deps.flush() is invoked, removed only once the last chunk settles — so
   * flushAll() can find and await it even though the channel's buffer entry
   * is already gone by then.
   *
   * checker P2 — two concurrency guards, both no-ops that leave the buffer
   * untouched for the next sweep to retry (never an unbounded parallel HTTP
   * call under a burst):
   *  1. Per-channel serialization: if THIS channel already has a flush in
   *     flight, back off — never run two overlapping flushes for the same
   *     channel.
   *  2. Global cap: unless `force` is set, back off once MAX_CONCURRENT_
   *     FLUSHES flushes (across ALL channels) are already in flight.
   * `force` bypasses guard 2 only — it exists for flushAll() at shutdown,
   * where there is no future sweep left to retry a deferred channel, so the
   * final drain must push every remaining buffer through regardless of the
   * global cap. Guard 1 still applies even when forced — a channel with a
   * flush ALREADY in flight when flushAll() calls this is correctly a
   * no-op; flushAll() itself is what re-drives that channel in a later pass
   * once the earlier flush settles and frees the guard (see flushAll()).
   *
   * root-cause fix (2026-07-13) — the batch is split into MAX_FLUSH_BATCH
   * (100) pieces sent SEQUENTIALLY, never as one oversized call, so a
   * stalled buffer that grew past 100 while a prior flush blocked every
   * interim trigger can never violate Sanctum's documented per-call limit.
   *
   * Send/flush race fix (Codex review, 2026-07-13) — the buffer is captured
   * and removed from `this.buffers` HERE, synchronously, BEFORE any async
   * work (including the grace-wait below) so a message arriving during that
   * wait starts a brand-new buffer instead of being silently swept into (or
   * lost from) this batch. Context lookup then happens inside the async
   * body: a first synchronous takeContextLog() pass, and — only if a
   * bot-authored row came back with no context — one grace-delayed re-check
   * for exactly those rows before the batch is finalized and sent.
   */
  private flushChannel(channelId: string, force = false): Promise<void> {
    const buf = this.buffers.get(channelId);
    if (!buf || buf.messages.length === 0) return Promise.resolve();
    if (this.inFlightByChannel.has(channelId)) return Promise.resolve();
    if (!force && this.inFlight.size >= MAX_CONCURRENT_FLUSHES) return Promise.resolve();

    const messages = buf.messages;
    // Remove BEFORE any async work — this is what makes a failure a drop,
    // not a retry (nothing left to re-buffer even if deps.flush() rejects
    // moments later), and what lets a message arriving during the grace
    // wait below start a fresh buffer rather than vanish into this one.
    this.buffers.delete(channelId);
    this.totalBuffered -= messages.length;
    this.inFlightByChannel.add(channelId);

    const promise = (async () => {
      // Context Log capture (Owner, 2026-07-13) — attach context_log HERE, at
      // flush time, per row: deps.takeContextLog() reads-and-deletes
      // whatever was registered for that message id. Absent dep, or no ctx
      // registered for a given row (a human-authored message, a fixed
      // fallback line, an MCP-sent message, or a ctx already taken/expired)
      // → the row ships exactly as it always has, with NO context_log key
      // at all (never a null/undefined field on the wire).
      let batch: IngestMessage[] = messages;
      if (this.deps.takeContextLog) {
        const takeContextLog = this.deps.takeContextLog;
        const missingBotRowIds: string[] = [];
        batch = messages.map((row) => {
          const contextLog = takeContextLog(row.message_id);
          if (contextLog) return { ...row, context_log: contextLog };
          if (row.is_bot) missingBotRowIds.push(row.message_id);
          return row;
        });

        // Send/flush race fix — a bot-authored row with no context yet is
        // exactly the reviewer's repro (own gateway echo hit this flush
        // before the send site's register() call landed): wait once, then
        // re-check ONLY those rows. Human-authored rows never carry a
        // registered ctx, so a batch with no bot rows never pays this cost.
        if (missingBotRowIds.length > 0) {
          await this.graceDelay(CONTEXT_LOG_GRACE_MS);
          const stillMissing = new Set(missingBotRowIds);
          batch = batch.map((row) => {
            if (!stillMissing.has(row.message_id) || row.context_log) return row;
            const contextLog = takeContextLog(row.message_id);
            return contextLog ? { ...row, context_log: contextLog } : row;
          });
          // A slow Discord REST response can still lose the fixed grace race.
          // Retain only the unresolved bot rows briefly; a later registry
          // notification re-ingests the same id with its real receipt and
          // Sanctum's idempotent upsert fills the previously bare row.
          for (const row of batch) {
            if (!row.is_bot || row.context_log) continue;
            this.pendingBareBotRows.set(row.message_id, {
              row,
              expiresAtMs: this.now() + 15 * 60_000,
            });
            if (this.pendingBareBotRows.size > 200) {
              const oldest = this.pendingBareBotRows.keys().next().value;
              if (oldest !== undefined) this.pendingBareBotRows.delete(oldest);
            }
          }
        }
      }

      const chunks: IngestMessage[][] = [];
      for (let i = 0; i < batch.length; i += MAX_FLUSH_BATCH) {
        chunks.push(batch.slice(i, i + MAX_FLUSH_BATCH));
      }

      for (const chunk of chunks) {
        try {
          const result = await this.deps.flush(chunk);
          // panel P0 — systematic-failure alarm. A flush that "succeeds"
          // HTTP-wise but inserts nothing for a non-empty batch is a signal
          // something is silently broken downstream — categorically
          // different from a network failure (caught below) and worth
          // ERROR-level, distinct, escalating visibility.
          this.recordFlushResult(result, chunk.length, channelId);
        } catch (err: any) {
          this.log('flush failed — batch dropped', { channelId, count: chunk.length, error: err?.message });
        }
      }
    })();
    this.inFlight.add(promise);
    promise.finally(() => {
      this.inFlight.delete(promise);
      this.inFlightByChannel.delete(channelId);
      this.redriveEagerBuffers();
    });
    return promise;
  }

  /** Re-attempt eager buffers after any request frees a channel/global slot. */
  private redriveEagerBuffers(): void {
    if (this.closed) return;
    for (const channelId of Array.from(this.eagerChannels)) {
      const buf = this.buffers.get(channelId);
      if (!buf || buf.messages.length === 0) {
        if (!this.inFlightByChannel.has(channelId)) this.eagerChannels.delete(channelId);
        continue;
      }
      if (!this.inFlightByChannel.has(channelId)) this.flushChannel(channelId);
    }
  }

  /**
   * Flush every buffered channel immediately — call at shutdown, before
   * stop(), so the sweep's still-warm buffers aren't lost on restart.
   * Returns a promise that settles once every buffered/in-flight flush has
   * settled (success or failure) — the caller (cloud-server.ts shutdown())
   * awaits this, with its own bounded timeout, BEFORE process.exit(), so an
   * in-flight /ingest/discord HTTP call is never cut off mid-flight.
   *
   * root-cause fix (2026-07-13 re-review) — this is a MULTI-PASS drain, not
   * a single kick-and-await. A single pass is not enough: a channel whose
   * flush was ALREADY in flight when flushAll() started (guard 1 inside
   * flushChannel makes that channel's call in THIS pass a no-op) can have a
   * SEPARATE, non-empty SECOND buffer sitting in `buffers` at the same
   * moment — bufferRow() keeps accumulating into a fresh buffer for a
   * channel while its prior flush is in flight (bounded only by
   * MAX_CHANNEL_BUFFER). That second buffer is invisible to a single pass:
   * it's still sitting in `buffers` (not yet flushed) AND its channel is
   * still in `inFlightByChannel` (not yet freed) at the moment the pass
   * runs. Awaiting once and returning — the original shape — resolves as
   * soon as the FIRST flush settles, drops the second buffer on the floor,
   * and process.exit() follows moments later: exactly the reviewer's
   * reproduction (200 buffered, only the first 50-message batch flushed).
   * Looping until both `buffers` and `inFlight` are empty (bounded by
   * MAX_DRAIN_PASSES as a pure safety backstop — normal drains finish in
   * 1-2 passes) re-drives every channel once its guard frees up, so a
   * leftover second buffer always gets its own flushChannel() call in a
   * later pass, still within the SAME flushAll() await.
   */
  async flushAll(): Promise<void> {
    const MAX_DRAIN_PASSES = 25;
    for (let pass = 0; pass < MAX_DRAIN_PASSES; pass++) {
      if (this.buffers.size === 0 && this.inFlight.size === 0) return;

      // force=true (checker P2) — this is the terminal drain: there is no
      // future sweep left to pick up a channel deferred by the global
      // concurrency cap, so every remaining buffer must go out regardless
      // of MAX_CONCURRENT_FLUSHES. Per-channel serialization (guard 1
      // inside flushChannel) still applies — a channel whose flush is
      // already in flight from an EARLIER pass is correctly skipped THIS
      // pass; it gets re-attempted next pass once that flush settles.
      for (const channelId of Array.from(this.buffers.keys())) {
        this.flushChannel(channelId, true);
      }

      if (this.inFlight.size > 0) {
        await Promise.allSettled(Array.from(this.inFlight));
      }
    }

    if (this.buffers.size > 0) {
      this.log(
        'flushAll drain exhausted its retry budget with buffered messages still remaining',
        { channelsRemaining: this.buffers.size, messagesRemaining: this.totalBuffered },
        'error'
      );
    }
  }
}
