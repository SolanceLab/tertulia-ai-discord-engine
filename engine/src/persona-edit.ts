// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * persona-edit.ts — the one place the persona and the extra instructions are read, changed and undone.
 * The settings page (owner), the bot-secret routes behind the companion's tools (agent) and the Mac
 * server's direct mode all call these, so a refusal or a recorded change is the same everywhere.
 * `by` comes from HOW the caller got in, never from anything the caller sends.
 */
import type { SettingsStore } from './seams/settings-store.js';
import type { HistoryBy, HistoryEntry } from './seams/local-settings-store.js';
import { HistoryError } from './seams/local-settings-store.js';
import { type PersonaSource, type PersonaFields, PERSONA_VOICE_MAX, type PersonaProvider, PERSONA_TEXT_MAX, PERSONA_NAME_MAX } from './seams/persona-provider.js';

export class PersonaEditError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

export interface PersonaView {
  source: PersonaSource;
  editable: boolean;
  /** The fields held in the settings. For file/url sources these are not what the bot uses. */
  persona: PersonaFields;
  /** What the bot actually uses right now. */
  text_in_use: string;
}

const NOT_HERE = 'settings are managed outside this bot for this setup';

function need<K extends keyof SettingsStore>(store: SettingsStore, k: K): NonNullable<SettingsStore[K]> {
  const f = store[k];
  if (!f) throw new PersonaEditError(501, NOT_HERE);
  return (f as any).bind(store);
}

/** True when this setup keeps the persona + instructions at all (the local settings file). */
export function supportsPersona(store: SettingsStore, provider: PersonaProvider | undefined | null): boolean {
  return !!(provider && store.getPersona && store.applyPersona);
}

export async function readPersona(store: SettingsStore, provider: PersonaProvider | undefined | null): Promise<PersonaView> {
  if (!provider) throw new PersonaEditError(501, NOT_HERE);
  const persona = await need(store, 'getPersona')();
  const state = await provider.get();
  return { source: state.source, editable: state.editable, persona, text_in_use: state.text };
}

function checkLen(v: unknown, max: number, where: string): string {
  if (typeof v !== 'string') throw new PersonaEditError(400, `${where} must be text`);
  if (v.length > max) throw new PersonaEditError(400, `${where} is too long (max ${max})`);
  return v;
}

/** Validate a persona patch without touching anything. Throws PersonaEditError. */
function validatePersonaPatch(provider: PersonaProvider | undefined | null, patch: Record<string, unknown>): Partial<PersonaFields> {
  if (!provider) throw new PersonaEditError(501, NOT_HERE);
  if (provider.source !== 'page') throw new PersonaEditError(409, 'the persona is set by your core (file or url), not here');
  const next: Partial<PersonaFields> = {};
  for (const k of Object.keys(patch)) if (!['text', 'name', 'voice'].includes(k)) throw new PersonaEditError(400, `unknown key '${k}'`);
  if (patch.text !== undefined) next.text = checkLen(patch.text, PERSONA_TEXT_MAX, 'text');
  if (patch.name !== undefined) next.name = checkLen(patch.name, PERSONA_NAME_MAX, 'name');
  if (patch.voice !== undefined) next.voice = checkLen(patch.voice, PERSONA_VOICE_MAX, 'voice');
  if (Object.keys(next).length === 0) throw new PersonaEditError(400, 'send at least one of text, name, voice');
  return next;
}

export async function updatePersona(store: SettingsStore, provider: PersonaProvider | undefined | null, patch: Record<string, unknown>, by: HistoryBy): Promise<PersonaView> {
  const next = validatePersonaPatch(provider, patch);
  await need(store, 'applyPersona')(next, by);
  return readPersona(store, provider);
}

export async function readInstructions(store: SettingsStore): Promise<{ text: string }> {
  return { text: await need(store, 'getInstructions')() };
}

export async function updateInstructions(store: SettingsStore, text: unknown, by: HistoryBy): Promise<{ text: string }> {
  const t = checkLen(text, 4000, 'text');
  return { text: await need(store, 'applyInstructions')(t, by) };
}

/**
 * The owner's page save: extra instructions and persona fields together. Everything is validated first and
 * written in one locked step, so a refused save changes nothing.
 */
export async function savePersonaAndInstructions(store: SettingsStore, provider: PersonaProvider | undefined | null, body: Record<string, unknown>, by: HistoryBy): Promise<PersonaView & { instructions: string }> {
  const { instructions, ...persona } = body;
  const instr = instructions === undefined ? undefined : checkLen(instructions, 4000, 'text');
  const hasPersona = Object.keys(persona).length > 0 || instructions === undefined;
  const patch = hasPersona ? validatePersonaPatch(provider, persona) : undefined;
  if (!provider) throw new PersonaEditError(501, NOT_HERE);
  await need(store, 'applyPersonaAndInstructions')({ instructions: instr, persona: patch }, by);
  return { ...(await readPersona(store, provider)), instructions: (await readInstructions(store)).text };
}

/** Newest first. Each entry carries its stable id, the handle to undo it by. */
export async function readHistory(store: SettingsStore): Promise<HistoryEntry[]> {
  const all = await need(store, 'getHistory')();
  return [...all].reverse();
}

export async function undo(store: SettingsStore, provider: PersonaProvider | undefined | null, id: unknown, by: HistoryBy): Promise<HistoryEntry> {
  if (typeof id !== 'string' || !id) throw new PersonaEditError(400, 'id must be the id of a change');
  try {
    return await need(store, 'undoChange')(id, by, provider?.source === 'page');
  } catch (err) {
    if (err instanceof HistoryError) throw new PersonaEditError(err.status, err.message);
    throw err;
  }
}

/** The persona tools write the local settings file, which only the public (direct model + local settings) build reads. */
export function personaToolsReachable(plugs: { model: string; settings: string }): boolean {
  return plugs.settings === 'local' && plugs.model !== 'sanctum';
}
