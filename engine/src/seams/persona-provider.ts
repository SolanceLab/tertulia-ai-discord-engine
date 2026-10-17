// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * persona-provider.ts — the persona socket (public build). Where the bot's persona text comes from:
 *   PERSONA=page (default)  the settings page / settings file; editable, and agent-editable
 *   PERSONA=file            PERSONA_FILE, re-read whenever its modified time changes; read-only
 *   PERSONA=url             PERSONA_URL (https) with PERSONA_KEY as a Bearer; cached, refreshed every
 *                           10 minutes, the last good text kept on failure; read-only
 * The House build never uses this: it keeps persona '' and Sanctum's identity, byte for byte.
 */
import { createHash } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../logger.js';

export type PersonaSource = 'page' | 'file' | 'url';

export interface PersonaState {
  text: string;
  source: PersonaSource;
  /** True only for the page source: the owner (and the companion's tools) may edit it. */
  editable: boolean;
  /** Short fingerprint of the text, so a caller can tell when it changed. */
  version: string;
}

export interface PersonaProvider {
  readonly source: PersonaSource;
  get(): Promise<PersonaState>;
}

/** The three fields the settings page edits. */
export interface PersonaFields { text: string; name: string; voice: string }

export const PERSONA_TIMEOUT_MS = 7000;
export const PERSONA_VOICE_MAX = 2000;
export const PERSONA_TEXT_MAX = 8000;
export const PERSONA_NAME_MAX = 80;
export const PERSONA_MAX_BYTES = 64 * 1024;
export const PERSONA_REFRESH_MS = 10 * 60_000;
/** After a failed refresh, wait this long before trying again (the last good text keeps serving). */
export const PERSONA_RETRY_MS = 60_000;

type FetchFn = typeof fetch;

const versionOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const state = (text: string, source: PersonaSource): PersonaState => ({ text, source, editable: source === 'page', version: versionOf(text) });

/** The persona text the model sees when the fields come from the page. Empty fields add nothing. */
export function composePersona(f: PersonaFields): string {
  const parts: string[] = [];
  if (f.name.trim()) parts.push(`Your name is ${f.name.trim()}.`);
  if (f.text.trim()) parts.push(f.text.trim());
  if (f.voice.trim()) parts.push(`How you talk:\n${f.voice.trim()}`);
  return parts.join('\n\n');
}

export class PagePersona implements PersonaProvider {
  readonly source = 'page' as const;
  constructor(private readonly read: () => PersonaFields) {}
  async get(): Promise<PersonaState> { return state(composePersona(this.read()), 'page'); }
}

export class FilePersona implements PersonaProvider {
  readonly source = 'file' as const;
  private path: string;
  private mtime = -1;
  private last = '';
  constructor(path: string) { this.path = resolve(path); }
  async get(): Promise<PersonaState> {
    try {
      const m = statSync(this.path).mtimeMs;
      if (m !== this.mtime) {
        const buf = readFileSync(this.path);
        this.last = buf.subarray(0, PERSONA_MAX_BYTES).toString('utf8').trim();
        this.mtime = m;
      }
    } catch (err: any) {
      // Keep the last good text; log the class of failure, not the path.
      logger.warn('Persona', 'persona file unreadable — keeping the last good text', { reason: err?.code ?? 'error' });
    }
    return state(this.last, 'file');
  }
}

export class UrlPersona implements PersonaProvider {
  readonly source = 'url' as const;
  private last = '';
  private loaded = false;
  private fetchedAt = 0;
  private retryAt = 0;
  private inflight: Promise<void> | null = null;
  constructor(
    private readonly url: string,
    private readonly key: string,
    private readonly fetchImpl: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<PersonaState> {
    const t = this.now();
    const stale = !this.loaded || t - this.fetchedAt >= PERSONA_REFRESH_MS;
    if (stale && t >= this.retryAt) {
      const run = this.refresh();
      // First load waits for the answer; a refresh runs behind the cached text.
      if (!this.loaded) await run;
    }
    return state(this.last, 'url');
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchOnce().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async fetchOnce(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PERSONA_TIMEOUT_MS);
    try {
      // redirect:'error' so the key can never follow a redirect to another host.
      const r = await this.fetchImpl(this.url, {
        headers: { ...(this.key ? { authorization: `Bearer ${this.key}` } : {}), accept: 'text/plain, application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!r.ok) throw new FetchNote(`status ${r.status}`);
      const len = Number(r.headers?.get?.('content-length') ?? 0);
      if (len > PERSONA_MAX_BYTES) throw new FetchNote('too large');
      let text: string;
      if (r.body && typeof (r.body as any).getReader === 'function') {
        const reader = (r.body as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > PERSONA_MAX_BYTES) { controller.abort(); throw new FetchNote('too large'); }
          chunks.push(value);
        }
        text = Buffer.concat(chunks).toString('utf8');
      } else {
        text = await r.text();
        if (Buffer.byteLength(text, 'utf8') > PERSONA_MAX_BYTES) throw new FetchNote('too large');
      }
      const ctype = r.headers?.get?.('content-type') ?? '';
      if (/json/i.test(ctype)) {
        const j = JSON.parse(text);
        const t = typeof j === 'string' ? j : typeof j?.text === 'string' ? j.text : typeof j?.persona === 'string' ? j.persona : null;
        if (t === null) throw new FetchNote('unrecognised reply');
        text = t;
      }
      this.last = text.trim();
      this.loaded = true;
      this.fetchedAt = this.now();
      this.retryAt = 0;
    } catch (err: any) {
      // err.message can carry the URL: log only the class of failure.
      const reason = err instanceof FetchNote ? err.message : err?.name === 'AbortError' ? 'timeout' : 'request failed';
      logger.warn('Persona', 'persona service unavailable — keeping the last good text', { reason });
      this.retryAt = this.now() + PERSONA_RETRY_MS;
      this.loaded = this.loaded || false;
    } finally {
      clearTimeout(timer);
    }
  }
}

class FetchNote extends Error {}

/** Read PERSONA / PERSONA_FILE / PERSONA_URL / PERSONA_KEY. Throws a clear startup error for a half-configured socket. */
export function personaFromEnv(env: NodeJS.ProcessEnv, readPage: () => PersonaFields, fetchImpl?: FetchFn): PersonaProvider {
  const kind = (env.PERSONA || 'page').trim().toLowerCase();
  if (kind === 'page' || kind === '') return new PagePersona(readPage);
  if (kind === 'file') {
    if (!env.PERSONA_FILE) throw new Error('PERSONA_FILE is required (PERSONA=file)');
    return new FilePersona(env.PERSONA_FILE);
  }
  if (kind === 'url') {
    if (!env.PERSONA_URL) throw new Error('PERSONA_URL is required (PERSONA=url)');
    let u: URL;
    try { u = new URL(env.PERSONA_URL); } catch { throw new Error('PERSONA_URL is not a valid address'); }
    if (u.protocol !== 'https:') throw new Error('PERSONA_URL must be an https address');
    return new UrlPersona(env.PERSONA_URL, env.PERSONA_KEY || '', fetchImpl);
  }
  throw new Error(`PERSONA must be 'page', 'file' or 'url' (got '${env.PERSONA}')`);
}
