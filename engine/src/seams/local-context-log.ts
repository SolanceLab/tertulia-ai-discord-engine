// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * local-context-log.ts — memory 'off': context-log rows go to a local JSONL file
 * (env CONTEXT_LOG_PATH, default ./data/context-log.jsonl), newest 2000 lines kept,
 * instead of Sanctum's /ingest/discord. Same row shape (IngestMessage incl. context_log).
 * Writes are serialised and atomic (temp + rename).
 */
import { mkdirSync, writeFileSync, existsSync, renameSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';

export const CONTEXT_LOG_CAP = 2000;

export function createLocalContextLogFlush(
  path: string = process.env.CONTEXT_LOG_PATH || './data/context-log.jsonl',
  cap: number = CONTEXT_LOG_CAP,
  getBlocklist: () => string[] = () => [],
): (batch: unknown[]) => Promise<{ inserted: number; skipped: number }> {
  const file = resolve(path);
  let chain: Promise<unknown> = Promise.resolve();
  return (batch) => {
    const run = chain.then(() => {
      // keyword_blocklist: a row whose content contains any listed keyword is never stored.
      let blocked: string[] = [];
      try { blocked = getBlocklist().map((k) => k.toLowerCase()).filter(Boolean); } catch { blocked = []; }
      const kept = blocked.length
        ? batch.filter((row) => { const t = JSON.stringify(row).toLowerCase(); return !blocked.some((k) => t.includes(k)); })
        : batch;
      if (!kept.length) return { inserted: 0, skipped: batch.length };
      let existing: string[] = [];
      try {
        if (existsSync(file)) existing = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      } catch (err: any) {
        logger.error('ContextLog', 'local context log unreadable — starting it fresh', { path: file, error: err?.message });
      }
      const lines = existing.concat(kept.map((row) => JSON.stringify(row))).slice(-cap);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      writeFileSync(tmp, lines.join('\n') + '\n');
      renameSync(tmp, file);
      return { inserted: kept.length, skipped: batch.length - kept.length };
    });
    chain = run.catch(() => undefined);
    return run;
  };
}
