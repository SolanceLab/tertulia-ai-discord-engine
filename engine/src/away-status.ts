// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * away-status.ts — tiny client for the owner's live away status (Plan 2b Task 3 Step 1).
 * Mirrors presence-config.ts's fetch/timeout/fallback shape: an AbortController
 * timeout, and NEVER throws — any failure (non-ok, throw, timeout) degrades to
 * `null` so the away branch's caller can treat it as "not away, say nothing"
 * (§ Global Constraints — "an away-status fetch failure degrades to 'not away'").
 */
import { logger } from './logger.js';
import { SolanceApiSettingsStore, type SettingsStore } from './seams/settings-store.js';

export interface AwayStatus {
  away: boolean;
  source: string;
  status: string;
  reason: string;
  announce: boolean;
  /** When the owner is expected back, as a WIB wall-clock "HH:MM" — or '' if unknown.
   * Owner, 2026-07-30: "need to also include when I might be available again."
   * Resolved server-side (solance-api owns the WIB offset); the bot never does
   * timezone math of its own — a second implementation of a timezone is how the
   * curfew drift got in. */
  untilLabel: string;
  /**
   * Whether the owner marked this note sayable to guests.
   *
   * ABSENT means SAY IT. She fills the reason field precisely so her absence
   * gets explained; defaulting to silence is how the feature became decorative
   * (spec §6.1, and memory `feedback_her_ask_outranks_my_safety_instinct`).
   * Only an explicit `false` — her marking it private — holds it back.
   */
  reasonShareable: boolean;
}

const FETCH_TIMEOUT_MS = 8_000;

/**
 * fetchAwayStatus — GET `${apiBase}/routine/away-status` with a Bearer token.
 * Returns the parsed status on a 2xx response, or `null` on ANY failure
 * (non-ok status, network throw, or the 8s timeout). Never throws.
 */
export async function fetchAwayStatus(apiBase: string, token: string, store: SettingsStore = new SolanceApiSettingsStore(apiBase, token)): Promise<AwayStatus | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await store.getAwayStatus(controller.signal);
    if (!res.ok) return null;
    const body: any = await res.json();
    return {
      away: !!body?.away,
      source: typeof body?.source === 'string' ? body.source : '',
      status: typeof body?.status === 'string' ? body.status : '',
      reason: typeof body?.reason === 'string' ? body.reason : '',
      announce: body?.announce !== false,
      untilLabel: typeof body?.until_label === 'string' ? body.until_label : '',
      // Default TRUE on anything that isn't an explicit false — including an
      // older API that doesn't send the field at all. Her note gets said unless
      // she says otherwise.
      reasonShareable: body?.reason_shareable !== false,
    };
  } catch (err: any) {
    logger.info('AwayStatus', 'away-status fetch failed — treating as unavailable', { error: err?.message });
    return null;
  } finally {
    clearTimeout(t);
  }
}
