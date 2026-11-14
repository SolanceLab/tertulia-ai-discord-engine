// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * status-edit.ts — the one place the bot's custom status line is read and changed.
 * The bot-secret routes behind the status tools and the Mac server's direct mode both call these,
 * so a refusal or a saved value is the same everywhere. The text lives in the settings store;
 * until one is set, the deployment's identity `custom_status` is what shows.
 */
import type { SettingsStore } from './seams/settings-store.js';

export const STATUS_MAX = 128; // Discord's limit for a custom status

export class StatusEditError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

export interface StatusView { text: string; is_default: boolean }

const NOT_HERE = 'settings are managed outside this bot for this setup';

/** Plain text: line breaks and other control characters become spaces, then trimmed. null = go back to the default. */
export function cleanStatus(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'string') throw new StatusEditError(400, 'text must be text');
  const t = input.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  if (t === '') return null;
  if ([...t].length > STATUS_MAX) throw new StatusEditError(400, `text is too long (max ${STATUS_MAX})`);
  return t;
}

export async function readStatus(store: SettingsStore, fallback: string): Promise<StatusView> {
  if (!store.getCustomStatus) throw new StatusEditError(501, NOT_HERE);
  const stored = await store.getCustomStatus();
  return stored ? { text: stored, is_default: false } : { text: fallback, is_default: true };
}

/** Save the text (empty/null clears it), then hand the new effective text to `applyLive` so the bot shows it at once. */
export async function setStatus(store: SettingsStore, input: unknown, fallback: string, applyLive?: (text: string) => void): Promise<StatusView> {
  if (!store.setCustomStatus) throw new StatusEditError(501, NOT_HERE);
  const next = cleanStatus(input);
  await store.setCustomStatus(next);
  const view: StatusView = next ? { text: next, is_default: false } : { text: fallback, is_default: true };
  applyLive?.(view.text);
  return view;
}
