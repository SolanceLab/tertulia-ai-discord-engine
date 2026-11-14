// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * settings-store.ts — the seam between the engine and wherever its settings live.
 * Presence config, quiet hours, away status, quiet hours events, the focus mode / sightings,
 * the agent window window and the care-reply all go through this interface.
 * HostedSettingsStore talks to a hosted settings API with a Bearer token; its requests are the
 * ones that used to be inline. The API's own earlier route and key names stay on the wire (legacy-names.ts);
 * the readers of its answers move earlier keys to the new ones.
 *
 * Methods hand back the raw Response so each caller keeps its own status/parse/error handling.
 */
import { identity } from '../config/identity.js';
import type { Step } from '../presence/steps.js';
import { toLegacyWire, HOSTED_ROUTES } from '../config/legacy-names.js';

export interface SettingsStore {
  /** GET presence config (`discord` record: posture, level, focus mode, agent window, ignore list...). */
  getPresenceConfig(signal?: AbortSignal): Promise<Response>;
  /** PUT a partial presence-config record (focus mode sighting, agent window window, ...). */
  putPresenceConfig(body: unknown, signal?: AbortSignal): Promise<Response>;
  /** GET the quiet hours window config. */
  getQuietHours(signal?: AbortSignal): Promise<Response>;
  /** GET the away status. */
  getAwayStatus(signal?: AbortSignal): Promise<Response>;
  /** POST a quiet hours event (Watch dashboard log). */
  postQuietHoursEvent(body: unknown): Promise<Response>;
  /** POST a care-reply interaction. */
  postCareInteraction(body: unknown): Promise<Response>;
  /**
   * Optional: the whole editable settings document, for the bot's own settings page.
   * Only stores that hold the settings themselves (the local file) implement these; the deployment
   * the settings service store does not, and the page then reports that settings are managed elsewhere.
   */
  getDocument?(): Promise<EditableSettings>;
  /** Optional: the linked away calendar (local store only; the deployment layer has Routines instead). Views never carry the address. */
  getAwayCalendar?(): Promise<import('./local-settings-store.js').AwayCalendarView>;
  setAwayCalendar?(url: string | null): Promise<import('./local-settings-store.js').AwayCalendarView>;
  putDocument?(doc: EditableSettings): Promise<EditableSettings>;
  /** Optional (local store only): the persona + extra instructions with their recorded change history. */
  getPersona?(): Promise<import('./persona-provider.js').PersonaFields>;
  getInstructions?(): Promise<string>;
  getHistory?(): Promise<import('./local-settings-store.js').HistoryEntry[]>;
  applyPersona?(patch: Partial<import('./persona-provider.js').PersonaFields>, by: import('./local-settings-store.js').HistoryBy): Promise<import('./persona-provider.js').PersonaFields>;
  applyInstructions?(text: string, by: import('./local-settings-store.js').HistoryBy): Promise<string>;
  applyPersonaAndInstructions?(edit: { instructions?: string; persona?: Partial<import('./persona-provider.js').PersonaFields> }, by: import('./local-settings-store.js').HistoryBy, check?: () => void): Promise<void>;
  undoChange?(id: string, by: import('./local-settings-store.js').HistoryBy, allowPersona?: boolean): Promise<import('./local-settings-store.js').HistoryEntry>;
  /** Optional: the custom status text the owner set (null = none, the identity default shows). */
  getCustomStatus?(): Promise<string | null>;
  /** Optional: save the custom status text; null clears it. */
  setCustomStatus?(text: string | null): Promise<void>;
  /** Atomic read-derive-write: `derive` sees the current document under the store's lock. */
  updateDocument?(derive: (current: EditableSettings) => EditableSettings): Promise<EditableSettings>;
}

/** The slice of settings the page edits. Validated by dashboard/routes.ts before it reaches a store. */
export interface EditableSettings {
  presence: { step: Step; presence_level: number; posture: Record<string, string> };
  quiet_hours: { enabled: boolean; start: string; end: string };
  away: { active: boolean; reason: string; until: string | null; announce: boolean; reason_shareable: boolean };
  /** active/until_hours are written; the rest is read-only status the page shows. */
  focus: { active: boolean; until_hours?: number; raised_by?: string | null; raised_at?: string | null; until?: string | null; caught?: boolean | null };
  ignored_user_ids: string[];
  memory_filter: { context_log: string; keyword_blocklist: string[] };
  /** Per-server settings the owner has set; the config seed and the silent default fill the rest. */
  servers: import('../presence/servers.js').ServerMap;
  appearance: { colour_main: string; colour_accent: string; logo: string; title: string };
  labels: Record<string, string>;
  /** Whether the owner's own agent answers /aside to: agent and /wake. */
  agent: { enabled: boolean };
}

export type TokenSource = string | (() => string | undefined);

export class HostedSettingsStore implements SettingsStore {
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
      body: JSON.stringify(toLegacyWire(body)),   // the hosted API still speaks the earlier key names
      signal,
    });
  }

  getQuietHours(signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.base}${HOSTED_ROUTES.quietHours}`, {
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
    return fetch(`${this.base}${HOSTED_ROUTES.quietHoursEvent}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.bearer()}` },
      body: JSON.stringify(body),
    });
  }

  postCareInteraction(body: unknown): Promise<Response> {
    return fetch(`${this.base}${identity.care.interactions_path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.bearer()}` },
      body: JSON.stringify(body),
    });
  }
}
