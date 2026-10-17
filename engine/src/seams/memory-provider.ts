// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * memory-provider.ts — the engine's memory socket. The engine asks; a service the owner runs answers.
 *   MEMORY=off (default) | http | antechamber
 *   http:        MEMORY_URL (https only) + MEMORY_KEY (Bearer). POST JSON {query, guild_id, channel_id, scope, limit}; reply {items}.
 *   antechamber: ANTECHAMBER_URL [+ ANTECHAMBER_KEY]. GET {url}/antechamber/recall?q=&limit=.
 *
 * EXPERIMENTAL (antechamber): this adapter talks to Antechamber's recall endpoint as of engine commit
 * 9cfbd44 (solance-house; live-tested 17 Oct 2026 against its generic notes + chats shelves) and may change before Antechamber's release. It sends only q and limit, and it
 * reads only the few fields it needs (text / title / excerpt / summary / preview / date / created_at / source / kind,
 * lines[].sender + lines[].message, and the room / thread / server fields the per-server wall needs).
 * Every other field in a reply is ignored; nothing depends on how many results come back, on which
 * service answered, on failure or degraded flags, or on any ranking field.
 * Any failure answers null (no memory this turn). The key and the URL are never logged.
 * The per-server wall and the keyword filter are applied by the engine (presence/memory-wall.ts), not here.
 */
import { logger } from './../logger.js';

export interface MemoryItem {
  text: string;
  date?: string | null;
  source?: string | null;
  server_id?: string | null;
  channel_id?: string | null;
  quotable?: boolean;
}

export interface MemoryQuery {
  query: string;
  guildId: string | null;
  channelId: string | null;
  scope: 'server' | 'private';
  limit?: number;
}

export interface MemoryProvider {
  readonly kind: 'off' | 'http' | 'antechamber';
  /** null = unavailable or nothing asked; the caller carries on without memory. */
  recall(q: MemoryQuery): Promise<{ items: MemoryItem[] } | null>;
  /** Reachability of the service, for the settings page (never throws). */
  ping?(): Promise<boolean>;
}

export const MEMORY_TIMEOUT_MS = 7000;
export const MEMORY_MAX_BYTES = 256 * 1024;
const DEFAULT_LIMIT = 8;

export class OffMemory implements MemoryProvider {
  readonly kind = 'off' as const;
  async recall(): Promise<null> { return null; }
}

type FetchFn = typeof fetch;

/** Fetch with a timeout and a byte cap; returns parsed JSON or null. Logs only a generic note. */
async function fetchJson(fetchImpl: FetchFn, url: string, init: RequestInit, who: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMORY_TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!r.ok) { logger.info('Memory', `${who} memory service answered with an error`, { status: r.status }); return null; }
    const len = Number(r.headers?.get?.('content-length') ?? 0);
    if (len > MEMORY_MAX_BYTES) { logger.info('Memory', `${who} memory reply too large; ignored`); return null; }
    // Count bytes while reading, so a server that omits or understates Content-Length cannot make
    // the bot buffer an unbounded reply (Codex, 16 Oct).
    let text: string;
    if (r.body && typeof (r.body as any).getReader === 'function') {
      const reader = (r.body as ReadableStream<Uint8Array>).getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MEMORY_MAX_BYTES) {
          controller.abort();
          logger.info('Memory', `${who} memory reply too large; ignored`);
          return null;
        }
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString('utf8');
    } else {
      text = await r.text();
      if (Buffer.byteLength(text, 'utf8') > MEMORY_MAX_BYTES) { logger.info('Memory', `${who} memory reply too large; ignored`); return null; }
    }
    return JSON.parse(text);
  } catch (err: any) {
    // err.message can carry the URL: log only the class of failure.
    logger.info('Memory', `${who} memory service unavailable`, { reason: err?.name === 'AbortError' ? 'timeout' : 'request failed' });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

function cleanItems(raw: unknown): MemoryItem[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const text = str(o.text);
    if (!text) continue;
    out.push({
      text,
      date: str(o.date),
      source: str(o.source),
      server_id: o.server_id != null ? String(o.server_id) : null,
      channel_id: o.channel_id != null ? String(o.channel_id) : null,
      ...(o.quotable === true ? { quotable: true } : {}),
    });
  }
  return out;
}

export class HttpMemory implements MemoryProvider {
  readonly kind = 'http' as const;
  constructor(private readonly url: string, private readonly key: string, private readonly fetchImpl: FetchFn = (...a) => fetch(...a)) {
    let u: URL;
    try { u = new URL(url); } catch { throw new Error('MEMORY_URL is not a valid URL'); }
    if (u.protocol !== 'https:') throw new Error('MEMORY_URL must be https');
  }
  async recall(q: MemoryQuery) {
    const data = await fetchJson(this.fetchImpl, this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({ query: q.query, guild_id: q.guildId, channel_id: q.channelId, scope: q.scope, limit: q.limit ?? DEFAULT_LIMIT }),
    }, 'http');
    if (!data || !Array.isArray(data.items)) return null;
    return { items: cleanItems(data.items) };
  }
  async ping() { return (await this.recall({ query: 'ping', guildId: null, channelId: null, scope: 'private', limit: 1 })) !== null; }
}

export class AntechamberMemory implements MemoryProvider {
  readonly kind = 'antechamber' as const;
  private readonly base: string;
  constructor(url: string, private readonly key = '', private readonly fetchImpl: FetchFn = (...a) => fetch(...a)) {
    let u: URL;
    try { u = new URL(url); } catch { throw new Error('ANTECHAMBER_URL is not a valid URL'); }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error('ANTECHAMBER_URL must be https (http allowed for loopback only)');
    this.base = url.replace(/\/+$/, '');
  }
  async recall(q: MemoryQuery) {
    const url = `${this.base}/antechamber/recall?q=${encodeURIComponent(q.query)}&limit=${q.limit ?? DEFAULT_LIMIT}`;
    const data = await fetchJson(this.fetchImpl, url, {
      method: 'GET',
      headers: this.key ? { authorization: `Bearer ${this.key}` } : {},
    }, 'antechamber');
    if (!data) return null;
    const winners = Array.isArray(data.winners) ? data.winners : Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : null;
    if (!winners) return null;
    return { items: mapWinners(winners, q.guildId) };
  }
  async ping() { return (await this.recall({ query: 'ping', guildId: null, channelId: null, scope: 'private', limit: 1 })) !== null; }
}

/**
 * Antechamber winners → MemoryItems. A winner carrying `lines` is a chat window; the rest are notes of some kind.
 * Tested against the engine at solance-house 9cfbd44 (generic notes + chats shelves): every winner has `kind: "item"`, so the shape (lines / text) decides, never kind.
 * Tolerant by design (EXPERIMENTAL adapter): unknown fields are ignored, a winner with no readable text is skipped.
 */
export function mapWinners(winners: unknown[], guildId: string | null): MemoryItem[] {
  const out: MemoryItem[] = [];
  for (const w of winners) {
    if (!w || typeof w !== 'object') continue;
    const o = w as Record<string, any>;
    const kind = typeof o.kind === 'string' ? o.kind.toLowerCase() : '';
    const lines = Array.isArray(o.lines) ? o.lines : null;
    if (lines) {
      const text = lines
        .map((l: any) => (l && typeof l.message === 'string' && l.message.trim() ? `${str(l.sender) ?? 'someone'}: ${l.message}` : ''))
        .filter(Boolean).join('\n');
      if (text) {
      const room = str(o.room);
      const isDiscord = !!room && room.toLowerCase() === 'discord';
      const thread = o.thread != null ? String(o.thread) : null;
      const server = o.server_id != null ? String(o.server_id) : o.guild_id != null ? String(o.guild_id) : null;
      out.push({
        text, date: str(o.date) ?? str(o.created_at), source: room ?? str(o.source) ?? (kind || null),
        server_id: isDiscord ? server : null,
        channel_id: isDiscord ? thread : null,
        // Quotable only for a same-server Discord item (the wall and the block re-check this).
        ...(isDiscord && guildId && server === guildId ? { quotable: true } : {}),
      });
      continue;
      }
    }
    const text = str(o.text) ?? str(o.excerpt) ?? str(o.summary) ?? str(o.preview) ?? str(o.title);
    if (!text) continue;
    out.push({ text, date: str(o.date) ?? str(o.created_at), source: str(o.source) ?? (kind || null) });
  }
  return out;
}

/** Read MEMORY / MEMORY_URL / ... Throws a clear startup error for a half-configured plug. */
export function memoryFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchFn): MemoryProvider {
  const kind = (env.MEMORY || 'off').trim().toLowerCase();
  if (kind === 'off' || kind === '') return new OffMemory();
  if (kind === 'http') {
    if (!env.MEMORY_URL) throw new Error('MEMORY_URL is required (MEMORY=http)');
    return new HttpMemory(env.MEMORY_URL, env.MEMORY_KEY || '', fetchImpl);
  }
  if (kind === 'antechamber') {
    if (!env.ANTECHAMBER_URL) throw new Error('ANTECHAMBER_URL is required (MEMORY=antechamber)');
    return new AntechamberMemory(env.ANTECHAMBER_URL, env.ANTECHAMBER_KEY || '', fetchImpl);
  }
  throw new Error(`MEMORY must be 'off', 'http' or 'antechamber' (got '${env.MEMORY}')`);
}
