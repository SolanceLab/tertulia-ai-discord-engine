// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * generation-context.ts — Context Log capture registry (Owner, 2026-07-13,
 * FORWARD ONLY, no backfill).
 * -----------------------------------------------------------------------------
 * hos-app's Context Logs page (src/pages/ContextLogs.jsx) reads a `context_log`
 * object per ingested Discord message — engine/model/timing/system prompt/
 * conversation window that PRODUCED it. The collector stores the bot replies
 * as the independent rows; the triggering human message and surrounding room
 * window live inside that reply's audit object, supplied by this tiny, bounded,
 * in-memory registry keyed by the SENT Discord message id.
 *
 * Flow: a generation site (presence-engine.ts judge()/respond(), cloud-server.ts's
 * curfew-nudge/away generators) builds a GenerationContext describing exactly
 * what it sent to Sanctum + how long it took. The SEND call site (discord-client.ts
 * sendMessage callers, cloud-server.ts's away sendMessage wrapper) registers that
 * ctx under the Discord message id Discord handed back, the instant the send
 * succeeds. context-collector.ts, when it flushes a buffered row, takes() the
 * ctx for that row's message id and rides it along as `context_log` on the
 * ingest payload — omitted entirely when there is none (never null, never
 * fabricated).
 *
 * `memory_nodes` (§14, Owner 2026-07-13) — populated from whatever Sanctum's
 * `/complete` handed back when a generation site requested optional recall
 * (mention/DM reply, ambient judge, curfew nudge). `[]` when recall wasn't
 * requested (the away branch — §14.1, gated behind the owner's separate go, NOT
 * given) or none came back. NEVER null, never fabricated — a call site that
 * got nothing from Sanctum must pass `[]`, not invent nodes. `recall_ms`
 * mirrors it: present only when Sanctum actually timed a recall attempt.
 *
 * Pure + standalone: no Discord, no network, no other module import beyond its
 * own types. Bounded (capacity-evicted, oldest insertion first) and TTL-pruned
 * so a message that's NEVER flushed (context_log dial off, private channel,
 * flush failure) can't leak memory forever. Injectable clock for tests.
 */

/** One turn in the conversation window actually sent to the model. */
export interface GenerationContextMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A real Discord message that the generation path used as room context. */
export interface GenerationContextDiscordMessage {
  message_id?: string;
  author_id?: string;
  author_name: string;
  content: string;
  timestamp?: string;
  is_from_me?: boolean;
  is_trigger?: boolean;
  // Images the model was actually shown for this reply (2026-07-30). Recorded
  // so the receipt says what I SAW, not merely what was said — without it a
  // vision reply reads as an inexplicably good guess about nothing.
  //
  // Deliberately metadata only (filename + content type), never the signed CDN
  // url: these rows persist, and a stored Discord attachment url expires into
  // something that still LOOKS like data. A filename that no longer resolves is
  // honest; a dead link that looks live is not.
  attachments?: Array<{ filename?: string; content_type?: string }>;
}

/** Exact shape hos-app's ContextLogs.jsx reads — key names matter. */
export interface GenerationContext {
  engine: string;
  model: string;
  processing_time_ms: number;
  system_prompt: string;
  system_prompt_length: number;
  conversation_history: GenerationContextMessage[];
  conversation_history_count: number;
  // The actual Discord window supplied to the generation path. This is kept
  // separate from `conversation_history`, which is the model API's messages
  // array and may contain only a synthetic instruction such as "Reply...".
  discord_context?: GenerationContextDiscordMessage[];
  // The exact Discord message that caused this reply when the caller knows it.
  trigger_message?: GenerationContextDiscordMessage;
  channel_instruction_source: string;
  // Whatever Sanctum's /complete `recall` param handed back for THIS turn.
  // `[]` when recall wasn't requested or nothing came back — never
  // fabricated (§14, Owner 2026-07-13; see file header).
  memory_nodes: unknown[];
  // Present only when Sanctum actually attempted (and timed) a recall —
  // absent when recall wasn't requested at all.
  recall_ms?: number;
}

const DEFAULT_CAPACITY = 200;
const DEFAULT_TTL_MS = 15 * 60_000;

interface Entry {
  ctx: GenerationContext;
  expiresAtMs: number;
}

/**
 * register(messageId, ctx) right after a generated Discord message sends
 * successfully; take(messageId) reads-and-deletes it once, at flush time.
 * A second take() for the same id (already consumed, expired, or never
 * registered) returns undefined — never throws, never fabricates.
 */
export class GenerationContextRegistry {
  private entries: Map<string, Entry> = new Map();
  private listeners: Set<(messageId: string) => void> = new Set();
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(
    now: () => number = () => Date.now(),
    capacity: number = DEFAULT_CAPACITY,
    ttlMs: number = DEFAULT_TTL_MS,
  ) {
    this.now = now;
    this.capacity = capacity;
    this.ttlMs = ttlMs;
  }

  /** Bound the registry BEFORE inserting: capacity eviction is oldest-insertion-first
   * (Map iteration order), TTL pruning sweeps every stale entry first. */
  register(messageId: string, ctx: GenerationContext): void {
    this.prune();
    if (!this.entries.has(messageId) && this.entries.size >= this.capacity) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(messageId, { ctx, expiresAtMs: this.now() + this.ttlMs });
    for (const listener of this.listeners) {
      try { listener(messageId); } catch { /* registry writes must never fail */ }
    }
  }

  /** Notify collectors when a send-site registration lands after its gateway
   * echo was already ingested. The listener receives only the id; it uses
   * take() to consume the exact registered context. */
  subscribe(listener: (messageId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Read-and-delete. Expired entries are treated as absent (deleted, undefined
   * returned) rather than handed back stale. */
  take(messageId: string): GenerationContext | undefined {
    const entry = this.entries.get(messageId);
    if (!entry) return undefined;
    this.entries.delete(messageId);
    if (entry.expiresAtMs <= this.now()) return undefined;
    return entry.ctx;
  }

  /** Test/introspection helper — current live (non-expired) entry count. */
  size(): number {
    this.prune();
    return this.entries.size;
  }

  private prune(): void {
    const nowMs = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(key);
    }
  }
}
