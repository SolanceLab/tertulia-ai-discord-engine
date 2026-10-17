// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * local-settings-store.ts — the public SettingsStore: every setting lives in one JSON file
 * (env SETTINGS_PATH, default ./data/settings.json). No database, no native deps.
 * Reads and writes return the same Response bodies the solance-api store does, so callers
 * (presence-config, curfew-watch, away-status, discord-client) need no change.
 *
 * Writes are atomic (temp file + rename) and serialised. A missing or corrupt file falls back
 * to the defaults below and is logged, never thrown.
 */
import { mkdirSync, writeFileSync, chmodSync, existsSync, renameSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { DEFAULTS, parseConfig, SCENE_DEFAULT, parseStudy, parseScene, STUDY_DEFAULT } from '../presence-config.js';
import type { EditableSettings, SettingsStore } from './settings-store.js';
import { parseServers, type ServerMap } from '../presence/servers.js';
import type { Step } from '../presence/steps.js';
import { type PersonaFields, PERSONA_VOICE_MAX, PERSONA_TEXT_MAX, PERSONA_NAME_MAX } from './persona-provider.js';
import { AwayCalendar, validateIcsUrl, defaultCalendarConfig, type CalendarConfig } from '../away-calendar.js';

export const CURFEW_EVENTS_CAP = 200;

export interface AwayCalendarView {
  linked: boolean;
  host: string | null;
  unreachable: boolean;
  busy_now: { until: string } | null;
  next: { start: string; end: string } | null;
}

export const HISTORY_CAP = 50;
export const HISTORY_FIELDS = ['persona.text', 'persona.name', 'persona.voice', 'extra_instructions'] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number];
export type HistoryBy = 'owner' | 'agent';
/** One recorded change to the persona or the extra instructions: who, when, and the text either side. */
export interface HistoryEntry { id: string; at: string; by: HistoryBy; field: HistoryField; before: string; after: string; undo_of?: string }

export class HistoryError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

export interface Appearance { colour_main: string; colour_accent: string; logo: string; title: string }

export interface LocalSettings {
  presence: {
    /** The big dial (one ladder); wins over presence_level when both are stored. */
    step: Step;
    presence_level: number;
    sweep_minutes: number;
    /** per-channel step: channel id -> silent|reply_only|reserved|balanced|sociable|chatty (old words read on load) */
    posture: Record<string, string>;
    extra_instructions: string;
    name_triggers: { owner: string[]; bot: string[] };
    stickers_enabled: boolean;
    /** Optional curfew sticker per level (guild sticker id); null = text only. */
    curfew_stickers: Record<'1' | '2' | '3', string | null>;
  };
  curfew: { enabled: boolean; start: string; end: string };
  away: { active: boolean; reason: string; until: string | null; set_at: string | null; announce: boolean; reason_shareable: boolean; calendar: CalendarConfig };
  curfew_events: Array<{ at: string; level: number; channel_id: string; message: string }>;
  scene: Record<string, unknown>;
  scene_sighting: Record<string, unknown> | null;
  study: Record<string, unknown>;
  ignored_user_ids: string[];
  memory_filter: { context_log: string; keyword_blocklist: string[] };
  /** Per-server settings the owner has set (the live half of resolveServer). */
  servers: ServerMap;
  owner_user_id: string;
  appearance: Appearance;
  /** The persona the page edits (PERSONA=page): bot name, who it is, how it talks. */
  persona: PersonaFields;
  /** The last HISTORY_CAP changes to the persona or extra_instructions, oldest first. */
  history: HistoryEntry[];
  /** Section names shown on the settings page. */
  labels: Record<string, string>;
  /** The owner's own agent (/aside to: agent, /wake). Off until switched on. */
  agent: { enabled: boolean };
}

export const DEFAULT_LABELS: Record<string, string> = {
  presence: 'Presence', quiet_hours: 'Quiet hours', away: 'Away', focus: 'Focus mode', mute: 'Mute', memory_filter: 'Memory filter',
};

export function defaultSettings(): LocalSettings {
  return {
    presence: {
      step: 'balanced',
      presence_level: 2,
      sweep_minutes: 30,
      posture: {},
      extra_instructions: '',
      name_triggers: { owner: [...DEFAULTS.name_triggers.owner], bot: [...DEFAULTS.name_triggers.bot] },
      stickers_enabled: true,
      curfew_stickers: { ...DEFAULTS.curfew_stickers },
    },
    curfew: { enabled: false, start: '23:00', end: '06:00' },
    away: { active: false, reason: '', until: null, set_at: null, announce: true, reason_shareable: true, calendar: defaultCalendarConfig() },
    curfew_events: [],
    scene: { ...SCENE_DEFAULT },
    scene_sighting: null,
    study: { ...STUDY_DEFAULT },
    ignored_user_ids: [],
    memory_filter: { context_log: DEFAULTS.context_log, keyword_blocklist: [] },
    servers: {},
    owner_user_id: '',
    appearance: { colour_main: '#1f3a6b', colour_accent: '#c9a227', logo: 'none', title: 'Discord settings' },
    persona: { text: '', name: '', voice: '' },
    history: [],
    labels: { ...DEFAULT_LABELS },
    agent: { enabled: false },
  };
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const SNOWFLAKE = /^\d{15,21}$/;
/** A calendar-derived instant that new Date(ms).toISOString() will accept (never throws RangeError). */
const validTs = (ms: unknown): ms is number => typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15;

/** Merge a loaded (possibly partial / malformed) object over the defaults, field by field. */
export function normalizeSettings(raw: unknown): LocalSettings {
  const d = defaultSettings();
  if (!isObj(raw)) return d;
  // Presence: reuse the engine's own clamping parser so the two can never disagree.
  const pr = isObj(raw.presence) ? raw.presence : {};
  const parsed = parseConfig(pr);
  d.presence = {
    step: parsed.step,
    presence_level: parsed.presence_level,
    sweep_minutes: parsed.sweep_minutes,
    posture: parsed.posture,
    extra_instructions: parsed.extra_instructions,
    name_triggers: parsed.name_triggers,
    stickers_enabled: parsed.stickers_enabled,
    curfew_stickers: parsed.curfew_stickers,
  };
  if (isObj(raw.curfew)) {
    const c = raw.curfew;
    if (typeof c.enabled === 'boolean') d.curfew.enabled = c.enabled;
    if (typeof c.start === 'string' && HHMM.test(c.start)) d.curfew.start = c.start;
    if (typeof c.end === 'string' && HHMM.test(c.end)) d.curfew.end = c.end;
  }
  if (isObj(raw.away)) {
    const a = raw.away;
    if (typeof a.active === 'boolean') d.away.active = a.active;
    if (typeof a.reason === 'string') d.away.reason = a.reason.slice(0, 1000);
    if (typeof a.until === 'string' && Number.isFinite(Date.parse(a.until))) d.away.until = a.until;
    if (typeof a.set_at === 'string' && Number.isFinite(Date.parse(a.set_at))) d.away.set_at = a.set_at;
    if (typeof a.announce === 'boolean') d.away.announce = a.announce;
    if (typeof a.reason_shareable === 'boolean') d.away.reason_shareable = a.reason_shareable;
    if (isObj(a.calendar) && typeof a.calendar.ics_url === 'string') {
      try { d.away.calendar.ics_url = validateIcsUrl(a.calendar.ics_url); } catch { /* an invalid stored address is treated as not linked */ }
    }
  }
  if (Array.isArray(raw.curfew_events)) {
    d.curfew_events = raw.curfew_events
      .filter((e: any) => isObj(e) && typeof e.at === 'string')
      .map((e: any) => ({ at: e.at, level: Number(e.level) || 0, channel_id: String(e.channel_id ?? ''), message: String(e.message ?? '') }))
      .slice(-CURFEW_EVENTS_CAP);
  }
  d.scene = { ...parseScene(raw.scene) };
  d.scene_sighting = isObj(raw.scene_sighting) ? raw.scene_sighting : null;
  d.study = { ...parseStudy(raw.study) };
  d.ignored_user_ids = parseConfig({ ignored_user_ids: raw.ignored_user_ids }).ignored_user_ids;
  if (isObj(raw.memory_filter)) {
    d.memory_filter.context_log = parseConfig({ context_log: raw.memory_filter.context_log }).context_log;
    if (Array.isArray(raw.memory_filter.keyword_blocklist)) {
      d.memory_filter.keyword_blocklist = raw.memory_filter.keyword_blocklist
        .filter((k: unknown) => typeof k === 'string' && k.trim()).map((k: string) => k.trim()).slice(0, 500);
    }
  }
  d.servers = parseServers(raw.servers);
  if (typeof raw.owner_user_id === 'string' && (raw.owner_user_id === '' || SNOWFLAKE.test(raw.owner_user_id))) d.owner_user_id = raw.owner_user_id;
  if (isObj(raw.appearance)) {
    for (const k of ['colour_main', 'colour_accent', 'logo', 'title'] as const) {
      if (typeof raw.appearance[k] === 'string' && raw.appearance[k].trim()) d.appearance[k] = raw.appearance[k].slice(0, 200);
    }
  }
  if (isObj(raw.persona)) {
    if (typeof raw.persona.text === 'string') d.persona.text = raw.persona.text.slice(0, PERSONA_TEXT_MAX);
    if (typeof raw.persona.name === 'string') d.persona.name = raw.persona.name.slice(0, PERSONA_NAME_MAX);
    if (typeof raw.persona.voice === 'string') d.persona.voice = raw.persona.voice.slice(0, PERSONA_VOICE_MAX);
  }
  if (Array.isArray(raw.history)) {
    d.history = raw.history
      .filter((h: any) => isObj(h) && typeof h.at === 'string' && (h.by === 'owner' || h.by === 'agent')
        && (HISTORY_FIELDS as readonly string[]).includes(h.field) && typeof h.before === 'string' && typeof h.after === 'string')
      .slice(-HISTORY_CAP)
      // Entries written before ids existed get a stable one from their position in the file, kept unique.
      .map((h: any, i: number): HistoryEntry => ({
        id: typeof h.id === 'string' && h.id ? h.id : `legacy-${i}-${String(h.at).replace(/\W/g, '')}`,
        at: h.at, by: h.by, field: h.field, before: h.before, after: h.after,
        ...(typeof h.undo_of === 'string' ? { undo_of: h.undo_of } : {}),
      }));
  }
  if (isObj(raw.agent) && typeof raw.agent.enabled === 'boolean') d.agent.enabled = raw.agent.enabled;
  if (isObj(raw.labels)) {
    for (const k of Object.keys(DEFAULT_LABELS)) {
      if (typeof raw.labels[k] === 'string' && raw.labels[k].trim()) d.labels[k] = raw.labels[k].trim().slice(0, 60);
    }
  }
  return d;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class LocalSettingsStore implements SettingsStore {
  private readonly path: string;
  private chain: Promise<unknown> = Promise.resolve();

  private readonly calendar: AwayCalendar;

  constructor(path: string = process.env.SETTINGS_PATH || './data/settings.json', private readonly now: () => number = () => Date.now(), calendar?: AwayCalendar) {
    this.path = resolve(path);
    this.calendar = calendar ?? new AwayCalendar({ now });
  }

  // --- away calendar ---------------------------------------------------------------------------

  /** What the page may see of the calendar: never the address itself, only whether and where it is linked. */
  async getAwayCalendar(): Promise<AwayCalendarView> {
    await this.chain;
    const v = await this.calendar.view(this.load().away.calendar.ics_url);
    return {
      linked: v.linked,
      host: v.host,
      unreachable: v.unreachable,
      busy_now: v.busyUntil !== null && validTs(v.busyUntil) ? { until: new Date(v.busyUntil).toISOString() } : null,
      next: v.next && validTs(v.next.start) && validTs(v.next.end) ? { start: new Date(v.next.start).toISOString(), end: new Date(v.next.end).toISOString() } : null,
    };
  }

  /** Link (a validated https address) or unlink (null) the calendar. Throws on an invalid address. */
  async setAwayCalendar(url: string | null): Promise<AwayCalendarView> {
    const clean = url === null ? null : validateIcsUrl(url);
    await this.update((s) => { s.away.calendar = { ...s.away.calendar, ics_url: clean }; });
    return this.getAwayCalendar();
  }

  // --- file access -----------------------------------------------------------------------------

  load(): LocalSettings {
    try {
      if (!existsSync(this.path)) return defaultSettings();
      return normalizeSettings(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (err: any) {
      logger.error('LocalSettings', 'settings file unreadable or corrupt — using defaults', { path: this.path, error: err?.message });
      return defaultSettings();
    }
  }

  private save(s: LocalSettings): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    // The file can hold the calendar address (a secret): owner-only, whatever the umask.
    writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* best effort on exotic filesystems */ }
    renameSync(tmp, this.path);
  }

  /** Read-modify-write under a lock so overlapping updates never lose each other. */
  update<T>(fn: (s: LocalSettings) => T): Promise<T> {
    const run = this.chain.then(() => {
      const s = this.load();
      const out = fn(s);
      this.save(s);
      return out;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  // --- persona + extra instructions, with a recorded history ----------------------------------

  /** The page-held persona fields (the PERSONA=page source reads this on every prompt). */
  peekPersona(): PersonaFields { return { ...this.load().persona }; }

  async getPersona(): Promise<PersonaFields> { await this.chain; return this.peekPersona(); }

  async getInstructions(): Promise<string> { await this.chain; return this.load().presence.extra_instructions; }

  /** Oldest first. */
  async getHistory(): Promise<HistoryEntry[]> { await this.chain; return this.load().history.map((h) => ({ ...h })); }

  private record(s: LocalSettings, by: HistoryBy, field: HistoryField, before: string, after: string, undoOf?: string): void {
    if (before === after) return;
    s.history.push({ id: randomUUID(), at: new Date(this.now()).toISOString(), by, field, before, after, ...(undoOf !== undefined ? { undo_of: undoOf } : {}) });
    if (s.history.length > HISTORY_CAP) s.history = s.history.slice(-HISTORY_CAP);
  }

  /** Change any of the three persona fields; each field that really changes is recorded with who did it. */
  async applyPersona(patch: Partial<PersonaFields>, by: HistoryBy): Promise<PersonaFields> {
    return this.update((s) => {
      for (const k of ['text', 'name', 'voice'] as const) {
        const v = patch[k];
        if (typeof v !== 'string') continue;
        const next = v.slice(0, k === 'text' ? PERSONA_TEXT_MAX : k === 'name' ? PERSONA_NAME_MAX : PERSONA_VOICE_MAX);
        this.record(s, by, `persona.${k}`, s.persona[k], next);
        s.persona[k] = next;
      }
      return { ...s.persona };
    });
  }

  /**
   * One save for the owner's page: the extra instructions and the persona fields land together or not at all.
   * `check` runs inside the lock (after both are known valid by the caller) and may throw to refuse; nothing is
   * written then.
   */
  async applyPersonaAndInstructions(edit: { instructions?: string; persona?: Partial<PersonaFields> }, by: HistoryBy, check?: () => void): Promise<void> {
    await this.update((s) => {
      check?.();
      if (edit.instructions !== undefined) {
        const next = parseConfig({ extra_instructions: edit.instructions }).extra_instructions;
        this.record(s, by, 'extra_instructions', s.presence.extra_instructions, next);
        s.presence.extra_instructions = next;
      }
      for (const k of ['text', 'name', 'voice'] as const) {
        const v = edit.persona?.[k];
        if (typeof v !== 'string') continue;
        const next = v.slice(0, k === 'text' ? PERSONA_TEXT_MAX : k === 'name' ? PERSONA_NAME_MAX : PERSONA_VOICE_MAX);
        this.record(s, by, `persona.${k}`, s.persona[k], next);
        s.persona[k] = next;
      }
    });
  }

  async applyInstructions(text: string, by: HistoryBy): Promise<string> {
    return this.update((s) => {
      const next = parseConfig({ extra_instructions: text }).extra_instructions;
      this.record(s, by, 'extra_instructions', s.presence.extra_instructions, next);
      s.presence.extra_instructions = next;
      return next;
    });
  }

  /**
   * Restore the 'before' text of one history entry (found by its stable id, under the store lock, so a
   * change landing meanwhile or the 50-entry cap shifting the list can never aim it at another entry) and record
   * the undo as its own entry. Persona fields can be refused by the caller when the persona is not held here.
   */
  async undoChange(id: string, by: HistoryBy, allowPersona = true): Promise<HistoryEntry> {
    return this.update((s) => {
      const e = typeof id === 'string' ? s.history.find((h) => h.id === id) : undefined;
      if (!e) throw new HistoryError(404, 'no such change');
      if (e.field !== 'extra_instructions' && !allowPersona) throw new HistoryError(409, 'the persona is set by your core, not here');
      const current = e.field === 'extra_instructions' ? s.presence.extra_instructions : s.persona[e.field.slice(8) as keyof PersonaFields];
      if (current === e.before) throw new HistoryError(409, 'already that text');
      if (current !== e.after) throw new HistoryError(409, 'changed since; undo the newer change first');
      if (e.field === 'extra_instructions') s.presence.extra_instructions = e.before;
      else s.persona[e.field.slice(8) as keyof PersonaFields] = e.before;
      this.record(s, by, e.field, current, e.before, e.id);
      return { ...s.history[s.history.length - 1] };
    });
  }

  // --- settings page document ------------------------------------------------------------------

  private editable(s: LocalSettings): EditableSettings {
    return {
      presence: { step: s.presence.step, presence_level: s.presence.presence_level, posture: { ...s.presence.posture } },
      curfew: { ...s.curfew },
      away: { active: s.away.active, reason: s.away.reason, until: s.away.until, announce: s.away.announce, reason_shareable: s.away.reason_shareable },
      focus: {
        active: s.scene.active === true,
        raised_by: typeof s.scene.raised_by === 'string' ? s.scene.raised_by : null,
        raised_at: typeof s.scene.raised_at === 'string' ? s.scene.raised_at : null,
        until: typeof s.scene.until === 'string' ? s.scene.until : null,
        caught: s.scene.active === true && s.scene_sighting && s.scene_sighting.raised_at === s.scene.raised_at ? s.scene_sighting.caught === true : null,
      },
      ignored_user_ids: [...s.ignored_user_ids],
      memory_filter: { context_log: s.memory_filter.context_log, keyword_blocklist: [...s.memory_filter.keyword_blocklist] },
      servers: JSON.parse(JSON.stringify(s.servers)),
      appearance: { ...s.appearance },
      labels: { ...s.labels },
      agent: { enabled: s.agent.enabled },
    };
  }

  async getDocument(): Promise<EditableSettings> {
    await this.chain;
    return this.editable(this.load());
  }

  /** Apply an already-validated page document. Fields the page does not edit are left alone. */
  async putDocument(doc: EditableSettings): Promise<EditableSettings> {
    return this.updateDocument(() => doc);
  }

  /**
   * Atomic page save: `derive` receives the document as it is INSIDE the store lock and returns the
   * document to write, so a concurrent putPresenceConfig() change is never overwritten by a stale read.
   * If `derive` throws, nothing is written.
   */
  async updateDocument(derive: (current: EditableSettings) => EditableSettings): Promise<EditableSettings> {
    return this.update((s) => {
      const doc = derive(this.editable(s));
      s.presence.step = doc.presence.step;
      s.presence.presence_level = doc.presence.presence_level;
      s.presence.posture = { ...doc.presence.posture };
      s.curfew = { ...doc.curfew };
      const wasActive = s.away.active;
      s.away.active = doc.away.active;
      s.away.reason = doc.away.reason;
      s.away.until = doc.away.until;
      s.away.announce = doc.away.announce;
      s.away.reason_shareable = doc.away.reason_shareable;
      if (doc.away.active && !wasActive) s.away.set_at = new Date(this.now()).toISOString();
      const sceneWasActive = s.scene.active === true;
      // Raising again with a length (until_hours) restarts the flag; plain on/off only changes it when it differs.
      if (doc.focus.active !== sceneWasActive || (doc.focus.active && typeof doc.focus.until_hours === 'number')) {
        const nowIso = new Date(this.now()).toISOString();
        if (doc.focus.active) {
          const hours = typeof doc.focus.until_hours === 'number' ? doc.focus.until_hours : 12;
          s.scene = { ...parseScene({ active: true, raised_at: nowIso, raised_by: 'dashboard', until: new Date(this.now() + hours * 3_600_000).toISOString(), lowered_at: null }) };
        } else {
          s.scene = { ...s.scene, active: false, lowered_at: nowIso };
        }
      }
      s.ignored_user_ids = [...doc.ignored_user_ids];
      s.memory_filter = { context_log: doc.memory_filter.context_log, keyword_blocklist: [...doc.memory_filter.keyword_blocklist] };
      s.servers = parseServers(doc.servers);
      s.appearance = { ...doc.appearance };
      s.labels = { ...DEFAULT_LABELS, ...doc.labels };
      s.agent = { enabled: doc.agent?.enabled === true };
      return this.editable(s);
    });
  }

  // --- SettingsStore ---------------------------------------------------------------------------

  async getPresenceConfig(): Promise<Response> {
    await this.chain;
    const s = this.load();
    return json(200, { discord: this.discordRecord(s) });
  }

  private discordRecord(s: LocalSettings) {
    return {
      ...s.presence,
      away: { announce: s.away.announce, override: { active: s.away.active, reason: s.away.reason, until: s.away.until, set_at: s.away.set_at } },
      context_log: s.memory_filter.context_log,
      ignored_user_ids: s.ignored_user_ids,
      scene: s.scene,
      study: s.study,
      servers: s.servers,
    };
  }

  async putPresenceConfig(body: unknown): Promise<Response> {
    if (!isObj(body)) return json(400, { error: 'body must be an object' });
    try {
      return await this.update((s) => {
        if (body.scene_sighting !== undefined) {
          if (s.scene.active !== true) return json(409, { error: 'scene flag is not up; re-send after it is raised' });
          if (isObj(body.scene_sighting) && body.scene_sighting.raised_at !== s.scene.raised_at) {
            return json(409, { error: 'scene_sighting.raised_at does not match the active scene; stale sighting' });
          }
          s.scene_sighting = isObj(body.scene_sighting) ? body.scene_sighting : null;
        }
        if (isObj(body.study)) {
          const st = body.study;
          if (st.active === true) {
            const minutes = Number(st.minutes);
            const opened = new Date(this.now());
            const probe = parseStudy({
              active: true, channel_id: st.channel_id, guild_id: st.guild_id ?? null, minutes,
              opened_at: opened.toISOString(), expires_at: new Date(this.now() + minutes * 60_000).toISOString(),
              nonce: randomUUID(), claimed_at: null, ready_at: null, closed_at: null,
            });
            if (!probe.active) return json(400, { error: 'invalid study window' });
            s.study = { ...probe };
          } else {
            s.study = { ...parseStudy({ ...s.study, active: false }) };
          }
        }
        if (isObj(body.scene)) s.scene = { ...parseScene(body.scene) };
        const beforeInstructions = s.presence.extra_instructions;
        const picked = pick(body, ['step', 'presence_level', 'sweep_minutes', 'posture', 'extra_instructions', 'name_triggers', 'stickers_enabled', 'curfew_stickers']);
        // An old client that sets only the dial (0-4) moves the step with it.
        const mergeIn: Record<string, unknown> = { ...s.presence, ...picked };
        if ('presence_level' in picked && !('step' in picked)) delete mergeIn.step;
        const merged = parseConfig(mergeIn);
        s.presence = {
          step: merged.step, presence_level: merged.presence_level, sweep_minutes: merged.sweep_minutes, posture: merged.posture,
          extra_instructions: merged.extra_instructions, name_triggers: merged.name_triggers, stickers_enabled: merged.stickers_enabled,
          curfew_stickers: merged.curfew_stickers,
        };
        // Whoever reaches the presence-config API (an agent, a script) is not the owner on the page.
        this.record(s, 'agent', 'extra_instructions', beforeInstructions, s.presence.extra_instructions);
        if (body.context_log !== undefined) s.memory_filter.context_log = parseConfig({ context_log: body.context_log }).context_log;
        if (body.servers !== undefined) s.servers = parseServers(body.servers);
        if (body.ignored_user_ids !== undefined) s.ignored_user_ids = parseConfig({ ignored_user_ids: body.ignored_user_ids }).ignored_user_ids;
        if (isObj(body.away)) {
          const o = isObj(body.away.override) ? body.away.override : {};
          if (typeof body.away.announce === 'boolean') s.away.announce = body.away.announce;
          if (typeof o.active === 'boolean') s.away.active = o.active;
          if (typeof o.reason === 'string') s.away.reason = o.reason.slice(0, 1000);
          if (o.until === null || typeof o.until === 'string') s.away.until = o.until;
          if (o.set_at === null || typeof o.set_at === 'string') s.away.set_at = o.set_at;
        }
        return json(200, { discord: this.discordRecord(s) });
      });
    } catch (err: any) {
      logger.error('LocalSettings', 'presence-config write failed', { error: err?.message });
      return json(500, { error: 'write failed' });
    }
  }

  async getCurfew(): Promise<Response> {
    await this.chain;
    return json(200, { curfew: this.load().curfew });
  }

  async getAwayStatus(signal?: AbortSignal): Promise<Response> {
    await this.chain;
    const a = this.load().away;
    const untilMs = a.until ? Date.parse(a.until) : NaN;
    const expired = Number.isFinite(untilMs) && untilMs <= this.now();
    const away = a.active && !expired;
    // The AwayStatus until_label contract is WIB (UTC+7, no DST), independent of the host zone.
    const wib = (ms: number) => {
      const d = new Date(ms + 7 * 3_600_000);
      return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    };
    let until_label = '';
    if (away && Number.isFinite(untilMs)) until_label = wib(untilMs);
    // Precedence: manual override > calendar busy now > not away. A calendar-sourced status carries NO
    // reason (event titles are never read) and is never marked unreachable to guests.
    if (!away && a.calendar.ics_url) {
      const cal = await this.calendar.view(a.calendar.ics_url, signal);
      if (cal.busyUntil !== null && validTs(cal.busyUntil)) {
        return json(200, { away: true, source: 'calendar', status: 'away', reason: '', announce: a.announce, until: new Date(cal.busyUntil).toISOString(), until_label: wib(cal.busyUntil), reason_shareable: true });
      }
    }
    return json(200, {
      away,
      source: away ? 'local' : '',
      status: away ? 'away' : '',
      reason: away ? a.reason : '',
      announce: a.announce,
      until_label,
      reason_shareable: a.reason_shareable,
    });
  }

  async postCurfewEvent(body: unknown): Promise<Response> {
    if (!isObj(body)) return json(400, { error: 'body must be an object' });
    try {
      await this.update((s) => {
        s.curfew_events.push({ at: new Date(this.now()).toISOString(), level: Number(body.level) || 0, channel_id: String(body.channel_id ?? ''), message: String(body.message ?? '') });
        if (s.curfew_events.length > CURFEW_EVENTS_CAP) s.curfew_events = s.curfew_events.slice(-CURFEW_EVENTS_CAP);
      });
      return json(200, { ok: true });
    } catch (err: any) {
      logger.error('LocalSettings', 'curfew event write failed', { error: err?.message });
      return json(500, { error: 'write failed' });
    }
  }

  /** The care-reply is a deployment feature; the public build has nothing to record it in. */
  async postCareInteraction(): Promise<Response> {
    return json(404, { error: 'not available in the public build' });
  }
}

function pick(o: Record<string, any>, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
