// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * A config path someone set on purpose (CONFIG_PATH, or its earlier name HOUSE_CONFIG_PATH) that is missing
 * or not JSON stops startup, like the hooks file. Unset keeps the fixed candidates, then neutral defaults.
 * Run: npx tsx src/config-path-loud.test.ts
 */
import './test-env.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeploymentConfig } from './config/deployment-config.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ FAIL ${name}`); } }
function message(fn: () => unknown): string { try { fn(); return ''; } catch (e: any) { return String(e?.message); } }

const realWarn = console.warn;
console.warn = () => {};
const dir = mkdtempSync(join(tmpdir(), 'config-path-loud-'));
const missing = join(dir, 'missing.json');
const bad = join(dir, 'bad.json');
writeFileSync(bad, '{ not json');
const good = join(dir, 'good.json');
writeFileSync(good, JSON.stringify({ homeServerId: '700000000000000001' }));

const m1 = message(() => loadDeploymentConfig({ CONFIG_PATH: missing } as any));
ok('set + missing throws, naming the path and CONFIG_PATH', m1.includes(missing) && m1.includes('CONFIG_PATH'));
const m2 = message(() => loadDeploymentConfig({ CONFIG_PATH: bad } as any));
ok('set + bad JSON throws, naming the path and CONFIG_PATH', m2.includes(bad) && m2.includes('CONFIG_PATH'));
const m3 = message(() => loadDeploymentConfig({ HOUSE_CONFIG_PATH: missing } as any));
ok('earlier name + missing throws, naming the path and HOUSE_CONFIG_PATH', m3.includes(missing) && m3.includes('HOUSE_CONFIG_PATH'));
ok('set + good file still loads', loadDeploymentConfig({ CONFIG_PATH: good } as any).homeServerId === '700000000000000001');
ok('unset still falls back without throwing', message(() => loadDeploymentConfig({} as any)) === '');

console.warn = realWarn;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
