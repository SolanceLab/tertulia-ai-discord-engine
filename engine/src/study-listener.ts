// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * study-listener.ts — the one session that is listening (Owner, 22 Oct 2026).
 *
 * One session at a time may claim "I am listening". While it is live (a heartbeat inside the last
 * 3 minutes) the study queue serves its items to that session only; with nobody live the queue behaves as
 * it always did and the Mac watcher starts a fresh background session. In memory only: after a restart
 * nobody is listening until a session claims again. Pure, with an injectable clock.
 */

/** A listener that has not beaten its heart for this long is gone. */
export const LISTENER_LIVE_MS = 3 * 60_000;
const ID_MAX = 120;
const NAME_MAX = 60;

export interface ListenerInfo { session_id: string; name: string; since: string }

/** A session name as it is shown on a card: one line, no markup, no tags, no control characters. */
export function cleanListenerName(name: unknown): string {
  const s = String(name ?? '')
    .normalize('NFKC')
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[<>@*_~|`\\[\]()#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return s || 'a session';
}

function cleanSessionId(id: unknown): string {
  return typeof id === 'string' ? id.trim().slice(0, ID_MAX) : '';
}

export class Listener {
  private cur: { sessionId: string; name: string; since: number; beat: number } | null = null;
  constructor(private now: () => number = Date.now) {}

  private live(): NonNullable<Listener['cur']> | null {
    const c = this.cur;
    if (!c) return null;
    if (this.now() - c.beat >= LISTENER_LIVE_MS) { this.cur = null; return null; }
    return c;
  }

  /** Newest claim wins. The same session claiming again keeps its original start time. false = no session id. */
  listen(o: { session_id: unknown; name?: unknown }): boolean {
    const sessionId = cleanSessionId(o.session_id);
    if (!sessionId) return false;
    const t = this.now();
    const prev = this.live();
    this.cur = { sessionId, name: cleanListenerName(o.name), since: prev && prev.sessionId === sessionId ? prev.since : t, beat: t };
    return true;
  }

  /** The listener's heart. true = recorded; false = this session is not (or no longer) the live listener, claim again. */
  heartbeat(sessionId: unknown): boolean {
    const c = this.live();
    if (!c || c.sessionId !== cleanSessionId(sessionId)) return false;
    c.beat = this.now();
    return true;
  }

  /** A session stops listening; with no id it is the Stop button on the settings page. true = someone was listening. */
  release(sessionId?: unknown): boolean {
    const c = this.live();
    if (!c) { this.cur = null; return false; }
    const id = cleanSessionId(sessionId);
    if (id && c.sessionId !== id) return false;
    this.cur = null;
    return true;
  }

  /** Who is listening now, or null. */
  current(): ListenerInfo | null {
    const c = this.live();
    return c ? { session_id: c.sessionId, name: c.name, since: new Date(c.since).toISOString() } : null;
  }

  isLive(): boolean { return this.live() !== null; }

  /** May this caller see and claim queued items? Everyone may while nobody listens; only the listener while someone does. */
  allows(sessionId: unknown): boolean {
    const c = this.live();
    if (!c) return true;
    return c.sessionId === cleanSessionId(sessionId);
  }
}
