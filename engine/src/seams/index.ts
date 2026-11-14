// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * seams/index.ts — the ONE place the engine's seam implementations are chosen.
 * The choice comes from deployment config `plugs` (generic default: direct model, local settings,
 * memory off). The deployment file selects the model service + the settings service + the model service memory, and then this
 * factory returns exactly the classes the bot used before the seams existed.
 */
import { type Plugs, deployConfig, type DeploymentConfig } from '../config/deployment-config.js';
import { HostedSettingsStore, type SettingsStore } from './settings-store.js';
import { HostedModelProvider, type ModelProvider, type ModelTarget } from './model-provider.js';
import { LocalSettingsStore } from './local-settings-store.js';
import { directConfigFromEnv, DirectModelProvider } from './direct-model-provider.js';
import { createLocalContextLogFlush } from './local-context-log.js';
import { createHttpContextLogFlush } from './http-context-log.js';
import { toNeutralRow } from './neutral-context-row.js';
import type { IngestMessage } from '../context-collector.js';
import { personaFromEnv, type PersonaProvider } from './persona-provider.js';
import { memoryFromEnv, OffMemory, type MemoryProvider } from './memory-provider.js';

export interface SeamOptions {
  env?: NodeJS.ProcessEnv;
  cfg?: DeploymentConfig;
  modelService: { url: string; key: string; timeoutMs: number; primaryTarget: ModelTarget };
  settingsApi: { url: string; token: string };
}

export interface Seams {
  plugs: Plugs;
  settingsStore: SettingsStore;
  modelProvider: ModelProvider;
  /** A model can be called (the model service: key present; direct: validated at construction). */
  modelReady: boolean;
  /** Settings are reachable (the settings service: token present; local: always). */
  settingsReady: boolean;
  /** The memory socket (public build). Always OffMemory when the deployment 'model service' memory plug is selected. */
  memoryProvider: MemoryProvider;
  /** The persona socket (public build). null when the deployment 'model service' model plug is selected: the model service owns the identity there. */
  personaProvider: PersonaProvider | null;
  /** Memory 'off' → local JSONL sink for context-log rows; memory 'model service' → null (cloud-server ships to the model service). */
  localContextLogFlush: ((batch: unknown[]) => Promise<{ inserted: number; skipped: number }>) | null;
  /**
   * The sink the engine's context collector flushes to (public build). Memory 'off' → rows in the neutral
   * shape go to CONTEXT_LOG_URL (https, Bearer CONTEXT_LOG_KEY) when set, else to the local JSONL file;
   * memory 'model service' → null (cloud-server ships to the model service /ingest/discord, unchanged).
   */
  contextLogFlush: ((batch: IngestMessage[]) => Promise<{ inserted: number; skipped: number }>) | null;
}

export function createSeams(opts: SeamOptions): Seams {
  const env = opts.env ?? process.env;
  const plugs = (opts.cfg ?? deployConfig).plugs;
  // The local context-log sink reads its keyword blocklist from the LOCAL settings store, so it only
  // pairs with settings 'local'. Refuse the mismatched pair loudly rather than log rows unfiltered.
  if (plugs.memory === 'off' && plugs.settings !== 'local') {
    throw new Error(`plugs: memory 'off' needs settings 'local' (got '${plugs.settings}') — the local context log reads its keyword blocklist from local settings`);
  }
  const localStore = plugs.settings === 'custom' ? null : new LocalSettingsStore(env.SETTINGS_PATH || './data/settings.json');
  // The memory socket belongs to the public build: the deployment 'model service' memory plug never constructs one.
  const memoryProvider: MemoryProvider = plugs.memory === 'custom' ? new OffMemory() : memoryFromEnv(env);
  const modelProvider: ModelProvider = plugs.model === 'custom'
    ? new HostedModelProvider(opts.modelService.url, opts.modelService.key, opts.modelService.timeoutMs, opts.modelService.primaryTarget)
    : new DirectModelProvider(directConfigFromEnv(env), opts.modelService.timeoutMs, {
        memory: memoryProvider,
        blocklist: () => localStore?.load().memory_filter.keyword_blocklist ?? [],
      }); // throws naming the missing variable
  // The persona socket belongs to the public build too: the deployment never builds one and keeps persona ''.
  const personaProvider: PersonaProvider | null = plugs.model === 'custom'
    ? null
    : personaFromEnv(env, () => localStore?.peekPersona() ?? { text: '', name: '', voice: '' });
  const settingsStore: SettingsStore = localStore ?? new HostedSettingsStore(opts.settingsApi.url, opts.settingsApi.token);
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
  }
  return {
    plugs,
    settingsStore,
    modelProvider,
    modelReady: plugs.model === 'custom' ? Boolean(opts.modelService.key) : true,
    settingsReady: plugs.settings === 'custom' ? Boolean(opts.settingsApi.token) : true,
    memoryProvider,
    personaProvider,
    localContextLogFlush,
    contextLogFlush,
  };
}
