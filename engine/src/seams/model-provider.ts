// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * model-provider.ts — the seam between the engine and whatever answers its model calls.
 * The public build ships DirectModelProvider (seams/direct-model-provider.ts); any other provider comes from
 * the hooks file's `modelProvider(opts)` when plugs.model is `custom`.
 * `UnconfiguredModelProvider` is the placeholder an engine holds until a real provider is set: every call fails
 * with a reason that names the settings to set.
 */
import { isRetiredError } from './../model-succession.js';
import { logger } from './../logger.js';
import { buildUserContent } from './../presence/window.js';
import type { RecallParam } from './../presence/window.js';
import type { MessageAttachment } from './../attachments.js';

export type ModelTarget = {
  engine: string;
  model: string;
};

// Must exceed the model service's 7s recall cap so the client does not abort a valid
// cloud-fallback result at the same instant the Worker is returning it.
export const CONTEXT_PREPARE_TIMEOUT_MS = 8000;

export interface ModelCallResult {
  ok: boolean;
  text: string;
  status?: number;
  failureReason?: string;
  // The provider says the model itself is gone (410 / end of life) — see model-succession.ts.
  retired?: boolean;
  // §14 recall wiring — whatever the model service's /complete handed back for a
  // requested recall. Absent when recall wasn't requested, the call failed,
  // or the model service's own recall attempt found nothing.
  memoryNodes?: unknown[];
  recallMs?: number;
  // Effective prompt returned by the model service after server-side memory recall was
  // prepended. Older the model service versions omit it; callers fall back to the base.
  systemPrompt?: string;
  // Which engine/model answered. Set by providers that know it (the direct provider);
  // the model service provider leaves them off.
  engine?: string;
  model?: string;
}

export interface PreparedRecallContext {
  systemPrompt: string;
  memoryNodes: unknown[];
  recallMs?: number;
  /** PRIVATE recall texts (the model service full sight) — every draft is checked against them before it is accepted. */
  privateSnippets?: string[];
}

export interface ModelProvider {
  /** True when the provider always calls ONE configured model and ignores the target it is handed:
   *  callers must not walk a fallback chain (it would repeat the same paid request). */
  readonly singleModel?: boolean;
  /** The engine/model that actually runs, for providers with singleModel. */
  readonly identity?: ModelTarget;
  complete(
    target: ModelTarget,
    system: string,
    userContent: string,
    maxTokens: number,
    recall?: RecallParam,
    includeIdentity?: boolean,
    images?: MessageAttachment[],
  ): Promise<ModelCallResult>;
  /** Build memory context once, without generating text. null → caller uses the legacy path. */
  prepare(system: string, recall: RecallParam, channelId?: string | null): Promise<PreparedRecallContext | null>;
  /** Raw completion for chains that build their own request body (away / quiet hours): returns the Response untouched. */
  postComplete(body: unknown, signal: AbortSignal): Promise<Response>;
}

/** What a target is when nobody names one: a single-model provider ignores it, a gateway provider reads PRESENCE_PRIMARY_MODEL instead. */
export const DEFAULT_TARGET: ModelTarget = { engine: 'default', model: 'default' };

export const NO_MODEL_MESSAGE =
  'No model provider is configured. Set MODEL_API_KEY and MODEL_NAME (plugs.model "direct"), or set plugs.model to "custom" and name a hooks file in TERTULIA_HOOKS_PATH that exports modelProvider().';

/** Holds the place of a provider until one is set. Never calls anything. */
export class UnconfiguredModelProvider implements ModelProvider {
  async complete(): Promise<ModelCallResult> { return { ok: false, text: '', failureReason: NO_MODEL_MESSAGE }; }
  async prepare(): Promise<null> { return null; }
  async postComplete(): Promise<Response> { throw new Error(NO_MODEL_MESSAGE); }
}
