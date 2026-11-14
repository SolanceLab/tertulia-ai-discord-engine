// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/hook-errors.test.ts — a hook that throws is logged once per distinct error, and hides or reveals nobody. */
import './test-env.js';
import { hookHidesMessage, hookRevealsAuthor, hookHidesAuthor, setHooks } from './hooks.js';
import { logger } from './logger.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } }
const errs: string[] = [];
(logger as any).error = (_t: string, msg: string, extra?: any) => { errs.push(`${msg} ${extra?.error ?? ''}`); };
const facts = { authorId: '7', content: 'x', mentionsBot: false, repliesToBot: false, msSinceBotSpokeInChannel: null };

setHooks({ hideAuthor: () => { throw new Error('a'); }, hideMessage: () => { throw new Error('b'); }, revealAuthor: () => { throw new Error('c'); } });
for (let i = 0; i < 5; i++) { hookHidesAuthor('7'); hookHidesMessage(facts); hookRevealsAuthor('7'); }
ok('throwing hooks hide and reveal nobody', !hookHidesAuthor('7') && !hookHidesMessage(facts) && !hookRevealsAuthor('7'));
ok('each distinct error is logged once, not per message', errs.length === 3);
let n = 0;
setHooks({ hideMessage: () => { throw new Error(`e${n++}`); } });
errs.length = 0; hookHidesMessage(facts); hookHidesMessage(facts);
ok('a different error is logged again', errs.length === 2);
setHooks(null);
ok('absent hooks change nothing', !hookHidesAuthor('7') && !hookHidesMessage(facts) && !hookRevealsAuthor('7'));

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
