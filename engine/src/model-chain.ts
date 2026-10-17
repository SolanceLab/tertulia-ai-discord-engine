// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * model-chain.ts — try each model in order until one answers, inside a total
 * time budget.
 *
 * The away reply and the curfew nudge each called GLM alone. When NVIDIA was
 * slow or down, both fell back to fixed lines: the curfew template went out
 * 20 times between 11 and 26 Sep 2026, and the owner named the away one an
 * "auto respond template" on 28 Sep. Both now walk the same chain as ambient
 * presence through this one function. It lives outside cloud-server.ts
 * because that file runs main() on import and cannot be tested.
 */

export interface ChainTarget {
  engine: string;
  model: string;
}

export interface ChainOptions {
  /** Total time for the whole walk. Later models are skipped once it is spent. */
  budgetMs: number;
  /** Cap for any single model; clipped to what is left of the budget. */
  perModelMs: number;
  now?: () => number;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * `attempt` gets the target and an AbortSignal and resolves to a result, or
 * to null when that model gave nothing usable. A throw counts as null. The
 * signal is aborted after every attempt (success included), so a stalled
 * response body can never outlive its slot.
 */
export async function walkChain<T>(
  targets: ChainTarget[],
  attempt: (target: ChainTarget, signal: AbortSignal) => Promise<T | null>,
  opts: ChainOptions,
): Promise<{ result: T; target: ChainTarget } | null> {
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + opts.budgetMs;
  for (const target of targets) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      opts.log?.('model chain budget spent', { skipped: target.model });
      break;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(opts.perModelMs, remaining));
    try {
      const result = await attempt(target, controller.signal);
      if (result !== null && result !== undefined) return { result, target };
      opts.log?.('model gave nothing — trying next', { engine: target.engine, model: target.model });
    } catch (err: any) {
      opts.log?.('model call failed — trying next', { engine: target.engine, model: target.model, error: err?.message });
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return null;
}
