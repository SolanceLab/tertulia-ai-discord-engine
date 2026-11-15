// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Run: npx tsx src/text-keys.test.ts
 * The wording keys for the phrases inside the presence prompts. Run twice over (the default run starts the override run): with no config (the neutral
 * defaults show in the built prompts) and with a config that overrides each key (the override replaces the
 * default in its own prompt only). The mode comes from the first argument: "default" or "override".
 */
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] === 'override' ? 'override' : 'default';
const dir = mkdtempSync(join(tmpdir(), 'text-keys-'));
const OVERRIDES: Record<string, string> = {
  'presence.balanced_label': '(the usual)',
  'presence.friend_phrase': 'an old regular',
  'respond.host_phrase': 'a courteous greeter',
  'respond.narration_walls': 'stage-direction paragraphs',
  'draft.private_register': 'whispering voice',
};
writeFileSync(join(dir, 'config.json'), JSON.stringify(mode === 'override' ? { identity: { text: OVERRIDES } } : {}));
process.env.CONFIG_PATH = join(dir, 'config.json');

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); }
}

const { PresenceEngine } = await import('./presence-engine.js');
const { DEFAULTS } = await import('./presence-config.js');
const { DEFAULT_TEXT } = await import('./config/identity-defaults.js');

const captured: string[] = [];
const engine = new PresenceEngine('', '', 'PERSONA', () => 1_760_000_100_000, undefined, undefined, undefined, { get: async () => ({ ...DEFAULTS }) } as any);
engine.setModelProvider({
  singleModel: true, identity: { engine: 't', model: 't' },
  async complete(_t: any, system: string) { captured.push(system); return { ok: true, text: 'NOTE:\nn\nPROPOSED:\np', engine: 't', model: 't' }; },
  async prepare() { return null; }, async postComplete() { throw new Error('unused'); },
} as any);
const win = [{ id: '1', authorId: '700000000000000001', authorName: 'Mara', content: 'hi', isFromOwner: false, isFromMe: false, timestampMs: 1_760_000_000_000 }];
const run = async (f: () => Promise<unknown>) => { captured.length = 0; await f(); return [...captured]; };

const judge = (await run(() => engine.judge('700000000000000103', 'room', win, undefined, [], 'balanced')))[0] ?? '';
const respond = (await run(() => engine.respond('room', win, undefined, false, [], undefined, 'hi')))[0] ?? '';
const aside = await run(() => engine.privateAside('room', win, 'what do you think?'));
const reply = (await run(() => engine.replyToMessage('Mara', 'hello there')))[0] ?? '';

const D = DEFAULT_TEXT;
const V = (key: string) => (mode === 'override' ? OVERRIDES[key] : D[key]);
const other = (key: string) => (mode === 'override' ? D[key] : OVERRIDES[key]); // the text that must NOT be in the prompt

ok('the defaults are neutral', D['presence.friend_phrase'] === 'a friend of the server' && D['presence.balanced_label'] === '(the default)' && D['respond.host_phrase'] === 'a warm, neutral host' && D['draft.private_register'] === 'private register');
ok(`presence.balanced_label (${mode}) in the balanced judge prompt only`, judge.includes(`BALANCED ${V('presence.balanced_label')} —`) && !judge.includes(other('presence.balanced_label')) && !respond.includes('BALANCED'));
ok(`presence.friend_phrase (${mode}) in the balanced judge prompt only`, judge.includes(`for ${V('presence.friend_phrase')}. Presence`) && !judge.includes(other('presence.friend_phrase')) && !respond.includes(V('presence.friend_phrase')));
ok(`respond.host_phrase (${mode}) in the direct reply prompt only`, respond.includes(`be ${V('respond.host_phrase')}.`) && !respond.includes(other('respond.host_phrase')) && !judge.includes(V('respond.host_phrase')));
ok(`respond.narration_walls (${mode}) in the direct reply prompt only`, respond.includes(`or ${V('respond.narration_walls')}.`) && !respond.includes(other('respond.narration_walls')) && !judge.includes(V('respond.narration_walls')));
const pr = V('draft.private_register');
ok(`draft.private_register (${mode}) in the aside prompt (proposed line)`, aside.length === 2 && aside[0].includes(`no ${pr}, no mention of this private aside`));
ok(`draft.private_register (${mode}) in the aside drafting prompt`, aside.length === 2 && aside[1].includes(`no ${pr}, no mention of any private aside`));
ok(`draft.private_register (${mode}) in the reply-as-bot prompt`, reply.includes(`no ${pr}, no mention of this private draft`));
ok(`draft.private_register (${mode}) leaves the other prompts alone`, !judge.includes(pr) && !respond.includes(pr));
ok('the old placeholder is never left unfilled', ![judge, respond, reply, ...aside].some((s) => s.includes('${private_register}')));

// ── the build keeps the engine's own hooks loader when a deployment has a hooks file ──
if (mode === 'default') {
  // The same checks again with a config that overrides every key.
  const r = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), 'override'], { encoding: 'utf8' });
  ok('the override run passes', r.status === 0);
  if (r.status !== 0) console.log((r.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).join('\n') + (r.stderr || '').slice(0, 400));
  const here = dirname(fileURLToPath(import.meta.url));
  const engineDir = join(here, '..');
  const layer = join(dir, 'layer');
  mkdirSync(join(layer, 'engine', 'scripts'), { recursive: true });
  mkdirSync(join(layer, 'engine', 'dist', 'config'), { recursive: true });
  mkdirSync(join(layer, 'deployment'), { recursive: true });
  copyFileSync(join(engineDir, 'scripts', 'bundle-deployment-config.mjs'), join(layer, 'engine', 'scripts', 'bundle-deployment-config.mjs'));
  writeFileSync(join(layer, 'engine', 'dist', 'hooks.js'), '// ENGINE LOADER\n');
  writeFileSync(join(layer, 'deployment', 'hooks.ts'), 'export const hooks: { hideAuthor: (id: string) => boolean } = { hideAuthor: (id) => id === "x" };\n');
  // Run the real script against the layer: it needs ../dist/config/legacy-names.js, so write a one-line re-export.
  writeFileSync(join(layer, 'engine', 'dist', 'config', 'legacy-names.js'), `export const bundleSources = (b, j) => ({ config: [], hooks: [j(b, '..', 'deployment', 'hooks.ts')] }); export const isLegacyLayerPath = () => false; export const warnLegacy = () => {};\n`);
  execFileSync('ln', ['-s', join(engineDir, 'node_modules'), join(layer, 'engine', 'node_modules')]); // the script imports typescript
  execFileSync(process.execPath, [join(layer, 'engine', 'scripts', 'bundle-deployment-config.mjs')], { cwd: layer, encoding: 'utf8' });
  ok('build with a deployment hooks file: dist/hooks.js is still the engine loader', readFileSync(join(layer, 'engine', 'dist', 'hooks.js'), 'utf8') === '// ENGINE LOADER\n');
  ok('build with a deployment hooks file: the module lands in dist/deployment-hooks.js', existsSync(join(layer, 'engine', 'dist', 'deployment-hooks.js')));
  const { hooksFileCandidates } = await import('./config/legacy-names.js');
  const { loadHooks, setHooks } = await import('./hooks.js');
  const cands = hooksFileCandidates(join(layer, 'engine', 'dist'), false, join);
  ok('the loader looks at deployment-hooks.js and never at hooks.js', cands[0].endsWith('deployment-hooks.js') && !cands.some((c) => c.endsWith(`${'/'}hooks.js`)));
  const loaded = await loadHooks(cands, undefined, null);
  ok('the deployment module loads from its own path', typeof loaded.hideAuthor === 'function' && loaded.hideAuthor('x') === true);
  setHooks(null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
