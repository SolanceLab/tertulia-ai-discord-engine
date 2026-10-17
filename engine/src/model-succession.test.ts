// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/model-succession.test.ts */
import './test-env.js';
import { ModelSuccession, isRetiredError, pickSuccessor } from './model-succession.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// The real catalog slice from 28 Sep 2026.
const CATALOG = [
  'deepseek-ai/deepseek-coder-6.7b-instruct',
  'deepseek-ai/deepseek-v4.1-flash',
  'mistralai/mistral-large',
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k3',
  'z-ai/glm-5.3',
  'z-ai/glm-5.3-flash',
];

async function run() {
  // ── detection ──
  ok('real NVIDIA 410 body via Sanctum is retirement',
    isRetiredError('{"error":"z-ai/glm-5.2 API 410: {\\"title\\":\\"Gone\\",\\"status\\":410,\\"detail\\":\\"The model has reached its end of life\\"}"}'));
  ok('"no longer available" alone counts', isRetiredError('model is no longer available'));
  ok('a 404 not-found is NOT retirement', !isRetiredError('API 404: Function not found for account'));
  ok('a timeout is NOT retirement', !isRetiredError('This operation was aborted'));
  ok('a 429 is NOT retirement', !isRetiredError('API 429: rate limited'));
  ok('empty/undefined is NOT retirement', !isRetiredError(undefined) && !isRetiredError(''));

  // ── succession picks the same family and variant ──
  ok('glm-5.2 → glm-5.3 (not the -flash variant)', pickSuccessor('z-ai/glm-5.2', CATALOG) === 'z-ai/glm-5.3');
  ok('deepseek-v4-flash → deepseek-v4.1-flash', pickSuccessor('deepseek-ai/deepseek-v4-flash', CATALOG) === 'deepseek-ai/deepseek-v4.1-flash');
  ok('glm-5.3-flash has no newer flash → null', pickSuccessor('z-ai/glm-5.3-flash', CATALOG) === null);
  ok('never crosses family (coder is not a v-model successor)',
    pickSuccessor('deepseek-ai/deepseek-v4-flash', ['deepseek-ai/deepseek-coder-9']) === null);
  ok('never crosses vendor', pickSuccessor('z-ai/glm-5.2', ['other/glm-5.9']) === null);
  ok('an older version is never picked', pickSuccessor('z-ai/glm-5.3', ['z-ai/glm-5.2']) === null);
  ok('the newest of several wins', pickSuccessor('z-ai/glm-5.2', ['z-ai/glm-5.3', 'z-ai/glm-5.10', 'z-ai/glm-5.4']) === 'z-ai/glm-5.10');
  ok('an id with no version → null', pickSuccessor('vendor/model', CATALOG) === null);

  // ── ModelSuccession behaviour ──
  {
    const notes: string[] = [];
    let fetches = 0;
    const s = new ModelSuccession({ fetchCatalog: async () => { fetches++; return CATALOG; }, notify: (m) => { notes.push(m); } });
    const glm = { engine: 'nvidia', model: 'z-ai/glm-5.2' };
    ok('resolve before retirement is the target itself', s.resolve(glm).model === 'z-ai/glm-5.2');
    const [a, b] = await Promise.all([s.noteRetired(glm), s.noteRetired(glm)]);
    ok('retirement returns the successor', a?.model === 'z-ai/glm-5.3' && b?.model === 'z-ai/glm-5.3');
    ok('concurrent reports share one catalog fetch', fetches === 1);
    ok('Owen is told exactly once', notes.length === 1 && notes[0].includes('z-ai/glm-5.3') && notes[0].includes('z-ai/glm-5.2'));
    ok('resolve now returns the successor', s.resolve(glm).model === 'z-ai/glm-5.3');
    await s.noteRetired(glm);
    ok('a later report does not notify again', notes.length === 1 && fetches === 1);
  }
  {
    const notes: string[] = [];
    const s = new ModelSuccession({ fetchCatalog: async () => CATALOG, notify: (m) => { notes.push(m); } });
    const r = await s.noteRetired({ engine: 'nvidia', model: 'z-ai/glm-5.3-flash' });
    ok('no successor → null', r === null);
    ok('no successor → Owen is still told', notes.length === 1 && notes[0].includes('no newer model'));
    await s.noteRetired({ engine: 'nvidia', model: 'z-ai/glm-5.3-flash' });
    ok('no successor → told only once', notes.length === 1);
  }
  {
    const notes: string[] = [];
    let fetched = false;
    const s = new ModelSuccession({ fetchCatalog: async () => { fetched = true; return CATALOG; }, notify: (m) => { notes.push(m); } });
    const r = await s.noteRetired({ engine: 'kimi', model: 'kimi-k2.6' });
    ok('non-catalog engine never switches', r === null && !fetched);
    ok('non-catalog engine retirement is still reported', notes.length === 1);
  }
  {
    // Catalog down: no switch, no notice, and a later report can try again.
    let up = false;
    const notes: string[] = [];
    const s = new ModelSuccession({
      fetchCatalog: async () => { if (!up) throw new Error('down'); return CATALOG; },
      notify: (m) => { notes.push(m); },
    });
    const glm = { engine: 'nvidia', model: 'z-ai/glm-5.2' };
    ok('catalog down → null, nothing sent', (await s.noteRetired(glm)) === null && notes.length === 0);
    up = true;
    ok('catalog back → the retry finds the successor', (await s.noteRetired(glm))?.model === 'z-ai/glm-5.3' && notes.length === 1);
  }
  {
    // A failing notify must not break succession.
    const s = new ModelSuccession({ fetchCatalog: async () => CATALOG, notify: () => { throw new Error('dm failed'); } });
    ok('notify throwing still returns the successor', (await s.noteRetired({ engine: 'nvidia', model: 'z-ai/glm-5.2' }))?.model === 'z-ai/glm-5.3');
  }

  {
    // Two retirements in a row: resolve follows the whole line.
    let catalog = ['z-ai/glm-5.3'];
    const s = new ModelSuccession({ fetchCatalog: async () => catalog, notify: () => {} });
    await s.noteRetired({ engine: 'nvidia', model: 'z-ai/glm-5.2' });
    catalog = ['z-ai/glm-5.4'];
    await s.noteRetired({ engine: 'nvidia', model: 'z-ai/glm-5.3' });
    ok('5.2 → 5.3 → 5.4: resolve(5.2) lands on 5.4', s.resolve({ engine: 'nvidia', model: 'z-ai/glm-5.2' }).model === 'z-ai/glm-5.4');
    ok('re-reporting 5.2 also answers 5.4', (await s.noteRetired({ engine: 'nvidia', model: 'z-ai/glm-5.2' }))?.model === 'z-ai/glm-5.4');
  }
  {
    // A DM that never delivers must not hold up the successor.
    const s = new ModelSuccession({ fetchCatalog: async () => CATALOG, notify: () => new Promise<void>(() => {}) });
    const r = await Promise.race([
      s.noteRetired({ engine: 'nvidia', model: 'z-ai/glm-5.2' }),
      new Promise<'stalled'>((res) => setTimeout(() => res('stalled'), 200)),
    ]);
    ok('a stalled DM does not delay the successor', r !== 'stalled' && (r as any)?.model === 'z-ai/glm-5.3');
  }

  {
    // An EMPTY catalog is "unavailable", not "no successor" — retried later.
    let catalog: string[] = [];
    const notes: string[] = [];
    const s = new ModelSuccession({ fetchCatalog: async () => catalog, notify: (m) => { notes.push(m); } });
    const glm = { engine: 'nvidia', model: 'z-ai/glm-5.2' };
    ok('empty catalog → null and no notice', (await s.noteRetired(glm)) === null && notes.length === 0);
    catalog = CATALOG;
    ok('catalog filled later → successor found', (await s.noteRetired(glm))?.model === 'z-ai/glm-5.3' && notes.length === 1);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
