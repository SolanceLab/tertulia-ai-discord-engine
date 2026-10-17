// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * direct-model-provider.ts — the public ModelProvider: calls a model API directly, no Sanctum.
 *   MODEL_PROVIDER  'openai-compatible' (default) | 'anthropic'
 *   MODEL_BASE_URL  e.g. https://api.openai.com/v1  (anthropic default: https://api.anthropic.com)
 *   MODEL_API_KEY   required
 *   MODEL_NAME      required by the API; the chain's per-target model names are ignored
 * Memory: off by default (prepare() hands the system prompt back untouched, nothing is sent anywhere).
 * With a MemoryProvider (MEMORY=http|antechamber) prepare() recalls, applies the engine's own
 * per-server wall and keyword filter, and appends a "What you remember" block.
 */
import { isRetiredError } from './../model-succession.js';
import { logger } from './../logger.js';
import { buildUserContent } from './../presence/window.js';
import type { RecallParam } from './../presence/window.js';
import type { MessageAttachment } from './../attachments.js';
import type { MemoryProvider } from './memory-provider.js';
import { applyServerWall, applyMemoryFilter, buildMemoryBlock } from './../presence/memory-wall.js';
import type { PreparedRecallContext, ModelProvider, ModelCallResult, ModelTarget } from './model-provider.js';

export type DirectKind = 'openai-compatible' | 'anthropic';

export interface DirectModelConfig {
  kind: DirectKind;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Read the MODEL_* env. Throws a clear startup error naming the missing variable. */
export function directConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DirectModelConfig {
  const raw = (env.MODEL_PROVIDER || 'openai-compatible').trim().toLowerCase();
  if (raw !== 'openai-compatible' && raw !== 'anthropic') {
    throw new Error(`MODEL_PROVIDER must be 'openai-compatible' or 'anthropic' (got '${env.MODEL_PROVIDER}')`);
  }
  const apiKey = env.MODEL_API_KEY || '';
  if (!apiKey) throw new Error('MODEL_API_KEY is required (the direct model plug is selected)');
  const model = env.MODEL_NAME || '';
  if (!model) throw new Error('MODEL_NAME is required (the direct model plug is selected)');
  const baseUrl = (env.MODEL_BASE_URL || (raw === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, '');
  return { kind: raw, baseUrl, apiKey, model };
}

type ChatMessage = { role: string; content: unknown };

export interface DirectMemoryOptions {
  memory?: MemoryProvider | null;
  /** The keyword blocklist, read per call so edits on the settings page apply at once. */
  blocklist?: () => string[];
  /** channel id -> guild id from the bot's own channel cache (set once the Discord client exists). */
  channelGuildOf?: (channelId: string) => string | null | undefined;
}

export class DirectModelProvider implements ModelProvider {
  readonly singleModel = true;
  readonly identity: ModelTarget;
  private memory: MemoryProvider | null;
  private blocklist: () => string[];
  private channelGuildOf: (channelId: string) => string | null | undefined;
  constructor(private readonly cfg: DirectModelConfig, private readonly modelTimeoutMs = 30000, mem: DirectMemoryOptions = {}) {
    this.identity = { engine: cfg.kind, model: cfg.model };
    this.memory = mem.memory && mem.memory.kind !== 'off' ? mem.memory : null;
    this.blocklist = mem.blocklist ?? (() => []);
    this.channelGuildOf = mem.channelGuildOf ?? (() => null);
  }

  setChannelGuildResolver(fn: (channelId: string) => string | null | undefined) { this.channelGuildOf = fn; }

  private anthropicContent(userContent: string, images: MessageAttachment[]): string | unknown[] {
    if (!images.length) return userContent;
    const parts: unknown[] = images.map((i) => ({ type: 'image', source: { type: 'url', url: i.url } }));
    const built = buildUserContent(userContent, images);
    const text = Array.isArray(built) ? (built[built.length - 1] as { text?: string }).text ?? userContent : userContent;
    parts.push({ type: 'text', text });
    return parts;
  }

  /** One raw HTTP call. Returns the Response untouched. */
  private send(system: string, messages: ChatMessage[], maxTokens: number, signal: AbortSignal): Promise<Response> {
    const { kind, baseUrl, apiKey, model } = this.cfg;
    if (kind === 'anthropic') {
      return fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages }),
        signal,
      });
    }
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, ...messages] }),
      signal,
    });
  }

  /** Pull the reply text out of a successful response body. Anthropic: ALL text blocks, joined. */
  private extractText(data: any): string {
    if (this.cfg.kind === 'anthropic') {
      const blocks = Array.isArray(data?.content) ? data.content : [];
      return blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('');
    }
    const c = data?.choices?.[0]?.message?.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter((p: any) => typeof p?.text === 'string').map((p: any) => p.text).join('');
    return '';
  }

  async complete(
    _target: ModelTarget,
    system: string,
    userContent: string,
    maxTokens: number,
    _recall?: RecallParam,
    _includeIdentity = false,
    images: MessageAttachment[] = [],
  ): Promise<ModelCallResult> {
    const content = this.cfg.kind === 'anthropic' ? this.anthropicContent(userContent, images) : buildUserContent(userContent, images);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.modelTimeoutMs);
    const id = { engine: this.cfg.kind, model: this.cfg.model };
    try {
      const r = await this.send(system, [{ role: 'user', content }], maxTokens, controller.signal);
      if (!r.ok) {
        const errText = await Promise.resolve().then(() => r.text()).then((t) => String(t).slice(0, 2000)).catch(() => '');
        const retired = isRetiredError(errText);
        return {
          ok: false, text: '', status: r.status, ...id,
          failureReason: retired ? 'model retired by the provider' : 'provider rejected the request',
          ...(retired ? { retired: true } : {}),
        };
      }
      const data = await r.json();
      return { ok: true, text: this.extractText(data), status: r.status, ...id };
    } catch (err: any) {
      const timedOut = err?.name === 'AbortError';
      logger.info('Presence', timedOut ? 'direct model call timed out — failing over' : 'direct model call failed', {
        ...id, timeoutMs: timedOut ? this.modelTimeoutMs : undefined, error: err?.message,
      });
      return {
        ok: false, text: '', ...id,
        failureReason: timedOut ? `timed out after ${this.modelTimeoutMs / 1000}s` : 'request failed before a response',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Memory off: the system prompt goes through unchanged. Memory on: recall -> wall -> filter -> block. */
  async prepare(system: string, recall: RecallParam, channelId: string | null = null): Promise<PreparedRecallContext | null> {
    if (!this.memory) return { systemPrompt: system, memoryNodes: [], privateSnippets: [] };
    const started = Date.now();
    const scope = recall.scope === 'private' ? 'private' : 'server';
    const guildId = recall.guild_id ?? null;
    let answer: Awaited<ReturnType<MemoryProvider['recall']>> = null;
    try {
      answer = await this.memory.recall({ query: recall.query, guildId, channelId, scope });
    } catch {
      answer = null; // a memory failure never costs the reply
    }
    if (!answer) return { systemPrompt: system, memoryNodes: [], privateSnippets: [] };
    const wall = { scope, guildId, channelGuildOf: this.channelGuildOf } as const;
    const items = applyMemoryFilter(applyServerWall(answer.items, wall), this.blocklist());
    const built = buildMemoryBlock(items, wall);
    if (!built) return { systemPrompt: system, memoryNodes: [], privateSnippets: [], recallMs: Date.now() - started };
    return {
      systemPrompt: `${system}\n\n${built.block}`,
      memoryNodes: items.slice(0, built.count),
      privateSnippets: built.privateSnippets,
      recallMs: Date.now() - started,
    };
  }

  /**
   * Chains that build their own Sanctum-shaped body ({system, messages, max_tokens}) — away, curfew,
   * scene catch — get a Response whose JSON is {text}, exactly what they read from Sanctum.
   * The body's engine/model/recall/include_identity are ignored.
   */
  async postComplete(body: unknown, signal: AbortSignal): Promise<Response> {
    const b = (body && typeof body === 'object' ? body : {}) as { system?: string; messages?: ChatMessage[]; max_tokens?: number };
    const messages = (b.messages ?? []).filter((m) => m.role !== 'system');
    const r = await this.send(b.system ?? '', messages, b.max_tokens ?? 300, signal);
    if (!r.ok) return r;
    const text = this.extractText(await r.json());
    return new Response(JSON.stringify({ text }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
}
