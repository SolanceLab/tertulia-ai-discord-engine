// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Study summons — Owen's secret /study (study-summons.ts) and the window record (presence-config.ts).
 * Run: npx tsx src/study-summons.test.ts
 */
import './test-env.js';
import { handleStudyInteraction, clampMinutes, STUDY_COMMAND } from './study-summons.js';
import { PresenceConfig, parseStudy, studyHolds, type StudyWindow, STUDY_DEFAULT } from './presence-config.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const OWEN = '100000000000000001';
const CH = '1542982272456593428';
const GUILD = '700000000000000998';
const open = (over: Partial<StudyWindow> = {}): StudyWindow => ({
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
  ok('command: user install only (integration_types [1])', JSON.stringify(STUDY_COMMAND.integration_types) === '[1]');
  ok('command: usable in guilds, bot DM and private channels', JSON.stringify(STUDY_COMMAND.contexts) === '[0,1,2]');

  ok('clamp: default 30', clampMinutes(null) === 30);
  ok('clamp: floor 5, ceiling 240', clampMinutes(1) === 5 && clampMinutes(999) === 240);

  // not Owen → private refusal, nothing opened
  {
    let opened = false;
    const f = fakeInteraction('123456789012345678');
    await handleStudyInteraction(f.i, { ownerUserId: OWEN, openStudy: async () => { opened = true; return open(); }, noteStudy: () => {}, log: () => {} });
    ok('not Owen: refused, ephemeral, nothing opened', !opened && f.replies.length === 1 && f.replies[0].flags === 64 && /Not available/.test(f.replies[0].content));
  }

  // Owen → window opened, noted locally, ephemeral confirmation
  {
    let args: any[] = []; let noted: StudyWindow | null = null;
    const f = fakeInteraction(OWEN, 45);
    let watched = false;
    await handleStudyInteraction(f.i, { ownerUserId: OWEN, openStudy: async (...a) => { args = a; return open({ minutes: 45, claimed_at: null, ready_at: null }); }, noteStudy: (s) => { noted = s; }, watchUntilReady: () => { watched = true; }, log: () => {} });
    ok('Owen: starts the ready watch', watched);
    ok('Owen: opens window with channel, guild and minutes', args[0] === CH && args[1] === GUILD && args[2] === 45);
    ok('Owen: window noted locally at once', noted !== null && (noted as StudyWindow).nonce === 'n1');
    ok('Owen: deferred ephemeral first, then confirmed', f.replies[0].content === '(deferred)' && f.replies[0].flags === 64 && /45 min/.test(f.replies[1].content));
  }

  // failed write → honest ephemeral failure, nothing noted
  {
    let noted = false;
    const f = fakeInteraction(OWEN);
    await handleStudyInteraction(f.i, { ownerUserId: OWEN, openStudy: async () => null, noteStudy: () => { noted = true; }, log: () => {} });
    ok('write failed: says so privately, nothing noted', !noted && f.replies[0].flags === 64 && /Couldn't open/.test(f.replies[1].content));
  }

  // agent switch off → says so, nothing opened
  {
    let opened = false;
    const f = fakeInteraction(OWEN);
    await handleStudyInteraction(f.i, { ownerUserId: OWEN, agentEnabled: () => false, openStudy: async () => { opened = true; return open(); }, noteStudy: () => {}, log: () => {} });
    ok('agent off: window not opened, owner told', !opened && /agent is off/.test(f.replies[1].content));
  }

  // another command name → not ours
  {
    const f = fakeInteraction(OWEN);
    const handled = await handleStudyInteraction({ ...f.i, commandName: 'other' }, { ownerUserId: OWEN, openStudy: async () => open(), noteStudy: () => {}, log: () => {} });
    ok('other command: not handled, no reply', handled === false && f.replies.length === 0);
  }

  // parseStudy: malformed never silences Sanctum
  ok('parse: valid open window', parseStudy(open()).active === true);
  ok('parse: missing nonce → inactive', parseStudy({ ...open(), nonce: null }).active === false);
  ok('parse: bad channel id → inactive', parseStudy({ ...open(), channel_id: 'general' }).active === false);
  ok('parse: offset timestamp → inactive', parseStudy({ ...open(), expires_at: '2026-10-02T14:30:00+07:00' }).active === false);
  ok('parse: closed record keeps identity, inactive', (() => { const p = parseStudy({ ...open(), active: false, closed_at: '2026-10-02T07:05:00.000Z' }); return !p.active && p.nonce === 'n1' && p.opened_at === '2026-10-02T07:00:00.000Z'; })());

  // studyHolds: only that channel, only before expiry
  const T = Date.parse('2026-10-02T07:10:00Z');
  ok('holds: same channel, before expiry', studyHolds(open(), CH, T));
  ok('holds: other channel → no', !studyHolds(open(), '999999999999999999', T));
  ok('holds: after expiry → no', !studyHolds(open(), CH, Date.parse('2026-10-02T07:31:00Z')));
  ok('holds: default → no', !studyHolds(STUDY_DEFAULT, CH, T));
  ok('holds: claimed but NOT ready → no (a Study that never starts never silences Sanctum)', !studyHolds(open({ ready_at: null }), CH, T));
  ok('parse: ready_at carried through', parseStudy(open()).ready_at === '2026-10-02T07:00:40.000Z');

  // getStudy precedence: local open vs polled close/extend
  {
    const pc = new PresenceConfig('http://x', 'k');
    (pc as any).lastKnown = { study: parseStudy({ ...open(), active: false, closed_at: '2026-10-02T07:05:00.000Z' }) };
    pc.noteStudy(open());
    ok('getStudy: Mac closed the same window → closed wins over my local open', pc.getStudy().active === false);
    (pc as any).lastKnown = { study: open({ expires_at: '2026-10-02T08:00:00.000Z' }) };
    ok('getStudy: Mac extended the same window → extended copy wins', pc.getStudy().expires_at === '2026-10-02T08:00:00.000Z');
    (pc as any).lastKnown = { study: { ...STUDY_DEFAULT } };
    ok('getStudy: poll has nothing yet → my local open stands', pc.getStudy().active === true);
    (pc as any).lastKnown = { study: open({ nonce: 'n0', opened_at: '2026-10-02T06:00:00.000Z' }) };
    ok('getStudy: older polled window → my newer local wins', pc.getStudy().nonce === 'n1');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
