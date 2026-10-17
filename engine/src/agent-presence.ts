// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * agent-presence.ts — when the owner's own agent last polled the bot. Kept in memory only:
 * a restart reads as "not connected" until the next poll.
 */
export const AGENT_CONNECTED_WITHIN_MS = 3 * 60_000;

export class AgentPresence {
  private seen: number | null = null;
  constructor(private readonly now: () => number = Date.now) {}
  touch(): void { this.seen = this.now(); }
  lastSeen(): number | null { return this.seen; }
}

export function isAgentConnected(lastSeen: number | null, now: number): boolean {
  return lastSeen !== null && now - lastSeen <= AGENT_CONNECTED_WITHIN_MS;
}
