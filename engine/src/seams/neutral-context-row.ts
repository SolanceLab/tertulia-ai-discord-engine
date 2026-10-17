// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * neutral-context-row.ts — the row the PUBLIC context-log sinks write (local JSONL and http).
 * Sanctum's /ingest/discord keeps its own shape (House path, unchanged); this one is for anyone's store.
 *   id         the Discord message id (stable: a re-send of the same message is the same row)
 *   at         ISO 8601 UTC
 *   guild_id / channel_id / channel_name / author_id / author_name / is_bot / content
 *   reply_to   the Discord id of the message this one answers, or null
 *   context    how the reply was made (optional; present only when the engine kept it)
 */
import type { IngestMessage } from '../context-collector.js';

export interface NeutralContextRow {
  id: string;
  at: string;
  guild_id: string | null;
  channel_id: string;
  channel_name: string;
  author_id: string;
  author_name: string;
  is_bot: boolean;
  content: string;
  reply_to: string | null;
  context?: unknown;
}

function isoUtc(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toISOString();
}

export function toNeutralRow(row: IngestMessage): NeutralContextRow {
  return {
    id: row.message_id,
    at: isoUtc(row.timestamp),
    guild_id: row.guild_id ?? null,
    channel_id: row.channel_id,
    channel_name: row.channel_name,
    author_id: row.author_id,
    author_name: row.author_name,
    is_bot: Boolean(row.is_bot),
    content: row.content,
    reply_to: row.reply_to ?? null,
    ...(row.context_log ? { context: row.context_log } : {}),
  };
}
