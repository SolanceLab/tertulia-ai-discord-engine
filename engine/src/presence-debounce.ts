// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * presence-debounce.ts — mirror the owner's Discord status without mirroring her phone's blips.
 *
 * Owner, 2 Oct 2026: "Why is your bot keeps on giving me DM saying you're shown offline when
 * you're not?" Live logs showed Discord reporting her offline for 8–55 seconds at a time
 * (16:39:05→16:39:13, 16:45:55→16:46:04, 16:51:33→16:52:28 UTC): her phone dropping its gateway
 * connection on app-switch / screen lock. The bot went invisible on every blip, so any guest who
 * reached for her in those seconds produced an "I'm shown offline" DM.
 *
 * Rule: ONLINE (online/idle/dnd) is applied at once. OFFLINE is applied only after she has stayed
 * offline for the whole grace period — re-checked when the timer fires. Each change arrives once
 * per shared guild (three today); repeats of the current state are ignored.
 */
export const OFFLINE_GRACE_MS = 5 * 60_000;

export type MirrorStatus = 'online' | 'invisible';

export interface PresenceDebounceDeps {
  /** Apply the bot's own status and announce the change. */
  apply(status: MirrorStatus): void;
  /** Is the owner online RIGHT NOW (fresh read)? Used when the grace timer fires. */
  isOwnerOnlineNow(): Promise<boolean>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  graceMs?: number;
}

export function isOnlineStatus(status: string | null | undefined): boolean {
  return status === 'online' || status === 'idle' || status === 'dnd';
}

export class PresenceDebouncer {
  private current: MirrorStatus | null = null;
  // One offline check at a time: the grace timer AND its fresh read. Stays set until the read
  // completes, so duplicate offline events during the read never start a second timer.
  private pending: { handle: unknown } | null = null;
  // Bumped ONLY by an applied decision (an online event, a settle). An in-flight read that started
  // under an older generation is discarded (Codex, 2 Oct): a stale "offline" must never overwrite her
  // coming back online. Starting an offline grace check decides nothing, so it does not bump.
  private gen = 0;

  constructor(private deps: PresenceDebounceDeps) {}

  /** The status the bot is showing (null before the first decision). */
  get shown(): MirrorStatus | null { return this.current; }

  /** An authoritative status, applied immediately either way. */
  settle(online: boolean): void {
    this.gen++;
    this.cancel();
    this.set(online ? 'online' : 'invisible');
  }

  /**
   * Boot: read her status and settle on it, unless a gateway event decided first while the read
   * was in flight. No answer from any guild → invisible (hold until known).
   */
  async settleFrom(read: () => Promise<boolean | null>): Promise<void> {
    const myGen = this.gen;
    let online: boolean | null = null;
    try { online = await read(); } catch { online = null; }
    if (this.gen !== myGen) return; // a live online event already decided
    // Apply without cancelling or superseding: an offline grace check that began during the read
    // keeps running and re-reads her when it fires. Either way a definite status now exists.
    this.set(online === true ? 'online' : 'invisible');
  }

  /** A gateway presence event for the owner. */
  observe(status: string | null | undefined): void {
    if (isOnlineStatus(status)) {
      this.gen++;
      this.cancel();
      this.set('online');
      return;
    }
    if (this.current === 'invisible' || this.pending) return;
    const myGen = this.gen;
    const slot: { handle: unknown } = { handle: null };
    this.pending = slot;
    slot.handle = this.deps.setTimer(() => { void this.fire(myGen, slot); }, this.deps.graceMs ?? OFFLINE_GRACE_MS);
  }

  private async fire(myGen: number, slot: { handle: unknown }): Promise<void> {
    let online = false;
    try { online = await this.deps.isOwnerOnlineNow(); } catch { online = false; }
    if (this.pending === slot) this.pending = null;
    if (this.gen !== myGen) return; // superseded while the read was in flight
    this.set(online ? 'online' : 'invisible');
  }

  private cancel(): void {
    if (this.pending) { this.deps.clearTimer(this.pending.handle); this.pending = null; }
  }

  private set(status: MirrorStatus): void {
    if (this.current === status) return;
    this.current = status;
    this.deps.apply(status);
  }
}
