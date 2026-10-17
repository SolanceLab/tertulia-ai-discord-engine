// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/model-chain.test.ts */
import './test-env.js';
import { walkChain, type ChainTarget } from './model-chain.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const OPTS = { budgetMs: 30_000, perModelMs: 12_000 };
const C: ChainTarget = { engine: 'grok', model: 'g4' };
const B: ChainTarget = { engine: 'kimi', model: 'k2' };
const A: ChainTarget = { engine: 'nvidia', model: 'glm' };

async function run() {
  {
    const r = await walkChain([A, B], async () => 'hi', OPTS);
    ok('first model answering wins', r?.result === 'hi' && r.target === A);
  }
  {
    const tried: string[] = [];
    const r = await walkChain([A, B, C], async (t) => { tried.push(t.model); return t === B ? 'from B' : null; }, OPTS);
    ok('null from the first → second answers', r?.result === 'from B' && r.target === B);
    ok('stops at the first answer (C never tried)', tried.join(',') === 'glm,k2');
  }
  {
    const r = await walkChain([A, B], async (t) => { if (t === A) throw new Error('down'); return 'B ok'; }, OPTS);
    ok('a throw counts as no answer, the next model is tried', r?.result === 'B ok' && r.target === B);
  }
  {
    const r = await walkChain([A, B, C], async () => null, OPTS);
    ok('every model empty → null (caller decides what happens)', r === null);
  }
  {
    // Timeout: a model that never resolves on its own is aborted at perModelMs.
    const r = await walkChain(
      [A, B],
      (t, signal) => t === A
        ? new Promise<string | null>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
        : Promise.resolve('B after timeout'),
      { budgetMs: 1_000, perModelMs: 30 },
    );
    ok('a hung model is aborted and the next one answers', r?.result === 'B after timeout' && r.target === B);
  }
  {
    // Budget: once spent, later models are skipped entirely.
    let clock = 0;
    const tried: string[] = [];
    const r = await walkChain(
      [A, B, C],
      async (t) => { tried.push(t.model); clock += 20_000; return null; },
      { budgetMs: 30_000, perModelMs: 12_000, now: () => clock },
    );
    ok('spent budget skips the rest', r === null && tried.join(',') === 'glm,k2');
  }
  {
    // The signal is aborted after every attempt, success included.
    let seen: AbortSignal | null = null;
    await walkChain([A], async (_t, signal) => { seen = signal; return 'x'; }, OPTS);
    ok('signal aborted once the attempt is done', (seen as AbortSignal | null)?.aborted === true);
  }
  {
    // Per-model cap is clipped to what remains of the budget.
    let clock = 0;
    let aborted = false;
    await walkChain(
      [A, B],
      (t, signal) => {
        if (t === A) { clock = 29_990; return Promise.resolve(null); }
        return new Promise<string | null>((resolve) => {
          signal.addEventListener('abort', () => { aborted = true; resolve(null); });
        });
      },
      { budgetMs: 30_000, perModelMs: 12_000, now: () => clock },
    );
    ok('last model gets only the remaining budget (aborted in ~10ms, not 12s)', aborted);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
