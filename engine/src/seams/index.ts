// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * seams/index.ts — the ONE place the engine's seam implementations are chosen.
 * The choice comes from deployment config `plugs` (generic default: direct model, local settings, memory off).
 * A plug set to `custom` is answered by the hooks file (hooks.ts, found through TERTULIA_HOOKS_PATH):
 *   plugs.model    custom -> hooks.modelProvider(opts)   a ModelProvider
 *   plugs.settings custom -> hooks.settingsStore(opts)   a SettingsStore
 *   plugs.memory   custom -> hooks.contextSink(opts)     a MemoryProvider (optionally with flush() and readJournal())
 * Optional extras from the hooks file: auditSink(opts), authorNotes(authors), onChannelReply(msg, api).
 * A model provider is required: with none configured the engine refuses to start and says which settings to set.
 * Everything else is optional and off by default. No default calls a hosted service.
 */
import { type Plugs, deployConfig, type DeploymentConfig } from '../config/deployment-config.js';
import type { SettingsStore } from './settings-store.js';
import { DEFAULT_TARGET, type ModelProvider, type ModelTarget, NO_MODEL_MESSAGE } from './model-provider.js';
import { LocalSettingsStore } from './local-settings-store.js';
import { directConfigFromEnv, DirectModelProvider } from './direct-model-provider.js';
import { createLocalContextLogFlush } from './local-context-log.js';
import { createHttpContextLogFlush } from './http-context-log.js';
import { toNeutralRow } from './neutral-context-row.js';
import type { IngestMessage } from '../context-collector.js';
import { personaFromEnv, type PersonaProvider } from './persona-provider.js';
import { memoryFromEnv, type MemoryProvider } from './memory-provider.js';
import { type ProviderOptions, type AuditSink, getHooks, type Hooks } from '../hooks.js';

export interface SeamOptions {
  env?: NodeJS.ProcessEnv;
  cfg?: DeploymentConfig;
  /** The hooks module in force (default: the one hooks.ts loaded). */
  hooks?: Hooks;
  /** Per-call model timeout handed to the model provider. */
  timeoutMs?: number;
  /** First model of the text chain handed to a custom provider. */
  primaryTarget?: ModelTarget;
}

export interface Seams {
  plugs: Plugs;
  settingsStore: SettingsStore;
  modelProvider: ModelProvider;
  /** A model can be called (always true once createSeams returns: a missing provider stops the start). */
  modelReady: boolean;
  /** Settings are reachable (always true once createSeams returns). */
  settingsReady: boolean;
  /** The memory socket: the public env-chosen provider (plugs.memory off) or the hooks file's contextSink (custom). */
  memoryProvider: MemoryProvider;
  /** The persona socket (public build). null when plugs.model is custom: the provider owns the identity there. */
  personaProvider: PersonaProvider | null;
  /** Memory 'off' -> local JSONL sink for context-log rows; memory 'custom' -> null. */
  localContextLogFlush: ((batch: unknown[]) => Promise<{ inserted: number; skipped: number }>) | null;
  /**
   * The sink the engine's context collector flushes to. Memory 'off' -> rows in the neutral shape go to
   * CONTEXT_LOG_URL (https, Bearer CONTEXT_LOG_KEY) when set, else to the local JSONL file; memory 'custom' ->
   * the provider's flush() when it has one, else null (rows are dropped).
   */
  contextLogFlush: ((batch: IngestMessage[]) => Promise<{ inserted: number; skipped: number } | void>) | null;
  /** The audit-log copy sink from the hooks file, or null (the copy is off). */
  auditSink: AuditSink | null;
  /** The optional features that are off, for one startup log line. */
  optionalOff: string[];
}

function removedPlugsMessage(removed: string[]): string {
  return `The deployment config uses plug values that are no longer built in (${removed.join('; ')}). `
    + 'Set that plug to "custom" and name a hooks file in TERTULIA_HOOKS_PATH that exports the matching function (modelProvider, settingsStore or contextSink).';
}

function need<T extends keyof Hooks>(hooks: Hooks, fn: T, plug: string): NonNullable<Hooks[T]> {
  const f = hooks[fn];
  if (typeof f !== 'function') {
    throw new Error(`plugs.${plug} is "custom", but the hooks file (TERTULIA_HOOKS_PATH) exports no ${String(fn)}() function.`);
  }
  return f as NonNullable<Hooks[T]>;
}

export function createSeams(opts: SeamOptions = {}): Seams {
  const env = opts.env ?? process.env;
  const cfg = opts.cfg ?? deployConfig;
  const plugs = cfg.plugs;
  if (plugs.removed?.length) throw new Error(removedPlugsMessage(plugs.removed));
  const hooks = opts.hooks ?? getHooks();
  const po: ProviderOptions = {
    env,
    config: cfg.custom ?? {},
    timeoutMs: opts.timeoutMs ?? 30000,
    primaryTarget: opts.primaryTarget ?? DEFAULT_TARGET,
  };
  // The local context-log sink reads its keyword blocklist from the LOCAL settings store, so it only
  // pairs with settings 'local'. Refuse the mismatched pair loudly rather than log rows unfiltered.
  if (plugs.memory === 'off' && plugs.settings !== 'local') {
    throw new Error(`plugs: memory 'off' needs settings 'local' (got '${plugs.settings}') — the local context log reads its keyword blocklist from local settings`);
  }
  const localStore = plugs.settings === 'custom' ? null : new LocalSettingsStore(env.SETTINGS_PATH || './data/settings.json');
  const memoryProvider: MemoryProvider = plugs.memory === 'custom'
    ? need(hooks, 'contextSink', 'memory')(po)
    : memoryFromEnv(env);
  let modelProvider: ModelProvider;
  if (plugs.model === 'custom') {
    modelProvider = need(hooks, 'modelProvider', 'model')(po);
  } else {
    try {
      modelProvider = new DirectModelProvider(directConfigFromEnv(env), po.timeoutMs, {
        memory: memoryProvider,
        blocklist: () => localStore?.load().memory_filter.keyword_blocklist ?? [],
      });
    } catch (err: any) {
      throw new Error(`${String(err?.message ?? err)}. ${NO_MODEL_MESSAGE}`);
    }
  }
  const personaProvider: PersonaProvider | null = plugs.model === 'custom'
    ? null
    : personaFromEnv(env, () => localStore?.peekPersona() ?? { text: '', name: '', voice: '' });
  const settingsStore: SettingsStore = localStore ?? need(hooks, 'settingsStore', 'settings')(po);
  const blocklist = () => localStore?.load().memory_filter.keyword_blocklist ?? [];
  const localContextLogFlush = plugs.memory === 'off'
    ? createLocalContextLogFlush(env.CONTEXT_LOG_PATH || './data/context-log.jsonl', undefined, blocklist)
    : null;
  let contextLogFlush: Seams['contextLogFlush'] = null;
  if (plugs.memory === 'off') {
    const sink = env.CONTEXT_LOG_URL
      ? createHttpContextLogFlush(env.CONTEXT_LOG_URL, env.CONTEXT_LOG_KEY || '', blocklist) // throws on a non-https URL
      : localContextLogFlush!;
    contextLogFlush = (batch) => sink(batch.map(toNeutralRow));
  } else if (typeof memoryProvider.flush === 'function') {
    contextLogFlush = (batch) => memoryProvider.flush!(batch);
  }
  const auditSink = typeof hooks.auditSink === 'function' ? hooks.auditSink(po) : null;
  const optionalOff: string[] = [];
  if (!auditSink) optionalOff.push('audit-log copy (no auditSink)');
  if (typeof hooks.authorNotes !== 'function') optionalOff.push('author notes (no authorNotes)');
  if (typeof hooks.onChannelReply !== 'function') optionalOff.push('channel-reply hook (no onChannelReply)');
  if (typeof memoryProvider.readJournal !== 'function') optionalOff.push('journal (no readJournal)');
  if (plugs.memory === 'custom' && !contextLogFlush) optionalOff.push('context-log sink (contextSink has no flush)');
  return {
    plugs,
    settingsStore,
    modelProvider,
    modelReady: true,
    settingsReady: true,
    memoryProvider,
    personaProvider,
    localContextLogFlush,
    contextLogFlush,
    auditSink,
    optionalOff,
  };
}
