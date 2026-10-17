// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * http-context-log.ts — context-log rows go to a service the owner runs.
 *   CONTEXT_LOG_URL (https only) + CONTEXT_LOG_KEY (sent as a Bearer token, optional).
 *   POST JSON {rows: [...]} where each row is the neutral shape (neutral-context-row.ts).
 * Drop-on-failure, like Sanctum's sink: a failed or slow call loses that batch, never retries, never blocks the bot.
 * The URL and the key are never logged.
 */
import { logger } from '../logger.js';

export const CONTEXT_LOG_HTTP_TIMEOUT_MS = 10_000;

type FetchFn = typeof fetch;

export function createHttpContextLogFlush(
  url: string,
  key: string = '',
  getBlocklist: () => string[] = () => [],
  fetchImpl: FetchFn = (...a) => fetch(...a),
  timeoutMs: number = CONTEXT_LOG_HTTP_TIMEOUT_MS,
): (batch: unknown[]) => Promise<{ inserted: number; skipped: number }> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('CONTEXT_LOG_URL is not a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('CONTEXT_LOG_URL must be https');
  return async (batch) => {
    // keyword_blocklist: a row whose content contains any listed keyword is never sent.
    let blocked: string[] = [];
    try { blocked = getBlocklist().map((k) => k.toLowerCase()).filter(Boolean); } catch { blocked = []; }
    const kept = blocked.length
      ? batch.filter((row) => { const t = JSON.stringify(row).toLowerCase(); return !blocked.some((k) => t.includes(k)); })
      : batch;
    if (!kept.length) return { inserted: 0, skipped: batch.length };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ rows: kept }),
        signal: controller.signal,
      });
      if (!r.ok) {
        logger.info('ContextLog', 'context log service answered with an error — batch dropped', { status: r.status });
        return { inserted: 0, skipped: batch.length };
      }
      return { inserted: kept.length, skipped: batch.length - kept.length };
    } catch (err: any) {
      // err.message can carry the URL: log only the class of failure.
      logger.info('ContextLog', 'context log service unavailable — batch dropped', { reason: err?.name === 'AbortError' ? 'timeout' : 'request failed' });
      return { inserted: 0, skipped: batch.length };
    } finally {
      clearTimeout(timer);
    }
  };
}
