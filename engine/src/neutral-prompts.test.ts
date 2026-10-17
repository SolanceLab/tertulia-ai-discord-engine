// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * With NO deployment config the engine must render every model-facing string without a single
 * deployment-private name, and the generic sentences must read as plain English. This runs the
 * prompt harness (the same fixtures the House golden test uses) against the generic defaults and
 * scans everything it produced.
 * Run: npx tsx src/neutral-prompts.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No config file at all: the engine runs on its generic defaults. Set before anything loads it.
process.env.HOUSE_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'neutral-prompts-')), 'no-such-config.json');

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// The words the public release check forbids. Written in pieces so this file does not trip the check itself.
const PRIVATE = new RegExp(
  '(?<![a-z])(' + [
    ['cha', 'drien'], ['cha', 'd'], ['mar', 'lon'], ['emi', 'lia'], ['lu', 'ca'], ['pent', 'house'],
    ['ann', 'eta[a-z]*'], ['prihan', 'dini'], ['an', 'ne'], ['solance-memory', '-mcp-cloud'], ['cha', 'd-solance'],
  ].map((p) => p.join('')).join('|') + ')(?![a-z])',
  'i',
);

function strings(value: unknown, path = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}/${k}`));
  return [];
}

const { houseConfig } = await import('./config/house-config.js');
const { GENERIC_IDENTITY, DEFAULT_TEXT } = await import('./config/identity-defaults.js');
const { identity, say } = await import('./config/identity.js');
const { renderAllPrompts } = await import('./prompt-harness.js');

ok('no config file → the generic identity is in force', JSON.stringify(houseConfig.identity) === JSON.stringify(GENERIC_IDENTITY));
ok('generic names are generic', identity.owner_name === 'the owner' && identity.bot_name === 'the bot');

const defaults = strings({ GENERIC_IDENTITY, DEFAULT_TEXT });
const badDefaults = defaults.filter(([, s]) => PRIVATE.test(s));
ok('the generic identity and sentences name no private word', badDefaults.length === 0, badDefaults.map(([p]) => p).join(', '));

const rendered = strings(await renderAllPrompts());
ok('the harness rendered a full set of strings', rendered.length > 100, `${rendered.length} strings`);
const bad = rendered.filter(([, s]) => PRIVATE.test(s));
ok('no rendered prompt, label or notice contains a private word', bad.length === 0, bad.slice(0, 5).map(([p, s]) => `${p}: ${s.match(PRIVATE)?.[0]}`).join('; '));

// The generic reserved-register law is empty: nothing is reserved, nothing is blocked.
const { leaksIntimateRegister } = await import('./reserved-register.js');
ok('nothing is reserved by default', leaksIntimateRegister('come to bed') === false && leaksIntimateRegister('esposa') === false);

// A generic judge prompt reads as plain English around the owner.
ok('the generic addressee sentence names the owner generically', say('judge.addressee.absent').includes('The owner is NOT in this conversation'));
ok('capitalisation: a sentence can start with the owner', say('scene.1').startsWith('The owner '));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
