// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/house-hooks.test.ts — the optional hooks module: no-op when absent, one gate when present. */
import './test-env.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookCandidates, loadHouseHooks, getHouseHooks, NOOP_HOOKS, setHouseHooks } from './house-hooks.js';
import { isIgnoredAuthor } from './presence-config.js';
import { stripIgnoredMessages, windowHidden } from './presence/window.js';
import { buildContextBlock } from './reply-context.js';
import { PresenceEngine } from './presence-engine.js';
import type { WindowMessage } from './presence-engine.js';
import { DEFAULTS } from './presence-config.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

const A = '700000000000000001', B = '700000000000000002';
const wm = (id: string, authorId: string, content = 'hi'): WindowMessage => ({
  id, authorId, authorName: `n${authorId.slice(-1)}`, authorUsername: 'u', content, isFromOwner: false, isFromMe: false, timestampMs: Number(id) * 1000,
});

const dir = mkdtempSync(join(tmpdir(), 'hooks-test-'));
const errs: string[] = [];
const origWrite = process.stderr.write.bind(process.stderr);
const quiet = (on: boolean) => { (process.stderr as any).write = on ? ((s: any) => { errs.push(String(s)); return true; }) : origWrite; };

(async () => {
  try {
    // ── absent module: no-op, nothing hidden, nothing logged as an error ──
    {
      const hooks = await loadHouseHooks([join(dir, 'nope.js')]);
      ok('absent: no-op hooks', hooks === NOOP_HOOKS && getHouseHooks() === NOOP_HOOKS);
      ok('absent: nobody hidden', !isIgnoredAuthor(A, []) && isIgnoredAuthor(A, [A]));
      const w = [wm('1', A), wm('2', B)];
      ok('absent: empty ignore list returns the same window', stripIgnoredMessages(w, []) === w);
    }
    ok('candidates: the compiled sibling is always first', hookCandidates('/x/dist/house-hooks.js').length === 1 && hookCandidates('/x/dist/house-hooks.js')[0].endsWith('house.hooks.js'));
    ok('candidates: the source tree adds a second place', hookCandidates('/x/bot/src/house-hooks.ts').length === 2);

    // ── present module: one gate everywhere ──
    {
      const file = join(dir, 'good.mjs');
      writeFileSync(file, `export const hooks = { hideAuthor: (id) => id === '${A}' };`);
      const hooks = await loadHouseHooks([file]);
      ok('present: loaded', typeof hooks.hideAuthor === 'function');
      ok('gate: hook author is ignored with an empty list', isIgnoredAuthor(A, []) && !isIgnoredAuthor(B, []));
      ok('gate: unresolved author is never hidden', !isIgnoredAuthor(null, []) && !isIgnoredAuthor(undefined, []));
      const w = [wm('1', A, 'secret'), wm('2', B, 'visible')];
      const out = stripIgnoredMessages(w, []);
      ok('strip: hook author removed even with an empty ignore list', out.length === 1 && out[0].authorId === B);
      ok('strip: remaining window is marked hidden', windowHidden(out));
      const ctx = buildContextBlock({ targetId: '9', before: [{ id: '1', authorId: A, authorName: 'x', content: 'secret' }, { id: '2', authorId: B, authorName: 'y', content: 'visible' }] }, 4000);
      ok('reply context: hook author left out of the block', !ctx.includes('secret') && ctx.includes('visible'));

      // respond() with `only`: the one message is kept, no door, a note line and the neutral hidden line appear
      const captured: string[] = [];
      const engine = new PresenceEngine('http://sanctum.invalid', 'k', 'PERSONA', () => 1_760_000_000_000, undefined, undefined, undefined, { get: async () => ({ ...DEFAULTS }) } as any);
      engine.setModelProvider({
        singleModel: true, identity: { engine: 't', model: 't' },
        async complete(_t: any, system: string) { captured.push(system); return { ok: true, text: 'hello', engine: 't', model: 't' }; },
        async prepare() { return null; }, async postComplete() { throw new Error('unused'); },
      } as any);
      engine.setSelfId('700000000000000009');
      await engine.respond('room', [wm('5', A, 'only-this-line')], undefined, false, [], undefined, 'only-this-line', undefined, { note: 'Keep it short.' });
      ok('respond only: message survives the door', captured[0]?.includes('only-this-line') === true);
      ok('respond only: note line present', captured[0]?.includes('- Keep it short.') === true);
      ok('respond only: neutral hidden line present, the word limited absent', captured[0]?.includes('not visible to you') === true && !/limited/i.test(captured[0]!));
      // one-message answer: stored memory and recall stay out of the prompt and the model call
      captured.length = 0;
      const recalls: unknown[] = [];
      (engine as any).modelProvider.complete = async (_t: any, system: string, _u: any, _m: any, recall: unknown) => { captured.push(system); recalls.push(recall); return { ok: true, text: 'hello', engine: 't', model: 't' }; };
      const mem = { carryingForward: 'CARRY-X', recentJournal: 'JOURNAL-X', peopleNotes: 'PEOPLE-X' };
      await engine.respond('room', [wm('5', A, 'only-this-line')], mem as any, false, [], undefined, 'only-this-line', undefined, { note: 'Keep it short.' });
      ok('respond only: no carrying-forward, journal or people notes', !/CARRY-X|JOURNAL-X|PEOPLE-X/.test(captured[0] ?? ''));
      ok('respond only: no recall requested', recalls[0] === undefined);
      await engine.respond('room', [wm('6', B, 'plain')], mem as any, false, [], undefined, 'plain');
      ok('respond without only: memory still travels', /CARRY-X/.test(captured[1] ?? ''));
      captured.length = 0;
      await engine.respond('room', [wm('5', A, 'door-line')], undefined, false, [], undefined, 'door-line');
      ok('respond without only: hook author still stripped at the door', !captured[0]?.includes('door-line'));
    }

    // ── broken module: loud, then no-op ──
    {
      const file = join(dir, 'bad.mjs');
      writeFileSync(file, `export const hooks = { hideAuthor: 'not a function' };`);
      errs.length = 0; quiet(true);
      const hooks = await loadHouseHooks([file]); quiet(false);
      ok('broken: falls back to no-op', hooks === NOOP_HOOKS && !isIgnoredAuthor(A, []));
      ok('broken: says so in the log', errs.some((e) => /failed to load/.test(e)));
      writeFileSync(join(dir, 'throws.mjs'), `throw new Error('boom');`);
      errs.length = 0; quiet(true);
      await loadHouseHooks([join(dir, 'throws.mjs')]); quiet(false);
      ok('throws on import: no-op and logged', getHouseHooks() === NOOP_HOOKS && errs.some((e) => /boom/.test(e)));
    }

    // ── a hook that throws hides nobody ──
    setHouseHooks({ hideAuthor: () => { throw new Error('x'); } });
    ok('throwing hideAuthor: treated as false', !isIgnoredAuthor(A, []));
  } finally {
    quiet(false);
    setHouseHooks(null);
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
