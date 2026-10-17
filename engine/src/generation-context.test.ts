// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Guardrail tests for the Context Log capture registry (generation-context.ts).
 * Run: npx tsx src/generation-context.test.ts
 */
import './test-env.js';
import { GenerationContextRegistry } from './generation-context.js';
import type { GenerationContext } from './generation-context.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

function makeCtx(overrides: Partial<GenerationContext> = {}): GenerationContext {
  return {
    engine: 'nvidia',
    model: 'z-ai/glm-5.2',
    processing_time_ms: 123,
    system_prompt: 'You are Bram.',
    system_prompt_length: 18,
    conversation_history: [{ role: 'user', content: 'hi' }],
    conversation_history_count: 1,
    channel_instruction_source: 'fly-bot',
    memory_nodes: [],
    ...overrides,
  };
}

function run(): void {
  // ── register + take round-trip ───────────────────────────────────────────
  {
    let clock = 0;
    const reg = new GenerationContextRegistry(() => clock);
    const ctx = makeCtx();
    reg.register('m1', ctx);
    ok('take() returns the exact registered ctx', reg.take('m1') === ctx);
  }

  // ── take() deletes — a second take() for the same id is undefined ───────
  {
    let clock = 0;
    const reg = new GenerationContextRegistry(() => clock);
    reg.register('m1', makeCtx());
    reg.take('m1');
    ok('take() on an already-taken id returns undefined (no crash)', reg.take('m1') === undefined);
  }

  // ── take() on an unknown id ───────────────────────────────────────────────
  {
    const reg = new GenerationContextRegistry(() => 0);
    ok('take() on a never-registered id returns undefined', reg.take('nope') === undefined);
  }

  // ── TTL expiry ─────────────────────────────────────────────────────────────
  {
    let clock = 0;
    const reg = new GenerationContextRegistry(() => clock, 200, 15 * 60_000);
    reg.register('m1', makeCtx());
    clock += 15 * 60_000 + 1; // just past the 15-minute TTL
    ok('take() past TTL returns undefined, not the stale ctx', reg.take('m1') === undefined);
  }

  // ── TTL boundary: not-yet-expired entries still return ────────────────────
  {
    let clock = 0;
    const reg = new GenerationContextRegistry(() => clock, 200, 15 * 60_000);
    reg.register('m1', makeCtx());
    clock += 14 * 60_000; // well inside the window
    ok('take() before TTL elapses returns the ctx', reg.take('m1') !== undefined);
  }

  // ── capacity eviction: oldest entry dropped first (FIFO by insertion) ─────
  {
    let clock = 0;
    const CAP = 5;
    const reg = new GenerationContextRegistry(() => clock, CAP, 15 * 60_000);
    for (let i = 0; i < CAP; i++) reg.register(`m${i}`, makeCtx());
    ok('registry at capacity holds all entries', reg.size() === CAP);
    reg.register('m-new', makeCtx()); // pushes past capacity — oldest (m0) evicted
    ok('registry stays bounded at capacity after an over-cap insert', reg.size() === CAP);
    ok('oldest entry (m0) was evicted', reg.take('m0') === undefined);
    ok('newest entry (m-new) survived', reg.take('m-new') !== undefined);
  }

  // ── injectable clock — pruning uses the injected now(), not wall-clock ────
  {
    let clock = 1_000_000;
    const reg = new GenerationContextRegistry(() => clock, 200, 1000);
    reg.register('m1', makeCtx());
    ok('fresh entry not pruned', reg.size() === 1);
    clock += 1001;
    ok('size() prunes expired entries using the injected clock', reg.size() === 0);
  }

  // ── re-registering the same id overwrites without growing the registry ────
  {
    let clock = 0;
    const reg = new GenerationContextRegistry(() => clock, 5, 15 * 60_000);
    reg.register('m1', makeCtx({ model: 'first' }));
    reg.register('m1', makeCtx({ model: 'second' }));
    ok('re-register on an existing id does not grow the registry', reg.size() === 1);
    const taken = reg.take('m1');
    ok('re-register overwrites the earlier ctx', taken?.model === 'second');
  }

  // ── late-registration subscribers can consume the exact context ──────────
  {
    const reg = new GenerationContextRegistry(() => 0);
    let notified = '';
    let consumed: GenerationContext | undefined;
    const unsubscribe = reg.subscribe((messageId) => {
      notified = messageId;
      consumed = reg.take(messageId);
    });
    reg.register('late-1', makeCtx({ model: 'late-model' }));
    ok('subscribe() reports the registered message id', notified === 'late-1');
    ok('subscriber can consume the exact registered context', consumed?.model === 'late-model');
    unsubscribe();
    reg.register('late-2', makeCtx());
    ok('unsubscribe() stops later notifications', notified === 'late-1');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
