// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * typing.ts — the "is typing…" indicator for replies the bot has decided to give.
 * Discord's indicator lasts about 10 s, so it is renewed every 8 s until the work
 * finishes or throws. A typing failure never blocks or delays a reply. Pure timing,
 * with injectable timers so tests run on a fake clock.
 */

/** Discord's indicator lasts ~10 s; renew a little before it runs out. */
export const TYPING_RENEW_MS = 8000;
/** The ambient pause: a short, natural beat scaled to the message, never under 1 s or over 3 s. */
export const TYPING_PAUSE_MAX_MS = 3000;
const TYPING_PAUSE_PER_CHAR_MS = 25;
export const TYPING_PAUSE_MIN_MS = 1000;

export interface TypingTimers {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

const REAL_TIMERS: TypingTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/** Fire the indicator; the returned promise never rejects, so callers may await it safely. */
function pulse(send: (channelId: string) => Promise<void>, channelId: string): Promise<void> {
  try {
    return Promise.resolve(send(channelId)).catch(() => {});
  } catch {
    // a typing failure never blocks a reply
    return Promise.resolve();
  }
}

export interface WithTypingOptions {
  /**
   * Checked before every pulse. False = no typing now (the message was already claimed by another
   * speaker path, or the bot is held offline), so the indicator never shows for a reply that will not come.
   */
  shouldType?: () => boolean;
  /**
   * Wait for the first typing request to land before `fn` starts, so a fast `fn` (a send) can never
   * reach Discord before the indicator does. The wait is capped, so a hung request still cannot hold the reply.
   */
  awaitFirst?: boolean;
  /** Cap on the first-request wait (default 750 ms). */
  firstWaitMs?: number;
  /** Injectable sleep for the cap, so tests run on a fake clock. */
  sleep?: (ms: number) => Promise<void>;
}

/** Longest the first typing request may hold `fn` back. */
export const TYPING_FIRST_WAIT_MS = 750;

/**
 * Show typing in `channelId` while `fn` runs: once now, then every 8 s. The timer is
 * always cleared (success or throw); `fn`'s result or error passes through untouched.
 */
export async function withTyping<T>(
  send: (channelId: string) => Promise<void>,
  channelId: string,
  fn: () => Promise<T>,
  timers: TypingTimers = REAL_TIMERS,
  renewMs: number = TYPING_RENEW_MS,
  opts: WithTypingOptions = {},
): Promise<T> {
  const allowed = (): boolean => {
    try { return opts.shouldType ? opts.shouldType() : true; } catch { return false; }
  };
  const fire = (): Promise<void> => (allowed() ? pulse(send, channelId) : Promise.resolve());
  const first = fire();
  const handle = timers.setInterval(() => { void fire(); }, renewMs);
  try {
    if (opts.awaitFirst) {
      const cap = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      await Promise.race([first, cap(opts.firstWaitMs ?? TYPING_FIRST_WAIT_MS)]);
    }
    return await fn();
  } finally {
    // Stop at once and never wait on in-flight requests: a hung typing call must not delay the reply.
    timers.clearInterval(handle);
  }
}

/** How long to show typing before an ambient message goes out: 1–3 s, longer for longer text. */
export function typingPause(text: string): number {
  const ms = TYPING_PAUSE_MIN_MS + (text ?? '').length * TYPING_PAUSE_PER_CHAR_MS;
  return Math.min(TYPING_PAUSE_MAX_MS, Math.max(TYPING_PAUSE_MIN_MS, ms));
}

/**
 * Ambient: the judge already said speak. Show typing once, wait the pause, return.
 * Never called while judging, so a silent judge shows nothing.
 */
export async function ambientTypingPause(
  send: (channelId: string) => Promise<void>,
  channelId: string,
  text: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  void pulse(send, channelId);
  await sleep(typingPause(text));
}
