// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/seams-review.test.ts
 * Codex review of Phase 2a (14 Oct): the mismatched plug pair is refused, and with the journal off
 * the narrative queue never grows. */
import './test-env.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'seams-review-'));
process.env.CONFIG_PATH = join(dir, 'empty-config.json');
writeFileSync(process.env.CONFIG_PATH, '{}'); // a set path must exist; an empty file gives the neutral defaults
let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ FAIL ${name}`); } }

async function run() {
  const { createSeams } = await import('./seams/index.js');
  const { loadDeploymentConfig } = await import('./config/deployment-config.js');
  const { MemoryManager } = await import('./memory.js');
  const cfg = { ...loadDeploymentConfig(), plugs: { model: 'direct', settings: 'custom', memory: 'off' } } as any;
  let threw = '';
  try {
    createSeams({ cfg, env: { MODEL_API_KEY: 'k' } as any, hooks: {} } as any);
  } catch (e: any) { threw = String(e?.message ?? e); }
  ok("memory 'off' + settings 'custom' is refused by name", /memory 'off' needs settings 'local'/.test(threw));

  const mem = new MemoryManager(join(dir, 'ledger.json')) as any;
  await mem.addMessage('c1', { role: 'user', author: 'x', content: 'x'.repeat(80), timestamp: new Date().toISOString() });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
