// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
export interface ModelFailureAttempt {
  engine: string;
  model: string;
  reason: string;
  status?: number;
}

export interface ModelRequestContext {
  channelId?: string;
  channelName?: string;
  mode: 'direct reply' | 'ambient judge' | 'private aside';
}

export interface ModelChainExhaustedEvent {
  attempts: ModelFailureAttempt[];
  context: ModelRequestContext;
}

export type ModelChainAlertResult = 'sent' | 'suppressed' | 'failed';

interface ModelChainAlertReporterOptions {
  channelId: string;
  sendMessage: (channelId: string, content: string) => Promise<unknown>;
  now?: () => number;
  cooldownMs?: number;
}

export const MODEL_CHAIN_ALERT_COOLDOWN_MS = 15 * 60_000;

export function formatModelChainAlert(event: ModelChainExhaustedEvent): string {
  const origin = event.context.channelName
    ? `${event.context.mode} in #${event.context.channelName}${event.context.channelId ? ` (\`${event.context.channelId}\`)` : ''}`
    : event.context.mode;
  const failures = event.attempts
    .map((attempt) => {
      const status = attempt.status !== undefined ? ` [HTTP ${attempt.status}]` : '';
      return `- \`${attempt.engine} / ${attempt.model}\` — ${attempt.reason}${status}`;
    })
    .join('\n');

  return `⚠️ **Discord model chain exhausted**\n` +
    `No model produced a reply.\n\n` +
    `**Origin:** ${origin}\n` +
    `**Failures:**\n${failures}\n\n` +
    `Further exhaustion alerts are suppressed for 15 minutes.`;
}

/**
 * Deterministic operational reporting for a total model outage. The report is
 * sent directly through Discord and therefore does not depend on any model.
 */
export class ModelChainAlertReporter {
  private readonly channelId: string;
  private readonly sendMessage: (channelId: string, content: string) => Promise<unknown>;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private lastAlertAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: ModelChainAlertReporterOptions) {
    this.channelId = options.channelId;
    this.sendMessage = options.sendMessage;
    this.now = options.now ?? Date.now;
    this.cooldownMs = options.cooldownMs ?? MODEL_CHAIN_ALERT_COOLDOWN_MS;
  }

  async report(event: ModelChainExhaustedEvent): Promise<ModelChainAlertResult> {
    const reservedAtMs = this.now();
    if (reservedAtMs - this.lastAlertAtMs < this.cooldownMs) return 'suppressed';

    // Reserve before the await so concurrent failures cannot all post.
    this.lastAlertAtMs = reservedAtMs;
    try {
      const sent = await this.sendMessage(this.channelId, formatModelChainAlert(event));
      if (sent) return 'sent';
    } catch {
      // The caller logs the operational failure. Reset below so the next model
      // exhaustion can retry instead of losing the whole cooldown window.
    }

    if (this.lastAlertAtMs === reservedAtMs) {
      this.lastAlertAtMs = Number.NEGATIVE_INFINITY;
    }
    return 'failed';
  }
}
