// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * model-provider.ts — the seam between the engine and whatever answers its model calls.
 * SanctumModelProvider is the House implementation: POST `${sanctumUrl}/complete`
 * (a raw completion, or a prepare-only recall pass). The fetch code was moved here
 * from PresenceEngine unchanged.
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

// Must exceed Sanctum's 7s recall cap so the client does not abort a valid
// cloud-fallback result at the same instant the Worker is returning it.
export const CONTEXT_PREPARE_TIMEOUT_MS = 8000;

export interface ModelCallResult {
  ok: boolean;
  text: string;
  status?: number;
  failureReason?: string;
  // The provider says the model itself is gone (410 / end of life) — see model-succession.ts.
  retired?: boolean;
  // §14 recall wiring — whatever Sanctum's /complete handed back for a
  // requested recall. Absent when recall wasn't requested, the call failed,
  // or Sanctum's own recall attempt found nothing.
  memoryNodes?: unknown[];
  recallMs?: number;
  // Effective prompt returned by Sanctum after server-side memory recall was
  // prepended. Older Sanctum versions omit it; callers fall back to the base.
  systemPrompt?: string;
  // Which engine/model answered. Set by providers that know it (the direct provider);
  // the Sanctum provider leaves them off.
  engine?: string;
  model?: string;
}

export interface PreparedRecallContext {
  systemPrompt: string;
  memoryNodes: unknown[];
  recallMs?: number;
  /** PRIVATE recall texts (Sanctum full sight) — every draft is checked against them before it is accepted. */
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
  /** Raw completion for chains that build their own request body (away / curfew): returns the Response untouched. */
  postComplete(body: unknown, signal: AbortSignal): Promise<Response>;
}

export class SanctumModelProvider implements ModelProvider {
  private sanctumUrl: string;
  private readonly rawUrl: string;

  constructor(
    sanctumUrl: string,
    private sanctumKey: string,
    private modelTimeoutMs: number,
    private primaryTarget: ModelTarget,
  ) {
    this.rawUrl = sanctumUrl;
    this.sanctumUrl = sanctumUrl.replace(/\/+$/, '');
  }

  postComplete(body: unknown, signal: AbortSignal): Promise<Response> {
    return fetch(`${this.rawUrl}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.sanctumKey}` },
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
    // failure with no status, so sanctumComplete does NOT retry it and moves to the next.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.modelTimeoutMs);
    try {
      // Sanctum lightweight completion. A raw completion (no Room
      // session/memory writes): presence calls must NEVER pollute channel sessions.
      // `recall` (§14) is OPTIONAL and OMITTED entirely when the caller has
      // no meaningful trigger text — never sent as an empty query.
      const r = await fetch(`${this.sanctumUrl}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.sanctumKey}` },
        body: JSON.stringify({
          engine: target.engine,
          model: target.model,
          system,
          // With images this becomes an OpenAI-style multimodal content array.
          // Sanctum's /complete forwards `messages` into the provider body
          // untouched (executeComplete → callNonStreaming), and every engine in
          // the vision chain is provider:'openai-compatible', so the parts
          // reach the model as-is with no Sanctum change required. Image parts
          // lead and the text follows, matching the ordering sanctum's own
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
      logger.info('Presence', timedOut ? 'sanctum model call timed out — failing over' : 'sanctum model call failed', {
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
      const r = await fetch(`${this.sanctumUrl}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.sanctumKey}` },
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
        logger.info('Presence', 'Sanctum context preparation unavailable; using legacy first-attempt recall', {
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
      // where Sanctum runs recall and guards its own reply (Codex, 30 Sep: this failed open).
      if (!Array.isArray(data.private_snippets) || !data.private_snippets.every((x) => typeof x === 'string')) {
        logger.info('Presence', 'Sanctum preparation carried no valid private_snippets list; using guarded legacy path');
        return null;
      }
      if (data.prepared !== true || data.identity_included !== true || typeof data.system_prompt !== 'string') {
        logger.info('Presence', 'Sanctum context preparation did not confirm canonical identity; using identity-required generation');
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
        ? 'Sanctum context preparation timed out; using legacy first-attempt recall'
        : 'Sanctum context preparation failed; using legacy first-attempt recall', {
        timeoutMs: timedOut ? timeoutMs : undefined,
        error: err?.message,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
