// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * model-succession.ts — when a provider retires a model, move to its
 * successor in the same family and tell the owner.
 *
 * Why: NVIDIA retired `deepseek-ai/deepseek-v4-flash` (7 Aug 2026) and
 * `z-ai/glm-5.2` (21 Aug). Both answered 410 Gone from then on, the fallback
 * chain quietly handed every reply to paid Kimi/Grok, and nobody knew for five
 * weeks. Sanctum's Room already lists new models from live catalogs; nothing
 * on the Discord side ever looked.
 *
 * Scope, deliberately narrow:
 *   - Only a RETIRED model triggers this (410 / "end of life" / "no longer
 *     available"). A timeout, 429 or 5xx is not retirement.
 *   - The successor must share vendor, family and variant, and carry a
 *     strictly higher version: glm-5.2 → glm-5.3 (never glm-5.3-flash),
 *     deepseek-v4-flash → deepseek-v4.1-flash. It never picks another family:
 *     which families make up the chain is the owner's decision.
 *   - Every switch, and every retirement with no successor, is reported once
 *     per model per process.
 */

export interface SuccessionTarget {
  engine: string;
  model: string;
}

/** Does this provider error mean the model itself is gone (not just failing)? */
export function isRetiredError(text: string | undefined | null): boolean {
  const t = (text ?? '').toLowerCase();
  return /\bapi 410\b|"status":\s*410|end of life|no longer available/.test(t);
}

interface ParsedId {
  vendor: string;
  prefix: string;
  version: number[];
  suffix: string;
}

function parseId(id: string): ParsedId | null {
  const slash = id.indexOf('/');
  const vendor = slash >= 0 ? id.slice(0, slash) : '';
  const name = slash >= 0 ? id.slice(slash + 1) : id;
  const m = name.match(/^(.*?)(\d+(?:\.\d+)*)(.*)$/);
  if (!m) return null;
  return { vendor, prefix: m[1], version: m[2].split('.').map(Number), suffix: m[3] };
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Newest catalog id in the same vendor/family/variant with a higher version, or null. */
export function pickSuccessor(deadId: string, catalog: string[]): string | null {
  const dead = parseId(deadId);
  if (!dead) return null;
  let best: { id: string; version: number[] } | null = null;
  for (const id of catalog) {
    if (id === deadId) continue;
    const c = parseId(id);
    if (!c || c.vendor !== dead.vendor || c.prefix !== dead.prefix || c.suffix !== dead.suffix) continue;
    if (compareVersions(c.version, dead.version) <= 0) continue;
    if (!best || compareVersions(c.version, best.version) > 0) best = { id, version: c.version };
  }
  return best?.id ?? null;
}

export interface SuccessionDeps {
  /** Live model ids for an engine; throw or return [] when unavailable. */
  fetchCatalog: (engine: string) => Promise<string[]>;
  /** Tell the owner. Called once per retired model per process. */
  notify: (message: string) => void | Promise<void>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Engines whose catalog we can read. Others are reported but never switched. */
const CATALOG_ENGINES = new Set(['nvidia']);

export class ModelSuccession {
  private successors = new Map<string, string>();
  private handled = new Set<string>();
  private inFlight = new Map<string, Promise<SuccessionTarget | null>>();

  constructor(private deps: SuccessionDeps) {}

  private key(t: SuccessionTarget): string {
    return `${t.engine}:${t.model}`;
  }

  /** The target to actually call: its successor if it has been retired. */
  resolve(target: SuccessionTarget): SuccessionTarget {
    // Follow the whole line (5.2 → 5.3 → 5.4), not one hop: a successor can
    // itself be retired later. Bounded in case of a cycle.
    let model = target.model;
    for (let hops = 0; hops < 10; hops++) {
      const next = this.successors.get(this.key({ engine: target.engine, model }));
      if (!next || next === model) break;
      model = next;
    }
    return model === target.model ? target : { engine: target.engine, model };
  }

  /**
   * Record that `target` answered as retired. Resolves to the successor to use
   * now, or null if there is none. Concurrent calls for the same model share
   * one catalog lookup and one notification.
   */
  noteRetired(target: SuccessionTarget): Promise<SuccessionTarget | null> {
    const key = this.key(target);
    if (this.successors.has(key)) return Promise.resolve(this.resolve(target));
    if (this.handled.has(key)) return Promise.resolve(null);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const run = this.lookUp(target).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
    return run;
  }

  private async lookUp(target: SuccessionTarget): Promise<SuccessionTarget | null> {
    const key = this.key(target);
    let next: string | null = null;
    if (CATALOG_ENGINES.has(target.engine)) {
      try {
        const catalog = await this.deps.fetchCatalog(target.engine);
        // An empty list means the catalog is unavailable, not that nothing
        // exists: never let it settle "no successor" for the life of the process.
        if (catalog.length === 0) throw new Error('empty catalog');
        next = pickSuccessor(target.model, catalog);
      } catch (err: any) {
        this.deps.log?.('model catalog unavailable — cannot pick a successor', { engine: target.engine, error: err?.message });
        // Not marked handled: a later retirement report may find the catalog up.
        return null;
      }
    }
    this.handled.add(key);
    if (next) {
      this.successors.set(key, next);
      this.deps.log?.('retired model replaced by its successor', { engine: target.engine, from: target.model, to: next });
      // Not awaited: the reply that discovered this must not wait on Discord
      // delivering a DM. The once-only guard is `handled`, set above.
      void this.safeNotify(
        `Model retired: ${target.engine} \`${target.model}\` answers "gone". I've switched it to \`${next}\` (same family, newest version) for Discord. ` +
        `This lasts until the bot restarts — update the chain in the code to keep it.`,
      );
      return { engine: target.engine, model: next };
    }
    this.deps.log?.('retired model has no successor in the catalog', { engine: target.engine, model: target.model });
    void this.safeNotify(
      `Model retired: ${target.engine} \`${target.model}\` answers "gone" and I found no newer model in the same family. ` +
      `Discord replies are falling through to the next model in the chain until the chain is changed.`,
    );
    return null;
  }

  private async safeNotify(message: string): Promise<void> {
    try {
      await this.deps.notify(message);
    } catch (err: any) {
      this.deps.log?.('succession notice failed to send', { error: err?.message });
    }
  }
}

/** NVIDIA's public model list (no key needed). */
export async function fetchNvidiaCatalog(timeoutMs = 8000): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch('https://integrate.api.nvidia.com/v1/models', { signal: controller.signal });
    if (!r.ok) throw new Error(`catalog status ${r.status}`);
    const body = (await r.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
  } finally {
    clearTimeout(timer);
  }
}
