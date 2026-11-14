// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * seams/defaults.ts — what a class holds when nobody handed it a model provider or a settings store.
 * The engine always hands one over (cloud-server.ts builds both through createSeams); these defaults exist so
 * a class built on its own never reaches a hosted service: the model default fails with a message naming the
 * settings to set, the settings default is the local file store.
 * Tests may swap the defaults (fixtures/gateway-providers.ts) to drive the engine against a fake gateway.
 */
import { type ModelProvider, UnconfiguredModelProvider, type ModelTarget } from './model-provider.js';
import type { SettingsStore } from './settings-store.js';
import { LocalSettingsStore } from './local-settings-store.js';

export type ModelProviderFactory = (url: string, key: string, timeoutMs: number, primary: ModelTarget) => ModelProvider;
export type SettingsStoreFactory = (base: string, token: string | (() => string | undefined)) => SettingsStore;

let modelFactory: ModelProviderFactory | null = null;
let settingsFactory: SettingsStoreFactory | null = null;

export function setDefaultModelProviderFactory(f: ModelProviderFactory | null): void { modelFactory = f; }
export function setDefaultSettingsStoreFactory(f: SettingsStoreFactory | null): void { settingsFactory = f; }

export function defaultModelProvider(url: string, key: string, timeoutMs: number, primary: ModelTarget): ModelProvider {
  return modelFactory ? modelFactory(url, key, timeoutMs, primary) : new UnconfiguredModelProvider();
}

export function defaultSettingsStore(base: string, token: string | (() => string | undefined)): SettingsStore {
  return settingsFactory ? settingsFactory(base, token) : new LocalSettingsStore();
}
