// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * timezone.ts — the one place that turns an instant into a wall clock in the `timezone` setting.
 * The setting is an IANA name ("Europe/Lisbon", "America/New_York"); the default is "UTC". A name Intl does not
 * know falls back to UTC with one warning, so a typo can never stop quiet hours or the away label.
 */
// No imports: deployment-config.ts reads this at load, before the logger and identity exist, so it warns through console.warn.

export const DEFAULT_TIMEZONE = 'UTC';

const known = new Map<string, boolean>();
const warned = new Set<string>();

/** True when Intl knows this IANA zone name. */
export function isValidTimezone(name: unknown): name is string {
  if (typeof name !== 'string' || !name.trim()) return false;
  const cached = known.get(name);
  if (cached !== undefined) return cached;
  let ok = true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: name }); } catch { ok = false; }
  known.set(name, ok);
  return ok;
}

/** The zone to use for a configured value: the value when valid, else UTC (one warning per bad value). */
export function resolveTimezone(name: unknown): string {
  if (name === undefined || name === null || name === '') return DEFAULT_TIMEZONE;
  if (isValidTimezone(name)) return name;
  if (typeof name === 'string' && !warned.has(name)) {
    warned.add(name);
    console.warn(`[Timezone] "${name}" is not an IANA time zone name; using UTC instead`);
  }
  return DEFAULT_TIMEZONE;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(zone, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(ms: number, zone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = formatterFor(resolveTimezone(zone)).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') % 24, minute: get('minute') };
}

/** How far the zone's wall clock is ahead of UTC at this instant, in ms (follows daylight saving). */
export function zoneOffsetMs(ms: number, zone: string): number {
  const p = zonedParts(ms, zone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  return wall - Math.floor(ms / 60_000) * 60_000;
}

/** Wall-clock minutes since midnight in the zone. */
export function zonedMinutesOfDay(ms: number, zone: string): number {
  const p = zonedParts(ms, zone);
  return p.hour * 60 + p.minute;
}

/** "HH:MM" on the zone's wall clock. */
export function zonedHHMM(ms: number, zone: string): string {
  const p = zonedParts(ms, zone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** The instant at which the zone's wall clock reads this date and time. `day` may be 0 or negative (it rolls back). */
export function zonedWallToMs(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  let ms = wall - zoneOffsetMs(wall, zone);
  ms = wall - zoneOffsetMs(ms, zone); // second pass settles the instants next to a clock change
  return ms;
}
