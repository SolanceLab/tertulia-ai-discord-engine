// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Run: npx tsx src/migrating-doc.test.ts — docs/migrating.md names every alias the two alias modules still read
 * (engine/src/config/legacy-names.ts and dashboard/lib/legacy-names.js), and the README and the CHANGELOG link to it.
 * Each name must appear in backticks, so a name that is a part of a longer one cannot stand in for it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ENV_ALIASES, configFileCandidates, REMOVED_PLUG_VALUES, hooksFileCandidates, LEGACY_ASIDE_ROUTE_PREFIX,
  RULES_KEY_RENAMES, LABEL_KEY_RENAMES, ASIDE_ROUTE_PREFIX, KEY_RENAMES,
} from './config/legacy-names.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = readFileSync(join(repo, 'docs', 'migrating.md'), 'utf8');
const missing = (names: Iterable<string>): string[] => [...new Set(names)].filter((n) => !doc.includes(`\`${n}\``));

// the dashboard module is plain JS outside the engine's type-checked tree
const dash: any = await import(pathToFileURL(join(repo, 'dashboard', 'lib', 'legacy-names.js')).href);

// ── the engine's alias module ──
const join_ = (...p: string[]) => p.join('/');
const fileNames = new Set([...configFileCandidates('/b/bot', '/b/dist', join_), ...hooksFileCandidates('/b/dist', true, join_)]
  .map((p) => p.split('/').slice(-1)[0]));
const earlierFiles = [...fileNames].filter((f) => /house/.test(f));
ok('the files test found the earlier file names', earlierFiles.includes('discord.house.json') && earlierFiles.includes('house.hooks.js'));

const checks: Array<[string, string[]]> = [
  ['earlier environment variables', Object.values(ENV_ALIASES)],
  ['new environment variables', Object.keys(ENV_ALIASES)],
  ['earlier config file name', earlierFiles],
  ['the earlier layer folder', ['house/', 'house/hooks.ts', 'deployment/hooks.ts']],
  ['earlier config keys', Object.keys(KEY_RENAMES)],
  ['new config keys', Object.values(KEY_RENAMES)],
  ['earlier per-server rule keys', Object.keys(RULES_KEY_RENAMES)],
  ['new per-server rule keys', Object.values(RULES_KEY_RENAMES)],
  ['earlier label keys', Object.keys(LABEL_KEY_RENAMES)],
  ['new label keys', Object.values(LABEL_KEY_RENAMES)],
  ['removed plug values', [...REMOVED_PLUG_VALUES]],
  ['earlier context-log, aside and source values', ['house_channels', 'this_server', 'study', 'agent', 'curfew', 'quiet_hours', 'sanctum', 'model']],
  ['identity text key prefixes', ['curfew.*', 'quiet.*', 'scene.*', 'focus.*']],
  ['the command-line flag', ['--study', '--agent']],
  ['the HTTP route', [`${LEGACY_ASIDE_ROUTE_PREFIX}/*`, `${ASIDE_ROUTE_PREFIX}/*`]],
  ['the dashboard host methods', ['getCurfew', 'setCurfew', 'getQuietHours', 'setQuietHours']],
  ['the dashboard module: earlier config keys', Object.keys(dash.KEYS)],
  ['the dashboard module: new config keys', Object.values(dash.KEYS) as string[]],
  ['the dashboard module: per-server rule keys', [...Object.keys(dash.RULE_KEYS), ...(Object.values(dash.RULE_KEYS) as string[])]],
  ['the dashboard module: earlier label keys', Object.keys(dash.LABEL_KEYS)],
  ['the dashboard module: new label keys', Object.values(dash.LABEL_KEYS) as string[]],
  ['the dashboard module: the earlier nudge word', [dash.EARLIER_NUDGE_NOUN]],
];
for (const [what, names] of checks) {
  const gone = missing(names);
  ok(`migrating.md names ${what}`, gone.length === 0, gone.length ? `missing: ${gone.join(', ')}` : '');
}

// the behaviour changes and the new required settings
for (const [what, needle] of [
  ['the removed hosted plug values and `custom`', '`custom`'],
  ['the new required model provider', '`MODEL_API_KEY`'],
  ['the time zone default', 'default `UTC`'],
  ['quiet hours, away and transcript times', 'the times shown in the conversation'],
  ['the empty status default', 'The default is empty'],
  ['PROFILE_FILES_DIR off by default', '`PROFILE_FILES_DIR` is off by default'],
  ['owner tools returning every message', 'return every message'],
  ['the hooks path setting', '`TERTULIA_HOOKS_PATH`'],
] as const) {
  ok(`migrating.md states ${what}`, doc.includes(needle));
}

// the page is linked from where a reader starts
ok('README links docs/migrating.md', /\]\(docs\/migrating\.md\)/.test(readFileSync(join(repo, 'README.md'), 'utf8')));
const newest = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8').split(/^## /m)[1] ?? ''; // the top section: Unreleased or the version being released
ok('CHANGELOG newest section links docs/migrating.md', /\]\(docs\/migrating\.md\)/.test(newest));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
