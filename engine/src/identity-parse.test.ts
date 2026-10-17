// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/identity-parse.test.ts — a malformed identity block must never crash startup or open a gate. */
import { parseIdentity } from './config/identity-defaults.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const warn = console.warn;
console.warn = () => {};
const bad = parseIdentity({ intimate_tells: '(', reserved_names: '[', name_gate: { terms: ['x'], until: 'not a date' } });
ok('invalid intimate_tells regex falls back to null', bad.intimate_tells === null);
ok('invalid reserved_names regex falls back to null', bad.reserved_names === null);
ok('invalid name_gate.until falls back to null (gate stays closed)', bad.name_gate.until === null && bad.name_gate.terms.length === 1);
const good = parseIdentity({ intimate_tells: '\\bfoo\\b', reserved_names: 'bar', name_gate: { terms: ['x'], until: '2030-01-01T00:00:00Z' } });
ok('valid values pass through', good.intimate_tells === '\\bfoo\\b' && good.reserved_names === 'bar' && good.name_gate.until === '2030-01-01T00:00:00Z');
console.warn = warn;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
