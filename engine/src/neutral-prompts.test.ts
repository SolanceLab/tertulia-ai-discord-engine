// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * With NO deployment config the engine must render every model-facing string without a single
 * deployment-private name, and the generic sentences must read as plain English. This runs the
 * prompt harness against the generic defaults and scans everything it produced. It then scans every
 * tracked non-test file of the public code and docs for the earlier, deployment-specific vocabulary.
 * Run: npx tsx src/neutral-prompts.test.ts
 */
import { mkdtempSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// No config file at all: the engine runs on its generic defaults. Set before anything loads it.
process.env.CONFIG_PATH = join(mkdtempSync(join(tmpdir(), 'neutral-prompts-')), 'empty-config.json');
writeFileSync(process.env.CONFIG_PATH, '{}'); // a set path must exist; an empty file gives the neutral defaults

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

const { deployConfig } = await import('./config/deployment-config.js');
const { GENERIC_IDENTITY, DEFAULT_TEXT } = await import('./config/identity-defaults.js');
const { identity, say } = await import('./config/identity.js');
const { renderAllPrompts } = await import('./prompt-harness.js');

ok('no config file → the generic identity is in force', JSON.stringify(deployConfig.identity) === JSON.stringify(GENERIC_IDENTITY));
ok('generic names are generic', identity.owner_name === 'the owner' && identity.bot_name === 'the bot');

const defaults = strings({ GENERIC_IDENTITY, DEFAULT_TEXT });
const badDefaults = defaults.filter(([, s]) => PRIVATE.test(s));
ok('the generic identity and sentences name no private word', badDefaults.length === 0, badDefaults.map(([p]) => p).join(', '));

const rendered = strings(await renderAllPrompts());
ok('the harness rendered a full set of strings', rendered.length > 100, `${rendered.length} strings`);
const bad = rendered.filter(([, s]) => PRIVATE.test(s));
ok('no rendered prompt, label or notice contains a private word', bad.length === 0, bad.slice(0, 5).map(([p, s]) => `${p}: ${s.match(PRIVATE)?.[0]}`).join('; '));

// The generic reserved-register law is empty: nothing is reserved, nothing is blocked.
const { leaksPrivateRegister } = await import('./reserved-register.js');
ok('nothing is reserved by default', leaksPrivateRegister('come to bed') === false && leaksPrivateRegister('esposa') === false);

// A generic judge prompt reads as plain English around the owner.
ok('the generic addressee sentence names the owner generically', say('judge.addressee.absent').includes('The owner is NOT in this conversation'));
ok('capitalisation: a sentence can start with the owner', say('focus.1').startsWith('The owner '));

// ── the forbidden-word scan ─────────────────────────────────────────────────
// Every tracked non-test file in the public code and docs is read line by line. A word from the earlier,
// deployment-specific vocabulary fails the build unless the line or the file is on the short allowlist below.
// Words are written in pieces so this file does not trip the scan itself.
const w = (...parts: string[]) => parts.join('');
const FORBIDDEN: Array<[string, RegExp]> = [
  ['sanctum', new RegExp(w('sanc', 'tum'), 'i')],
  ['solance-api', new RegExp(w('solance', '-?api'), 'i')],
  ['house of solance', new RegExp(w('house', ' of ', 'solance'), 'i')],
  ['hos (word or prefix)', new RegExp(w('(?<![a-z])ho', 's(?![a-z])|(?<![a-z])ho', 's_'), 'i')],
  ['curfew', new RegExp(w('cur', 'few'), 'i')],
  ['scene flag', new RegExp(w('scene', '[ -]?flag'), 'i')],
  ['the old status text', new RegExp(w('Master', '\\s•\\s', 'Anchored'))],
  ['study (the feature)', new RegExp(w('(?<![a-z])stu', 'dy(?![a-z])'), 'i')],
  ['house_channels', new RegExp(w('house', '_channels'), 'i')],
  ['discord.house', new RegExp(w('discord\\.', 'house'), 'i')],
  ['HOUSE_CONFIG', new RegExp(w('HOUSE', '_CONFIG'))],
];

/** Whole files that may hold earlier names: the alias modules, which exist to read them. */
const ALIAS_MODULES = [/^engine\/src\/config\/legacy-names\.ts$/, /^dashboard\/lib\/legacy-names\.js$/];
/** Lines that may name the publisher: copyright and notice lines, credit, licence and donation lines. Short and explicit. */
const ALLOWED_LINES: Array<{ file: RegExp; line: RegExp }> = [
  { file: /.*/, line: /Copyright \(c\)|Required Notice/ },
  { file: /^README\.md$/, line: /^Made by House of Solance · free for noncommercial use · credit required$/ },
  { file: /^README\.md$/, line: /^Discord is made by House of Solance\. You're welcome to use it/ },
  { file: /^README\.md$/, line: /^\*Built by \[House of Solance\]\(https:\/\/github\.com\/SolanceLab\)/ },
  { file: /^engine\/README\.md$/, line: /^\*\*Originally built by:\*\* / },
  { file: /^engine\/docs\/QUICK-START-GUIDE\.md$/, line: /^\*Created by / },
  { file: /^mcp\/worker\/README\.md$/, line: /^Built by \[/ },
  { file: /^mcp\/worker\/AUTHORS$/, line: /.*/ },
  { file: /^(plugin\/\.(claude|codex)-plugin\/plugin|\.claude-plugin\/marketplace)\.json$/, line: /"(name|author|owner)":|"name": "/ },
];

/** The violations in one file's text: [line number, word, line]. */
export function scanForForbiddenWords(file: string, text: string): Array<[number, string, string]> {
  if (ALIAS_MODULES.some((r) => r.test(file))) return [];
  const out: Array<[number, string, string]> = [];
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of FORBIDDEN) {
      if (!re.test(line)) continue;
      if (ALLOWED_LINES.some((a) => a.file.test(file) && a.line.test(line))) continue;
      out.push([i + 1, name, line.trim().slice(0, 100)]);
    }
  });
  return out;
}

const SCAN_FILES = ['README.md', 'engine/README.md'];
const SCAN_ROOTS = ['engine/src', 'engine/scripts', 'engine/docs', 'mcp', 'dashboard', 'agent', 'plugin'];
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|py|yml|yaml|sh|css|html|txt|example)$|(^|\/)(Dockerfile|AUTHORS)$/;
const TEST_FILE = /\.test\.[a-z]+$|(^|\/)(tests?|test-fixtures|fixtures|node_modules|dist)\//;

function trackedFiles(repo: string): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z', ...SCAN_ROOTS, ...SCAN_FILES], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    const walk = (dir: string): string[] => readdirSync(join(repo, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = `${dir}/${e.name}`;
      return e.isDirectory() ? (e.name === 'node_modules' || e.name === 'dist' ? [] : walk(rel)) : [rel];
    });
    return [...SCAN_ROOTS.flatMap((d) => (existsSync(join(repo, d)) ? walk(d) : [])), ...SCAN_FILES];
  }
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, '..', '..');
  const files = trackedFiles(repo).filter((f) => TEXT_EXT.test(f) && !TEST_FILE.test(f) && existsSync(join(repo, f)));
  ok('the scan reads the public code and docs', files.length > 100 && files.includes('engine/src/cloud-server.ts') && files.includes('README.md'), `${files.length} files`);
  const hits = files.flatMap((f) => scanForForbiddenWords(f, readFileSync(join(repo, f), 'utf8')).map(([n, word, line]) => `${f}:${n} [${word}] ${line}`));
  ok('no earlier, deployment-specific word is left outside the alias modules and the credit lines', hits.length === 0, `${hits.length} hits:\n    ${hits.slice(0, 80).join('\n    ')}`);

  // The scan itself: it fails on a new use, and lets the allowed lines through.
  const probe = (file: string, text: string) => scanForForbiddenWords(file, text).length;
  ok('scan: a new "House of Solance" sentence fails', probe('engine/src/x.ts', 'You are deciding whether to speak in a House of Solance channel') === 1);
  ok('scan: the copyright line passes', probe('engine/src/x.ts', '// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance') === 0);
  ok('scan: a credit line in the README passes', probe('README.md', 'Made by House of Solance · free for noncommercial use · credit required') === 0);
  ok('scan: the same credit words in code fail', probe('engine/src/x.ts', 'Made by House of Solance · free for noncommercial use · credit required') === 1);
  ok('scan: each earlier word fails', ['sanctumUrl', 'solance-api', 'HOS_SERVER_ID', 'curfew', 'a scene flag', 'study_command', 'house_channels', 'discord.house.json', 'HOUSE_CONFIG_PATH']
    .every((t) => probe('engine/src/x.ts', `const x = '${t}';`) >= 1));
  ok('scan: the alias module is exempt', probe('engine/src/config/legacy-names.ts', "curfew: 'quiet_hours', sanctum: 'custom'") === 0);
  ok('scan: ordinary words are left alone', probe('engine/src/x.ts', 'a hosted home server, hostname, whose, ghost') === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
