// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * fixtures/gateway-providers.ts — TEST FIXTURE ONLY. A model provider and a settings store that speak to an
 * HTTP gateway (POST /complete, GET/PUT /routine/...). The engine does not ship them: a deployment that wants a
 * gateway supplies its own through the hooks file. The tests use these to drive the engine's own code paths
 * (retired-model detection, prepare-only recall, the settings routes) against a fake fetch.
 * `installGatewayDefaults()` makes them the engine's default model provider and settings store.
 */
import { isRetiredError } from '../model-succession.js';
import { logger } from '../logger.js';
import { buildUserContent } from '../presence/window.js';
import type { RecallParam } from '../presence/window.js';
import type { MessageAttachment } from '../attachments.js';
import { type PreparedRecallContext, type ModelProvider, type ModelCallResult, type ModelTarget, CONTEXT_PREPARE_TIMEOUT_MS } from '../seams/model-provider.js';
import type { SettingsStore } from '../seams/settings-store.js';
import { setDefaultSettingsStoreFactory, setDefaultModelProviderFactory } from '../seams/defaults.js';

/** The gateway's own route paths and key names (it keeps older names than the engine does). */
export const GATEWAY_ROUTES = Object.freeze({
  quietHours: '/routine/curfew',
  quietHoursEvent: '/routine/curfew-event',
});

const WIRE_KEYS: Readonly<Record<string, string>> = Object.freeze({
  quiet_hours: 'curfew', quiet_hours_events: 'curfew_events', quiet_hours_stickers: 'curfew_stickers',
  focus: 'scene', focus_sighting: 'scene_sighting', focus_sightings: 'scene_sightings', agent_window: 'study',
});

/** A body for the gateway: the engine's keys turned back into the names it knows. */
export function toGatewayWire<T = any>(body: T): T {
  if (Array.isArray(body)) return body.map(toGatewayWire) as unknown as T;
  if (!body || typeof body !== 'object') return body;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(body as Record<string, any>)) out[WIRE_KEYS[k] ?? k] = toGatewayWire(v);
  return out as T;
}

export type TokenSource = string | (() => string | undefined);

export class GatewayModelProvider implements ModelProvider {
  private modelServiceUrl: string;
  private readonly rawUrl: string;

  constructor(
    modelServiceUrl: string,
    private modelServiceKey: string,
    private modelTimeoutMs: number,
    private primaryTarget: ModelTarget,
  ) {
    this.rawUrl = modelServiceUrl;
    this.modelServiceUrl = modelServiceUrl.replace(/\/+$/, '');
  }

  postComplete(body: unknown, signal: AbortSignal): Promise<Response> {
    return fetch(`${this.rawUrl}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.modelServiceKey}` },
      body: JSON.stringify(body),
      signal,
    });
  }

  async complete(
    target: ModelTarget,
    system: string,
    userContent: string,
    maxTokens: number,
    recall?: RecallParam,
    includeIdentity = false,
    images: MessageAttachment[] = [],
  ): Promise<ModelCallResult> {
    // Per-call timeout so a hung/throttled engine fails FAST to the next in the chain
    // instead of stalling (prod 2026-07-05: a throttled NVIDIA call hung ~2min, and the
    // GLM→DeepSeek→Kimi chain stacked to ~3.5min for one reply). On timeout → treat as a
    // failure with no status, so modelComplete does NOT retry it and moves to the next.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.modelTimeoutMs);
    try {
      // the model service lightweight completion. A raw completion (no Room
      // session/memory writes): presence calls must NEVER pollute channel sessions.
      // `recall` is OPTIONAL and OMITTED entirely when the caller has
      // no meaningful trigger text — never sent as an empty query.
      const r = await fetch(`${this.modelServiceUrl}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.modelServiceKey}` },
        body: JSON.stringify({
          engine: target.engine,
          model: target.model,
          system,
          // With images this becomes an OpenAI-style multimodal content array.
          // the model service's /complete forwards `messages` into the provider body
          // untouched (executeComplete → callNonStreaming), and every engine in
          // the vision chain is provider:'openai-compatible', so the parts
          // reach the model as-is with no the model service change required. Image parts
          // lead and the text follows, matching the ordering model service's own
          // proven multimodal builder uses (context.js:610-612).
          messages: [{ role: 'user', content: buildUserContent(userContent, images) }],
          max_tokens: maxTokens,
          ...(includeIdentity ? { include_identity: true } : {}),
          ...(recall ? { recall } : {}),
        }),
        signal: controller.signal,
      });
      if (!r.ok) {
        // Read the error so a RETIRED model can be told apart from a failing
        // one (model-succession.ts). Bounded, and never allowed to throw.
        const errText = await Promise.resolve().then(() => r.text()).then((t) => String(t).slice(0, 2000)).catch(() => '');
        const retired = isRetiredError(errText);
        return {
          ok: false,
          text: '',
          status: r.status,
          failureReason: retired ? 'model retired by the provider' : 'provider rejected the request',
          ...(retired ? { retired: true } : {}),
        };
      }
      const data = (await r.json()) as { text?: string; memory_nodes?: unknown[]; recall_ms?: number; system_prompt?: string };
      return {
        ok: true,
        text: data.text || '',
        status: r.status,
        memoryNodes: data.memory_nodes,
        recallMs: data.recall_ms,
        systemPrompt: data.system_prompt,
      };
    } catch (err: any) {
      const timedOut = err?.name === 'AbortError';
      logger.info('Presence', timedOut ? 'model service model call timed out — failing over' : 'model service model call failed', {
        engine: target.engine,
        model: target.model,
        timeoutMs: timedOut ? this.modelTimeoutMs : undefined,
        error: err?.message,
      });
      return {
        ok: false,
        text: '',
        failureReason: timedOut
          ? `timed out after ${this.modelTimeoutMs / 1000}s`
          : 'request failed before a response',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Build memory context once, without generating text. Every model attempt
   * then receives this exact prompt, so a fallback is never context-blind. */
  async prepare(
    system: string,
    recall: RecallParam,
  ): Promise<PreparedRecallContext | null> {
    const controller = new AbortController();
    const timeoutMs = Math.min(this.modelTimeoutMs, CONTEXT_PREPARE_TIMEOUT_MS);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(`${this.modelServiceUrl}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.modelServiceKey}` },
        body: JSON.stringify({
          engine: this.primaryTarget.engine,
          model: this.primaryTarget.model,
          system,
          recall,
          prepare_only: true,
          include_identity: true,
        }),
        signal: controller.signal,
      });
      if (!r.ok) {
        logger.info('Presence', 'the model service context preparation unavailable; using legacy first-attempt recall', {
          status: r.status,
        });
        return null;
      }
      const data = (await r.json()) as {
        prepared?: boolean;
        system_prompt?: string;
        memory_nodes?: unknown[];
        recall_ms?: number;
        identity_included?: boolean;
        private_snippets?: unknown[];
      };
      // Full sight: the prepared prompt may contain PRIVATE recall. Without a valid private list the
      // draft guard below would have nothing to check against — reject it and take the legacy path,
      // where the model service runs recall and guards its own reply (Codex, 30 Sep: this failed open).
      if (!Array.isArray(data.private_snippets) || !data.private_snippets.every((x) => typeof x === 'string')) {
        logger.info('Presence', 'the model service preparation carried no valid private_snippets list; using guarded legacy path');
        return null;
      }
      if (data.prepared !== true || data.identity_included !== true || typeof data.system_prompt !== 'string') {
        logger.info('Presence', 'the model service context preparation did not confirm canonical identity; using identity-required generation');
        return null;
      }
      return {
        systemPrompt: data.system_prompt,
        memoryNodes: data.memory_nodes ?? [],
        recallMs: data.recall_ms,
        privateSnippets: data.private_snippets as string[],
      };
    } catch (err: any) {
      const timedOut = err?.name === 'AbortError';
      logger.info('Presence', timedOut
        ? 'the model service context preparation timed out; using legacy first-attempt recall'
        : 'the model service context preparation failed; using legacy first-attempt recall', {
        timeoutMs: timedOut ? timeoutMs : undefined,
        error: err?.message,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}


export class GatewaySettingsStore implements SettingsStore {
  private readonly base: string;
  constructor(base: string, private readonly token: TokenSource) {
    this.base = base;
  }

  private bearer(): string {
    return typeof this.token === 'function' ? (this.token() ?? '') : this.token;
  }

  getPresenceConfig(signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.base}/routine/discord`, {
      headers: { Authorization: `Bearer ${this.bearer()}` },
      signal,
    });
  }

  putPresenceConfig(body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.base}/routine/discord`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.bearer()}` },
      body: JSON.stringify(toGatewayWire(body)),   // the hosted API still speaks the earlier key names
      signal,
    });
  }

  getQuietHours(signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.base}${GATEWAY_ROUTES.quietHours}`, {
      headers: { Authorization: `Bearer ${this.bearer()}` },
      signal,
    });
  }

  getAwayStatus(signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.base}/routine/away-status`, {
      headers: { Authorization: `Bearer ${this.bearer()}` },
      signal,
    });
  }

  postQuietHoursEvent(body: unknown): Promise<Response> {
    return fetch(`${this.base}${GATEWAY_ROUTES.quietHoursEvent}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.bearer()}` },
      body: JSON.stringify(body),
    });
  }
}


/** Make the gateway classes the engine's default provider and store (tests that drive the engine with a fake fetch). */
export function installGatewayDefaults(): void {
  setDefaultModelProviderFactory((url, key, timeoutMs, primary) => new GatewayModelProvider(url, key, timeoutMs, primary));
  setDefaultSettingsStoreFactory((base, token) => new GatewaySettingsStore(base, token));
}
