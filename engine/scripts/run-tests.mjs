#!/usr/bin/env node
// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// npm test — runs every src/*.test.ts with tsx, one process each, and fails if any file fails.
// (Phase A, 12 Oct 2026: there was no test script; each suite was run by hand.)
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// The House layer's own tests (../house/*.test.ts) run too when that folder exists; the public export has none.
const houseDir = '../house';
const files = [
  ...readdirSync('src').filter((f) => f.endsWith('.test.ts')).sort().map((f) => `src/${f}`),
  ...(existsSync(houseDir) ? readdirSync(houseDir).filter((f) => f.endsWith('.test.ts')).sort().map((f) => `${houseDir}/${f}`) : []),
];
const failed = [];
for (const f of files) {
  const r = spawnSync('npx', ['tsx', f], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed.push(f);
  const tail = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${f}${tail ? `  — ${tail.slice(0, 80)}` : ''}`);
  if (!ok) console.log((r.stdout || '').split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 8).join('\n') + (r.stderr ? `\n${r.stderr.slice(0, 600)}` : ''));
}
console.log(`\n${files.length - failed.length} of ${files.length} test files pass`);
process.exit(failed.length ? 1 : 0);
