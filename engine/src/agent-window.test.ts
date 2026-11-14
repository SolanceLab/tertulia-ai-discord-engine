// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Agent window summons — Owen's secret /wake (agent-window.ts) and the window record (presence-config.ts).
 * Run: npx tsx src/agent-window.test.ts
 */
import './test-env.js';
import { clampMinutes, handleAgentInteraction, AGENT_COMMAND } from './agent-window.js';
import { type AgentWindow, parseAgentWindow, PresenceConfig, AGENT_DEFAULT, agentHolds } from './presence-config.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const OWEN = '100000000000000001';
const CH = '1542982272456593428';
const GUILD = '700000000000000998';
const open = (over: Partial<AgentWindow> = {}): AgentWindow => ({
  active: true, channel_id: CH, guild_id: GUILD, minutes: 30,
  opened_at: '2026-10-02T07:00:00.000Z', expires_at: '2026-10-02T07:30:00.000Z',
  nonce: 'n1', claimed_at: '2026-10-02T07:00:10.000Z', ready_at: '2026-10-02T07:00:40.000Z', closed_at: null, ...over,
});

function fakeInteraction(userId: string, minutes: number | null = null, channelId: string | null = CH) {
  const replies: { content: string; flags: number }[] = [];
  return {
    replies,
    i: {
      commandName: 'wake', user: { id: userId }, channelId, guildId: GUILD,
      options: { getInteger: () => minutes },
      reply: async (o: { content: string; flags: number }) => { replies.push(o); },
      deferReply: async (o: { flags: number }) => { replies.push({ content: '(deferred)', flags: o.flags }); },
      editReply: async (o: { content: string }) => { replies.push({ content: o.content, flags: 64 }); },
    },
  };
}

(async () => {
  // command shape: user-installed only, never a server command
  ok('command: user install only (integration_types [1])', JSON.stringify(AGENT_COMMAND.integration_types) === '[1]');
  ok('command: usable in guilds, bot DM and private channels', JSON.stringify(AGENT_COMMAND.contexts) === '[0,1,2]');

  ok('clamp: default 30', clampMinutes(null) === 30);
  ok('clamp: floor 5, ceiling 240', clampMinutes(1) === 5 && clampMinutes(999) === 240);

  // not Owen → private refusal, nothing opened
  {
    let opened = false;
    const f = fakeInteraction('123456789012345678');
    await handleAgentInteraction(f.i, { ownerUserId: OWEN, openAgentWindow: async () => { opened = true; return open(); }, noteAgentWindow: () => {}, log: () => {} });
    ok('not Owen: refused, ephemeral, nothing opened', !opened && f.replies.length === 1 && f.replies[0].flags === 64 && /Not available/.test(f.replies[0].content));
  }

  // Owen → window opened, noted locally, ephemeral confirmation
  {
    let args: any[] = []; let noted: AgentWindow | null = null;
    const f = fakeInteraction(OWEN, 45);
    let watched = false;
    await handleAgentInteraction(f.i, { ownerUserId: OWEN, openAgentWindow: async (...a) => { args = a; return open({ minutes: 45, claimed_at: null, ready_at: null }); }, noteAgentWindow: (s) => { noted = s; }, watchUntilReady: () => { watched = true; }, log: () => {} });
    ok('Owen: starts the ready watch', watched);
    ok('Owen: opens window with channel, guild and minutes', args[0] === CH && args[1] === GUILD && args[2] === 45);
    ok('Owen: window noted locally at once', noted !== null && (noted as AgentWindow).nonce === 'n1');
    ok('Owen: deferred ephemeral first, then confirmed', f.replies[0].content === '(deferred)' && f.replies[0].flags === 64 && /45 min/.test(f.replies[1].content));
  }

  // failed write → honest ephemeral failure, nothing noted
  {
    let noted = false;
    const f = fakeInteraction(OWEN);
    await handleAgentInteraction(f.i, { ownerUserId: OWEN, openAgentWindow: async () => null, noteAgentWindow: () => { noted = true; }, log: () => {} });
    ok('write failed: says so privately, nothing noted', !noted && f.replies[0].flags === 64 && /Couldn't open/.test(f.replies[1].content));
  }

  // agent switch off → says so, nothing opened
  {
    let opened = false;
    const f = fakeInteraction(OWEN);
    await handleAgentInteraction(f.i, { ownerUserId: OWEN, agentEnabled: () => false, openAgentWindow: async () => { opened = true; return open(); }, noteAgentWindow: () => {}, log: () => {} });
    ok('agent off: window not opened, owner told', !opened && /agent is off/.test(f.replies[1].content));
  }

  // another command name → not ours
  {
    const f = fakeInteraction(OWEN);
    const handled = await handleAgentInteraction({ ...f.i, commandName: 'other' }, { ownerUserId: OWEN, openAgentWindow: async () => open(), noteAgentWindow: () => {}, log: () => {} });
    ok('other command: not handled, no reply', handled === false && f.replies.length === 0);
  }

  // parseAgentWindow: malformed never silences the model service
  ok('parse: valid open window', parseAgentWindow(open()).active === true);
  ok('parse: missing nonce → inactive', parseAgentWindow({ ...open(), nonce: null }).active === false);
  ok('parse: bad channel id → inactive', parseAgentWindow({ ...open(), channel_id: 'general' }).active === false);
  ok('parse: offset timestamp → inactive', parseAgentWindow({ ...open(), expires_at: '2026-10-02T14:30:00+07:00' }).active === false);
  ok('parse: closed record keeps identity, inactive', (() => { const p = parseAgentWindow({ ...open(), active: false, closed_at: '2026-10-02T07:05:00.000Z' }); return !p.active && p.nonce === 'n1' && p.opened_at === '2026-10-02T07:00:00.000Z'; })());

  // agentHolds: only that channel, only before expiry
  const T = Date.parse('2026-10-02T07:10:00Z');
  ok('holds: same channel, before expiry', agentHolds(open(), CH, T));
  ok('holds: other channel → no', !agentHolds(open(), '999999999999999999', T));
  ok('holds: after expiry → no', !agentHolds(open(), CH, Date.parse('2026-10-02T07:31:00Z')));
  ok('holds: default → no', !agentHolds(AGENT_DEFAULT, CH, T));
  ok('holds: claimed but NOT ready → no (a Agent window that never starts never silences the model service)', !agentHolds(open({ ready_at: null }), CH, T));
  ok('parse: ready_at carried through', parseAgentWindow(open()).ready_at === '2026-10-02T07:00:40.000Z');

  // getAgentWindow precedence: local open vs polled close/extend
  {
    const pc = new PresenceConfig('http://x', 'k');
    (pc as any).lastKnown = { agent_window: parseAgentWindow({ ...open(), active: false, closed_at: '2026-10-02T07:05:00.000Z' }) };
    pc.noteAgentWindow(open());
    ok('getAgentWindow: Mac closed the same window → closed wins over my local open', pc.getAgentWindow().active === false);
    (pc as any).lastKnown = { agent_window: open({ expires_at: '2026-10-02T08:00:00.000Z' }) };
    ok('getAgentWindow: Mac extended the same window → extended copy wins', pc.getAgentWindow().expires_at === '2026-10-02T08:00:00.000Z');
    (pc as any).lastKnown = { agent_window: { ...AGENT_DEFAULT } };
    ok('getAgentWindow: poll has nothing yet → my local open stands', pc.getAgentWindow().active === true);
    (pc as any).lastKnown = { agent_window: open({ nonce: 'n0', opened_at: '2026-10-02T06:00:00.000Z' }) };
    ok('getAgentWindow: older polled window → my newer local wins', pc.getAgentWindow().nonce === 'n1');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
