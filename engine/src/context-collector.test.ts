// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Guardrail tests for the Context-Log collector (Phase 3, §9/§9.1).
 * Run: npx tsx src/context-collector.test.ts
 */
import './test-env.js';
import { ContextCollector } from './context-collector.js';
import type { ObserveMessage, ContextLogConfig, IngestMessage } from './context-collector.js';
import type { GenerationContext } from './generation-context.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const HOUSE_GUILD = 'house-1';

// Channel visibility is deliberately absent. Owen's 2026-07-18 ruling makes
// authorship the only Discord scope boundary; discord-client.ts owns that check.
function msg(overrides: Partial<ObserveMessage> = {}): ObserveMessage {
  return {
    messageId: 'm1',
    channelId: 'c-lounge',
    channelName: 'lounge',
    guildId: HOUSE_GUILD,
    authorId: 'u1',
    authorName: 'Someone',
    content: 'hello house',
    timestamp: '2026-07-13T00:00:00.000Z',
    isBot: false,
    ...overrides,
  };
}

// ── Mutable test harness state — reset per test block ────────────────────
let clock = 0;
let cfg: ContextLogConfig = { context_log: 'house_channels' };
let flushCalls: IngestMessage[][] = [];
let flushShouldFail = false;
// Controls what flushMock resolves with (panel P0: systematic-failure
// alarm). undefined by default — matches most tests' "no response to
// inspect" case and leaves the alarm untouched.
let flushResult: { inserted: number; skipped: number } | undefined = undefined;
let logCalls: Array<{ msg: string; meta?: Record<string, unknown> }> = [];

async function flushMock(batch: IngestMessage[]): Promise<{ inserted: number; skipped: number } | void> {
  flushCalls.push(batch);
  if (flushShouldFail) throw new Error('sanctum unreachable');
  return flushResult;
}

function makeCollector(): ContextCollector {
  return new ContextCollector({
    getConfig: () => cfg,
    involvesBot: (m) => m.content.includes('@bot'),
    flush: flushMock,
    now: () => clock,
    log: (m, meta) => { logCalls.push({ msg: m, meta }); },
  });
}

function reset(): ContextCollector {
  clock = 0;
  cfg = { context_log: 'house_channels' };
  flushCalls = [];
  flushShouldFail = false;
  flushResult = undefined;
  logCalls = [];
  return makeCollector();
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const TEN_MIN = 10 * 60_000;

async function run() {
  // ── context_log: off → nothing buffered ─────────────────────────────────
  {
    const c = reset();
    cfg = { context_log: 'off' };
    c.observe(msg({ messageId: 'a1' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('off — flush never called', flushCalls.length === 0);
  }

  // ── no guild/channel privacy filters ─────────────────────────────────────
  {
    const c = reset();
    c.observe(msg({ messageId: 'b1', guildId: 'some-other-server' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('another guild — bot message is still flushed', flushCalls.length === 1);
    ok('another guild — row carries its own guild_id, not HoS', flushCalls[0][0].guild_id === 'some-other-server');
  }

  {
    const c = reset();
    c.observe(msg({ messageId: 'b2', guildId: null }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('DM-shaped message — still flushed', flushCalls.length === 1);
    ok('DM-shaped message — guild_id is null', flushCalls[0][0].guild_id === null);
  }

  // ── mentions_only keeps only involvesBot messages ───────────────────────
  {
    const c = reset();
    cfg = { context_log: 'mentions_only' };
    c.observe(msg({ messageId: 'd1', content: 'just chatting' })); // no bot mention
    c.observe(msg({ messageId: 'd2', content: 'hey @bot check this out' })); // involvesBot via deps.involvesBot
    c.observe(msg({ messageId: 'd3', content: 'plain text', involvesBot: true })); // pre-computed by caller
    c.observe(msg({ messageId: 'd4', content: 'plain text', involvesBot: true, channelName: 'role-gated' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('mentions_only — exactly one flush', flushCalls.length === 1);
    const ids = (flushCalls[0] || []).map((r) => r.message_id).sort();
    ok('mentions_only — every involvesBot message is kept, regardless of room', JSON.stringify(ids) === JSON.stringify(['d2', 'd3', 'd4']));
  }

  // ── 50-message channel triggers flush with exactly that batch ───────────
  {
    const c = reset();
    for (let i = 0; i < 50; i++) {
      c.observe(msg({ messageId: `e${i}` }));
    }
    ok('50th message triggers an immediate flush (no sweep needed)', flushCalls.length === 1);
    ok('batch has exactly 50 messages', (flushCalls[0] || []).length === 50);
    ok('batch preserves arrival order', flushCalls[0][0].message_id === 'e0' && flushCalls[0][49].message_id === 'e49');

    // A 51st message starts a FRESH buffer — not part of the flushed batch.
    c.observe(msg({ messageId: 'e50' }));
    ok('the 51st message does not trigger a second flush by itself', flushCalls.length === 1);
  }

  // ── 10-min-old buffer flushes on sweep ───────────────────────────────────
  {
    const c = reset();
    c.observe(msg({ messageId: 'f1' }));
    ok('not flushed immediately', flushCalls.length === 0);
    clock += 9 * 60_000;
    c.sweep();
    ok('not flushed at 9 minutes', flushCalls.length === 0);
    clock += 2 * 60_000; // total 11 minutes
    c.sweep();
    await tick();
    ok('flushed once the buffer ages past 10 minutes', flushCalls.length === 1 && flushCalls[0].length === 1);
  }

  // ── flush failure → batch dropped, ONE log, buffer empty (no re-buffer) ──
  {
    const c = reset();
    flushShouldFail = true;
    c.observe(msg({ messageId: 'g1' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('flush was attempted once', flushCalls.length === 1);
    ok('exactly one failure log', logCalls.length === 1);
    ok('the failure log names the channel/count', logCalls[0].meta?.channelId === 'c-lounge' && logCalls[0].meta?.count === 1);

    // No re-buffer: the batch is gone, so a later sweep never re-flushes it.
    flushShouldFail = false;
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('no re-buffer — a later sweep produces no additional flush', flushCalls.length === 1);
  }

  // ── content >4000 chars truncated at observe time ────────────────────────
  {
    const c = reset();
    const longContent = 'a'.repeat(5000);
    c.observe(msg({ messageId: 'h1', content: longContent }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('flushed once', flushCalls.length === 1);
    ok('content capped to 4000 chars', flushCalls[0][0].content.length === 4000);
  }

  // ── empty content dropped ────────────────────────────────────────────────
  {
    const c = reset();
    c.observe(msg({ messageId: 'i1', content: '' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('empty-content message never buffered', flushCalls.length === 0);
  }

  // ── bot/webhook-authored messages ARE included (House life includes the AIs) ──
  {
    const c = reset();
    c.observe(msg({ messageId: 'j1', authorId: 'care-bot', authorName: 'Care', isBot: true, content: 'gurgle gurgle' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('bot-authored message is buffered and flushed', flushCalls.length === 1 && flushCalls[0][0].is_bot === true);
  }

  // ── Context Log capture (Owen, 2026-07-13): takeContextLog wired → context_log
  // rides along on the row it matches, omitted on rows it doesn't ───────────
  {
    function makeCtx(model: string): GenerationContext {
      return {
        engine: 'nvidia',
        model,
        processing_time_ms: 42,
        system_prompt: 'You are Bram.',
        system_prompt_length: 18,
        conversation_history: [{ role: 'user', content: 'hi' }],
        conversation_history_count: 1,
        channel_instruction_source: 'fly-bot',
        memory_nodes: [],
      };
    }
    const registry = new Map<string, GenerationContext>();
    registry.set('k1', makeCtx('z-ai/glm-5.2'));
    // 'k2' deliberately has no entry — an MCP-sent or fallback-line message.
    let takeCalls: string[] = [];
    const takeContextLog = (messageId: string): GenerationContext | undefined => {
      takeCalls.push(messageId);
      const ctx = registry.get(messageId);
      registry.delete(messageId); // read-and-delete, matching the real registry
      return ctx;
    };

    const c = new ContextCollector({
      getConfig: () => cfg,
      involvesBot: () => false,
      flush: flushMock,
      now: () => clock,
      log: (m, meta) => { logCalls.push({ msg: m, meta }); },
      takeContextLog,
    });
    c.observe(msg({ messageId: 'k1' }));
    c.observe(msg({ messageId: 'k2' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();

    const rows = flushCalls[flushCalls.length - 1] || [];
    const k1Row = rows.find((r) => r.message_id === 'k1');
    const k2Row = rows.find((r) => r.message_id === 'k2');
    ok('takeContextLog called once per flushed row', takeCalls.sort().join(',') === 'k1,k2');
    ok('row with a registered ctx carries context_log', k1Row?.context_log?.model === 'z-ai/glm-5.2');
    ok('row with NO registered ctx omits the key entirely (not null)', k2Row !== undefined && !('context_log' in k2Row));
  }

  // ── Context Log capture: a message whose context was already taken flushes
  // without context_log — no crash, no null ───────────────────────────────
  {
    let takeCallCount = 0;
    const alreadyTaken = (_messageId: string): GenerationContext | undefined => {
      takeCallCount++;
      return undefined; // simulates: someone already called take() for this id
    };
    const c = new ContextCollector({
      getConfig: () => cfg,
      involvesBot: () => false,
      flush: flushMock,
      now: () => clock,
      log: (m, meta) => { logCalls.push({ msg: m, meta }); },
      takeContextLog: alreadyTaken,
    });
    let threw = false;
    try {
      c.observe(msg({ messageId: 'k3' }));
      clock += TEN_MIN + 60_000;
      c.sweep();
      await tick();
    } catch {
      threw = true;
    }
    const rows = flushCalls[flushCalls.length - 1] || [];
    const k3Row = rows.find((r) => r.message_id === 'k3');
    ok('already-taken context — flush does not throw', threw === false);
    ok('already-taken context — takeContextLog was called', takeCallCount === 1);
    ok('already-taken context — row flushes with no context_log key, not null', k3Row !== undefined && !('context_log' in k3Row));
  }

  // ── Context Log capture: no takeContextLog dep wired at all → every row
  // flushes exactly as before (no context_log key) ─────────────────────────
  {
    const c = reset(); // makeCollector() supplies no takeContextLog
    c.observe(msg({ messageId: 'k4' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    const rows = flushCalls[flushCalls.length - 1] || [];
    const k4Row = rows.find((r) => r.message_id === 'k4');
    ok('no takeContextLog dep — row flushes with no context_log key', k4Row !== undefined && !('context_log' in k4Row));
  }

  // ── Send/flush race fix (Codex review, 2026-07-13): a bot-authored row's
  // own gateway echo can hit the 50-msg threshold flush BEFORE the send
  // site's generationContext.register() call lands. flushChannel() waits
  // once (deps.graceDelay) and re-checks takeContextLog() for exactly the
  // bot-authored rows still missing context — a "late" registration that
  // lands during that wait must still ride along on the flushed row ───────
  {
    function makeCtx(model: string): GenerationContext {
      return {
        engine: 'nvidia',
        model,
        processing_time_ms: 10,
        system_prompt: 'sys',
        system_prompt_length: 3,
        conversation_history: [],
        conversation_history_count: 0,
        channel_instruction_source: 'fly-bot',
        memory_nodes: [],
      };
    }
    const registry = new Map<string, GenerationContext>();
    const takeContextLog = (messageId: string): GenerationContext | undefined => {
      const ctx = registry.get(messageId);
      registry.delete(messageId);
      return ctx;
    };
    let graceDelayCalls = 0;
    let onGraceDelay: (() => void) | null = null;
    const graceDelay = async (_ms: number): Promise<void> => {
      graceDelayCalls++;
      // Simulates the exact race: the send site's register() call lands
      // WHILE the collector is inside its grace wait, not before it.
      onGraceDelay?.();
    };
    const raceFlushCalls: IngestMessage[][] = [];
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: async (batch) => { raceFlushCalls.push(batch); },
      now: () => clock,
      takeContextLog,
      graceDelay,
    });

    onGraceDelay = () => registry.set('bot-race-1', makeCtx('late-model'));
    for (let i = 0; i < 49; i++) c.observe(msg({ messageId: `race${i}` }));
    c.observe(msg({ messageId: 'bot-race-1', isBot: true, authorId: 'bramley-bot' })); // 50th — triggers the flush
    ok('grace-race — graceDelay invoked exactly once for the missing bot row', graceDelayCalls === 1);
    await tick();
    await tick();
    const raceRows = raceFlushCalls[raceFlushCalls.length - 1] || [];
    const raceBotRow = raceRows.find((r) => r.message_id === 'bot-race-1');
    ok('grace-race — flush still fires exactly once for the 50-message batch', raceFlushCalls.length === 1 && raceRows.length === 50);
    ok('grace-race — the late-registered context lands on the row after the grace wait', raceBotRow?.context_log?.model === 'late-model');
  }

  // ── Send/flush race fix: context NEVER lands even after the grace wait —
  // the row still flushes, with no context_log key, no crash ─────────────
  {
    let graceDelayCalls2 = 0;
    const graceDelay2 = async (_ms: number): Promise<void> => { graceDelayCalls2++; };
    const neverFlushCalls: IngestMessage[][] = [];
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: async (batch) => { neverFlushCalls.push(batch); },
      now: () => clock,
      takeContextLog: () => undefined, // never registered, ever
      graceDelay: graceDelay2,
    });
    let threw = false;
    try {
      for (let i = 0; i < 49; i++) c.observe(msg({ messageId: `nv${i}` }));
      c.observe(msg({ messageId: 'bot-never-1', isBot: true, authorId: 'bramley-bot' }));
      await tick();
      await tick();
    } catch {
      threw = true;
    }
    const neverRows = neverFlushCalls[neverFlushCalls.length - 1] || [];
    const neverBotRow = neverRows.find((r) => r.message_id === 'bot-never-1');
    ok('grace-timeout — waits once, then flushes without throwing', threw === false && graceDelayCalls2 === 1);
    ok('grace-timeout — row flushes with no context_log key, not null', neverBotRow !== undefined && !('context_log' in neverBotRow));
  }

  // ── Send/flush race fix: no bot-authored row is missing context (either no
  // bot rows, or every bot row already has one) → graceDelay is NEVER
  // invoked — a normal batch pays zero extra latency ───────────────────────
  {
    let graceDelayCalls3 = 0;
    const graceDelay3 = async (_ms: number): Promise<void> => { graceDelayCalls3++; };
    const noWaitFlushCalls: IngestMessage[][] = [];
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: async (batch) => { noWaitFlushCalls.push(batch); },
      now: () => clock,
      takeContextLog: () => undefined, // human-authored rows never have one anyway
      graceDelay: graceDelay3,
    });
    for (let i = 0; i < 50; i++) c.observe(msg({ messageId: `nb${i}` })); // isBot: false (default)
    ok('no-bot-rows — 50th message flushes immediately, no grace wait', noWaitFlushCalls.length === 1);
    ok('no-bot-rows — graceDelay never invoked', graceDelayCalls3 === 0);
  }

  // ── observe() never throws, even when the triggered flush rejects ───────
  {
    const c = reset();
    flushShouldFail = true;
    let threw = false;
    try {
      for (let i = 0; i < 50; i++) c.observe(msg({ messageId: `k${i}` }));
    } catch {
      threw = true;
    }
    ok('observe() does not throw when the flush it triggers rejects', threw === false);
    await tick();
    ok('the rejected flush was still attempted', flushCalls.length === 1);
    ok('and logged exactly once', logCalls.length === 1);
  }

  // ── checker P2 — close() makes observe() an immediate no-op ─────────────
  {
    const c = reset();
    c.close();
    c.observe(msg({ messageId: 'closed1' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('closed collector — observe() is a no-op, nothing ever buffered/flushed', flushCalls.length === 0);
  }

  // ── Discord own-message path can make a freshly observed reply visible
  // immediately instead of waiting for the ten-minute safety sweep ────────
  {
    const c = reset();
    c.observe(msg({ messageId: 'eager1', isBot: true, authorId: 'bramley-bot' }));
    c.flushNow('c-lounge');
    await tick();
    ok(
      'flushNow — one freshly observed bot reply is delivered immediately',
      flushCalls.length === 1 && flushCalls[0].length === 1 && flushCalls[0][0].message_id === 'eager1'
    );
  }

  // Immediate flush uses the same late context-registration grace as the
  // legacy 50-message trigger. This is the production race: Discord's own
  // gateway echo can arrive just before sendMessage() registers the ctx.
  {
    const registry = new Map<string, GenerationContext>();
    let graceCalls = 0;
    const eagerGraceCalls: IngestMessage[][] = [];
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      takeContextLog: (messageId) => {
        const ctx = registry.get(messageId);
        registry.delete(messageId);
        return ctx;
      },
      graceDelay: async () => {
        graceCalls++;
        registry.set('eager-grace', {
          engine: 'nvidia', model: 'late-context', processing_time_ms: 1,
          system_prompt: 'effective', system_prompt_length: 9,
          conversation_history: [], conversation_history_count: 0,
          channel_instruction_source: 'fly-bot', memory_nodes: [],
        });
      },
      flush: async (batch) => { eagerGraceCalls.push(batch); },
    });
    c.observe(msg({ messageId: 'eager-grace', isBot: true, authorId: 'bramley-bot' }));
    c.flushNow('c-lounge');
    await tick();
    await tick();
    ok('flushNow grace — late context registration is retried exactly once', graceCalls === 1);
    ok('flushNow grace — immediate row carries the late effective context', eagerGraceCalls[0]?.[0]?.context_log?.model === 'late-context');
  }

  // A registration can arrive after even the grace window (the production
  // 05:00 WIB failure). The first ingest remains fail-soft and immediate;
  // the registry notification then re-ingests the same id with its receipt.
  {
    const registry = new Map<string, GenerationContext>();
    let notifyRegistered: ((messageId: string) => void) | null = null;
    const lateCalls: IngestMessage[][] = [];
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      takeContextLog: (messageId) => {
        const ctx = registry.get(messageId);
        registry.delete(messageId);
        return ctx;
      },
      subscribeContextLog: (listener) => {
        notifyRegistered = listener;
        return () => { notifyRegistered = null; };
      },
      graceDelay: async () => { /* deliberately expires before registration */ },
      flush: async (batch) => { lateCalls.push(batch); return { inserted: 1, skipped: 0 }; },
      now: () => clock,
    });
    c.observe(msg({ messageId: 'late-after-grace', isBot: true, authorId: 'bramley-bot' }));
    c.flushNow('c-lounge');
    await tick();
    await tick();
    ok('post-grace backfill — initial bot row still ingests fail-soft without a receipt',
      lateCalls.length === 1 && !('context_log' in lateCalls[0][0]));

    registry.set('late-after-grace', {
      engine: 'kimi', model: 'kimi-k3', processing_time_ms: 44,
      system_prompt: 'effective prompt', system_prompt_length: 16,
      conversation_history: [{ role: 'user', content: 'actual room window' }],
      conversation_history_count: 1, channel_instruction_source: 'fly-bot', memory_nodes: [],
    });
    (notifyRegistered as ((messageId: string) => void) | null)?.('late-after-grace');
    await tick();
    ok('post-grace backfill — duplicate ingest carries the real late receipt',
      lateCalls.length === 2 && lateCalls[1][0].context_log?.model === 'kimi-k3');
  }

  // A second reply can arrive while the first immediate request is still in
  // flight. It must be re-driven when the first settles, not stranded until
  // the age sweep.
  {
    let releaseFirst: (() => void) | null = null;
    const eagerCalls: IngestMessage[][] = [];
    let callCount = 0;
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: async (batch: IngestMessage[]) => {
        eagerCalls.push(batch);
        callCount++;
        if (callCount === 1) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
      },
    });

    c.observe(msg({ messageId: 'eager-a', isBot: true, authorId: 'bramley-bot' }));
    c.flushNow('c-lounge');
    await tick();
    c.observe(msg({ messageId: 'eager-b', isBot: true, authorId: 'bramley-bot' }));
    c.flushNow('c-lounge');
    await tick();
    ok('flushNow overlap — second request waits while the first is in flight', eagerCalls.length === 1);

    releaseFirst!();
    await tick();
    await tick();
    ok(
      'flushNow overlap — second buffered reply is delivered when the first settles',
      eagerCalls.length === 2 && eagerCalls[1].length === 1 && eagerCalls[1][0].message_id === 'eager-b'
    );
  }

  // ── checker P2 — close() BEFORE flushAll(): pre-close messages still
  // flush; anything observed AFTER close() never spins up a fresh buffer
  // that flushAll() would otherwise miss and silently discard ──────────────
  {
    const c = reset();
    c.observe(msg({ messageId: 'preclose1' }));
    c.close();
    c.observe(msg({ messageId: 'postclose1' })); // must be dropped, not buffered
    await c.flushAll();
    ok('close() then flushAll() — the pre-close message still flushes', flushCalls.length === 1);
    ok(
      'close() then flushAll() — only the pre-close message is in the batch (post-close never buffered)',
      (flushCalls[0] || []).length === 1 && flushCalls[0][0].message_id === 'preclose1'
    );
  }

  // ── checker P2 — flush concurrency: serialized per channel, capped at 3
  // globally in flight; further triggers back off for the next sweep ──────
  {
    clock = 0;
    const deferred: Array<() => void> = [];
    const concurrencyFlushCalls: string[] = [];
    let currentConcurrent = 0;
    let maxConcurrent = 0;
    function slowFlush(batch: IngestMessage[]): Promise<void> {
      concurrencyFlushCalls.push(batch[0].channel_id);
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      return new Promise<void>((resolve) => {
        deferred.push(() => { currentConcurrent--; resolve(); });
      });
    }
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: slowFlush,
      now: () => clock,
    });

    // 5 channels, each pushed to exactly 50 messages — each 50th message
    // triggers an immediate flush attempt for that channel.
    for (let ch = 0; ch < 5; ch++) {
      for (let i = 0; i < 50; i++) {
        c.observe(msg({ messageId: `cc-${ch}-${i}`, channelId: `chan-${ch}`, channelName: `chan-${ch}` }));
      }
    }
    ok('concurrency cap — at most 3 flushes fire immediately across 5 bursting channels', concurrencyFlushCalls.length === 3);
    ok('concurrency cap — max concurrent in flight never exceeds 3', maxConcurrent === 3);

    // Freeing a slot does not itself retroactively retry a deferred channel
    // — that only happens on the next sweep tick.
    deferred[0]();
    await tick();
    ok('concurrency cap — resolving one flush does not immediately trigger a deferred channel', concurrencyFlushCalls.length === 3);

    // The next sweep retries deferred channels now that a slot is free —
    // exactly one more fires (only one slot was freed).
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('concurrency cap — the next sweep picks up exactly one deferred channel once a slot frees', concurrencyFlushCalls.length === 4);

    for (const resolve of deferred.slice(1)) resolve();
    await tick();
  }


  // Eager channels deferred by the global cap must re-drive automatically
  // as soon as any in-flight request frees a slot—never wait ten minutes.
  {
    const deferred: Array<() => void> = [];
    const eagerCapCalls: string[] = [];
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: (batch) => {
        eagerCapCalls.push(batch[0].channel_id);
        return new Promise<void>((resolve) => { deferred.push(resolve); });
      },
    });

    for (let ch = 0; ch < 4; ch++) {
      const channelId = `eager-cap-${ch}`;
      c.observe(msg({ messageId: `eager-cap-msg-${ch}`, channelId, channelName: channelId }));
      c.flushNow(channelId);
    }
    await tick();
    ok('flushNow global cap — only three eager requests start concurrently', eagerCapCalls.length === 3);

    deferred[0]();
    await tick();
    await tick();
    ok('flushNow global cap — deferred fourth channel re-drives when a slot frees', eagerCapCalls.length === 4 && eagerCapCalls[3] === 'eager-cap-3');

    for (const resolve of deferred.slice(1)) resolve();
    await tick();
  }

  // ── every channel flows under BOTH legacy 'house_channels' and 'all' ───
  {
    const c = reset();
    cfg = { context_log: 'house_channels' };
    c.observe(msg({ messageId: 'pub1', channelName: 'role-gated' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok("role-gated channel — flushed under legacy 'house_channels'", flushCalls.length === 1 && flushCalls[0][0].message_id === 'pub1');
  }
  {
    const c = reset();
    cfg = { context_log: 'all' };
    c.observe(msg({ messageId: 'pub2', guildId: null, channelName: 'DM' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok("DM — flushed under 'all'", flushCalls.length === 1 && flushCalls[0][0].message_id === 'pub2');
  }

  // ── explicit restricted-room regression: room names never narrow scope ──
  {
    const c = reset();
    cfg = { context_log: 'all' };
    c.observe(msg({ messageId: 'dial1', channelId: 'c-private', channelName: 'private-quarters' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok("dial='all' — private-quarters name is still recorded", flushCalls.length === 1);
  }

  // ── panel P0 — dial semantics: an unrecognized context_log value fails
  // closed (treated as 'off'), with exactly one log ────────────────────────
  {
    const c = reset();
    cfg = { context_log: 'not-a-real-value' };
    c.observe(msg({ messageId: 'dial2' }));
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    ok('unrecognized context_log value — flush never called (fail closed)', flushCalls.length === 0);
    ok('unrecognized context_log value — exactly one log emitted', logCalls.length === 1);
    ok('the log names the bad value', logCalls[0].meta?.value === 'not-a-real-value');
  }

  // ── panel P0 — systematic-failure alarm: inserted===0 on a non-empty
  // batch logs at ERROR level with the distinct marker, escalating on 3+
  // consecutive occurrences ────────────────────────────────────────────────
  {
    clock = 0;
    const alarmLogs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: async () => ({ inserted: 0, skipped: 1 }),
      now: () => clock,
      log: (m, meta) => { alarmLogs.push({ msg: m, meta }); },
    });

    for (let round = 0; round < 3; round++) {
      c.observe(msg({ messageId: `alarm${round}` }));
      clock += TEN_MIN + 60_000;
      c.sweep();
      await tick();
    }

    const alarmEntries = alarmLogs.filter((l) => l.msg.includes('SYSTEMATIC FAILURE'));
    ok('systematic-failure alarm fires on every inserted===0 flush', alarmEntries.length === 3);
    ok('the 1st and 2nd alarms do not yet claim an escalated streak', !alarmEntries[0].msg.includes('consecutive') && !alarmEntries[1].msg.includes('consecutive'));
    ok('the 3rd consecutive alarm escalates its message', alarmEntries[2].msg.includes('3 consecutive'));
  }

  // ── panel P0 — systematic-failure alarm streak resets on a real
  // (inserted>0) success ───────────────────────────────────────────────────
  {
    clock = 0;
    const alarmLogs2: Array<{ msg: string }> = [];
    const resultQueue: Array<{ inserted: number; skipped: number }> = [
      { inserted: 0, skipped: 1 },
      { inserted: 0, skipped: 1 },
      { inserted: 5, skipped: 0 }, // real success — resets the streak
      { inserted: 0, skipped: 1 },
    ];
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: async () => resultQueue.shift(),
      now: () => clock,
      log: (m) => { alarmLogs2.push({ msg: m }); },
    });
    for (let round = 0; round < 4; round++) {
      c.observe(msg({ messageId: `reset${round}` }));
      clock += TEN_MIN + 60_000;
      c.sweep();
      await tick();
    }
    const entries = alarmLogs2.filter((l) => l.msg.includes('SYSTEMATIC FAILURE'));
    ok('alarm fires on rounds 1, 2, and 4 but not round 3 (real success)', entries.length === 3);
    ok('round 4 alarm does not claim a 3+ escalation (round 3 reset the streak)', !entries[2].msg.includes('consecutive'));
  }

  // ── panel P0 — per-channel buffer cap (200): a stuck in-flight flush lets
  // a channel's SECOND buffer grow unbounded unless capped; excess is
  // drop-oldest, counted and logged once at the next sweep tick ───────────
  {
    clock = 0;
    const capLogs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: () => new Promise<void>(() => { /* never resolves — simulates a stuck flush */ }),
      now: () => clock,
      log: (m, meta) => { capLogs.push({ msg: m, meta }); },
    });

    // First 50 messages trigger one (permanently stuck) flush, emptying the
    // buffer. The next 210 messages accumulate in a fresh buffer that can
    // never flush (the channel is still "in flight") — the per-channel cap
    // (200) must drop the 10 oldest of those to hold the line.
    for (let i = 0; i < 260; i++) {
      c.observe(msg({ messageId: `pc${i}`, channelId: 'c-lounge' }));
    }
    c.sweep();
    const capLog = capLogs.find((l) => l.msg.includes('buffer cap reached'));
    ok('per-channel cap — drop-oldest log fires once at sweep', !!capLog);
    ok('per-channel cap — dropped count matches the overflow (210 - 200 = 10)', capLog?.meta?.droppedSinceLastSweep === 10);
  }

  // ── panel P0 — global buffer cap (2000): many channels bursting at once,
  // each individually under both the 50-msg flush threshold and the 200
  // per-channel cap, still bounds total memory via drop-oldest across
  // buffers, counted and logged once at the next sweep tick ───────────────
  {
    clock = 0;
    const globalLogs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    let globalFlushCalls = 0;
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: async () => { globalFlushCalls++; },
      now: () => clock,
      log: (m, meta) => { globalLogs.push({ msg: m, meta }); },
    });

    const TOTAL = 2050;
    const CHANNELS = 50; // 41 msgs/channel — under both the 50-msg threshold and the 200 per-channel cap
    for (let i = 0; i < TOTAL; i++) {
      c.observe(msg({ messageId: `g${i}`, channelId: `gchan-${i % CHANNELS}`, channelName: `gchan-${i % CHANNELS}` }));
    }
    ok('global cap test — no channel ever reached the 50-msg flush threshold', globalFlushCalls === 0);
    c.sweep();
    const capLog = globalLogs.find((l) => l.msg.includes('buffer cap reached'));
    ok('global cap — drop-oldest log fires once at sweep', !!capLog);
    ok('global cap — dropped count matches the overflow (2050 - 2000 = 50)', capLog?.meta?.droppedSinceLastSweep === 50);
    ok('global cap — totalBuffered settles back at exactly the budget', capLog?.meta?.totalBuffered === 2000);
  }

  // ── root-cause fix (2026-07-13 re-review) — codex P1 repro #1: a channel
  // flush stuck in-flight lets bufferRow() accumulate a second, oversized
  // buffer; once the stuck flush frees up, the NEXT flush must never send
  // more than MAX_FLUSH_BATCH (100) messages in a single deps.flush() call,
  // even though the buffer itself grew past 100 (bounded only by the
  // 200-msg per-channel cap). Reproduces the reviewer's exact repro shape:
  // [50, 151] → must become [50, 100, 51], never [50, 151] ───────────────
  {
    clock = 0;
    const chunkSizes: number[] = [];
    let resolveFirst: (() => void) | null = null;
    let callCount = 0;
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: (batch: IngestMessage[]) => {
        callCount++;
        chunkSizes.push(batch.length);
        if (callCount === 1) {
          return new Promise<{ inserted: number; skipped: number }>((resolve) => {
            resolveFirst = () => resolve({ inserted: batch.length, skipped: 0 });
          });
        }
        return Promise.resolve({ inserted: batch.length, skipped: 0 });
      },
      now: () => clock,
    });

    // First 50 messages trigger the first flush, which sticks in-flight.
    for (let i = 0; i < 50; i++) c.observe(msg({ messageId: `ov-a${i}`, channelId: 'c-lounge' }));
    ok('oversized-batch repro — first flush fires immediately with exactly 50', chunkSizes.length === 1 && chunkSizes[0] === 50);

    // 151 more arrive while that flush is stuck — every threshold trigger
    // during this window is a guarded no-op (per-channel serialization), so
    // they all land in one fresh, growing buffer instead.
    for (let i = 0; i < 151; i++) c.observe(msg({ messageId: `ov-b${i}`, channelId: 'c-lounge' }));
    ok('oversized-batch repro — no second flush fires while the first is in flight', chunkSizes.length === 1);

    // Free the stuck flush, then age the (now 151-message) second buffer
    // past the sweep threshold so it goes out.
    resolveFirst!();
    await tick();
    await tick();
    clock += TEN_MIN + 60_000;
    c.sweep();
    await tick();
    await tick();

    const laterChunks = chunkSizes.slice(1);
    ok('oversized-batch repro — the 151-message buffer is split into more than one call', laterChunks.length === 2);
    ok('oversized-batch repro — no single call ever exceeds the 100-message Sanctum limit', laterChunks.every((n) => n <= 100));
    ok('oversized-batch repro — the split chunks still sum to the full 151', laterChunks.reduce((a, b) => a + b, 0) === 151);
  }

  // ── root-cause fix (2026-07-13 re-review) — codex P1 repro #2: shutdown
  // must not silently drop a channel's second buffer that formed while its
  // first flush was still in-flight at close() time. Reproduces the
  // reviewer's exact repro: 200 buffered (50 stuck in-flight + 150 in a
  // second buffer) → close() + flushAll() must deliver all 200, not just
  // the original 50 ──────────────────────────────────────────────────────
  {
    clock = 0;
    const chunkSizes: number[] = [];
    let resolveFirst: (() => void) | null = null;
    let callCount = 0;
    const c = new ContextCollector({
      getConfig: () => ({ context_log: 'house_channels' }),
      involvesBot: () => false,
      flush: (batch: IngestMessage[]) => {
        callCount++;
        chunkSizes.push(batch.length);
        if (callCount === 1) {
          return new Promise<{ inserted: number; skipped: number }>((resolve) => {
            resolveFirst = () => resolve({ inserted: batch.length, skipped: 0 });
          });
        }
        return Promise.resolve({ inserted: batch.length, skipped: 0 });
      },
      now: () => clock,
    });

    for (let i = 0; i < 50; i++) c.observe(msg({ messageId: `sd-a${i}`, channelId: 'c-lounge' })); // first flush, stuck in-flight
    for (let i = 0; i < 150; i++) c.observe(msg({ messageId: `sd-b${i}`, channelId: 'c-lounge' })); // second buffer, 150 msgs

    c.close(); // shutdown ordering: stop observation first
    const flushAllPromise = c.flushAll();
    // The original (stuck) flush finally settles WHILE flushAll() is
    // draining — this is the exact race from the repro: the second buffer
    // must still make it out once the guard frees up, within this SAME
    // flushAll() await, not dropped when it resolves too early.
    setTimeout(() => resolveFirst!(), 5);
    await flushAllPromise;

    const totalSent = chunkSizes.reduce((a, b) => a + b, 0);
    ok('shutdown-drop repro — flushAll delivers all 200 buffered messages, not just the first 50', totalSent === 200);
    ok('shutdown-drop repro — more than one flush call fired (the second buffer was not skipped)', chunkSizes.length >= 2);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
