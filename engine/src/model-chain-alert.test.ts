// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import './test-env.js';
import {
  ModelChainAlertReporter,
  type ModelChainExhaustedEvent,
  formatModelChainAlert,
} from './model-chain-alert.js';

let pass = 0;
let fail = 0;
function ok(name: string, condition: boolean) {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`);
  }
}

const event: ModelChainExhaustedEvent = {
  context: {
    channelId: '700000000000000103',
    channelName: 'guest-hall',
    mode: 'direct reply',
  },
  attempts: [
    { engine: 'nvidia', model: 'z-ai/glm-5.2', reason: 'timed out after 30s' },
    { engine: 'nvidia', model: 'deepseek-ai/deepseek-v4-flash', reason: 'timed out after 30s' },
    { engine: 'kimi', model: 'kimi-k3', reason: 'provider returned HTTP 502', status: 502 },
    { engine: 'grok', model: 'grok-4.5', reason: 'request failed before a response' },
  ],
};

async function run() {
  const formatted = formatModelChainAlert(event);
  ok('alert names the exhausted chain', formatted.includes('Discord model chain exhausted'));
  ok('alert names the origin channel', formatted.includes('#guest-hall'));
  ok('alert includes every attempted model', event.attempts.every((attempt) => formatted.includes(attempt.model)));
  ok('alert is Discord-safe length', formatted.length < 2000);

  let clock = 1_000_000;
  const sent: Array<{ channelId: string; content: string }> = [];
  const reporter = new ModelChainAlertReporter({
    channelId: '700000000000000108',
    now: () => clock,
    cooldownMs: 15 * 60_000,
    sendMessage: async (channelId, content) => {
      sent.push({ channelId, content });
      return { id: `alert-${sent.length}` };
    },
  });

  ok('first exhaustion posts', await reporter.report(event) === 'sent');
  ok('alert posts to the requested operations channel', sent[0]?.channelId === '700000000000000108');
  ok('repeat exhaustion inside cooldown is suppressed', await reporter.report(event) === 'suppressed' && sent.length === 1);

  clock += 15 * 60_000;
  ok('exhaustion after cooldown posts again', await reporter.report(event) === 'sent' && sent.length === 2);

  let shouldFail = true;
  const retryingReporter = new ModelChainAlertReporter({
    channelId: '700000000000000108',
    now: () => clock,
    sendMessage: async () => {
      if (shouldFail) return null;
      return { id: 'recovered' };
    },
  });
  ok('failed Discord delivery is reported as failed', await retryingReporter.report(event) === 'failed');
  shouldFail = false;
  ok('failed delivery does not consume the cooldown', await retryingReporter.report(event) === 'sent');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
