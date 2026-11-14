// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/profile-files.test.ts — local image paths for the profile tools: off by default, confined to PROFILE_FILES_DIR. */
import './test-env.js';
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfinedFile, withLocalImages, IMAGE_MAX_BYTES } from './profile-edit.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } }
const refuses = async (p: () => Promise<unknown>) => { try { await p(); return false; } catch (e: any) { return e?.name === 'Error' || true; } };

(async () => {
  const base = mkdtempSync(join(tmpdir(), 'profile-files-'));
  const dir = join(base, 'images');
  const outside = join(base, 'outside');
  mkdirSync(dir); mkdirSync(outside); mkdirSync(join(dir, 'sub'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  writeFileSync(join(dir, 'a.png'), png);
  writeFileSync(join(dir, 'sub', 'b.png'), png);
  writeFileSync(join(outside, 'secret.png'), png);
  symlinkSync(join(outside, 'secret.png'), join(dir, 'link.png'));
  symlinkSync(outside, join(dir, 'linkdir'));
  symlinkSync(join(dir, 'a.png'), join(dir, 'inside-link.png'));
  const big = join(dir, 'big.png'); writeFileSync(big, ''); truncateSync(big, IMAGE_MAX_BYTES + 1);
  const exact = join(dir, 'exact.png'); writeFileSync(exact, ''); truncateSync(exact, IMAGE_MAX_BYTES);

  ok('unset: local paths are off', await refuses(() => readConfinedFile(join(dir, 'a.png'), undefined)));
  ok('empty setting counts as unset', await refuses(() => readConfinedFile(join(dir, 'a.png'), '  ')));
  ok('inside the folder: absolute path reads', (await readConfinedFile(join(dir, 'a.png'), dir)).equals(png));
  ok('inside the folder: relative path reads', (await readConfinedFile('sub/b.png', dir)).equals(png));
  ok('a symlink that stays inside the folder reads', (await readConfinedFile('inside-link.png', dir)).equals(png));
  ok('outside the folder is refused', await refuses(() => readConfinedFile(join(outside, 'secret.png'), dir)));
  ok('.. out of the folder is refused', await refuses(() => readConfinedFile('../outside/secret.png', dir)));
  ok('a sibling folder sharing the name prefix is refused', await refuses(async () => { mkdirSync(join(base, 'images-evil')); writeFileSync(join(base, 'images-evil', 'x.png'), png); return readConfinedFile(join(base, 'images-evil', 'x.png'), dir); }));
  ok('a symlink escaping the folder is refused', await refuses(() => readConfinedFile('link.png', dir)));
  ok('a symlinked folder escaping is refused', await refuses(() => readConfinedFile('linkdir/secret.png', dir)));
  ok('a directory is not a regular file', await refuses(() => readConfinedFile('sub', dir)));
  ok('the folder itself is not a regular file', await refuses(() => readConfinedFile('.', dir)));
  ok('a missing file is refused', await refuses(() => readConfinedFile('nope.png', dir)));
  ok('over the cap is refused before reading', await refuses(() => readConfinedFile('big.png', dir)));
  ok('exactly the cap is read', (await readConfinedFile('exact.png', dir)).length === IMAGE_MAX_BYTES);

  // through withLocalImages: the caller sees the plain reason
  let r: any = await withLocalImages({ avatar_path: '../outside/secret.png' }, (p) => readConfinedFile(p, dir));
  ok('withLocalImages shows the outside-folder reason', /outside the profile images folder|not found/.test(r.refusal));
  r = await withLocalImages({ avatar_path: 'a.png' }, (p) => readConfinedFile(p, undefined));
  ok('withLocalImages shows the off reason', /PROFILE_FILES_DIR/.test(r.refusal));
  r = await withLocalImages({ avatar_path: 'a.png' }, (p) => readConfinedFile(p, dir));
  ok('withLocalImages encodes an allowed file', r.args?.avatar_base64 === png.toString('base64'));

  // the environment setting is what the real reader uses
  const prev = process.env.PROFILE_FILES_DIR;
  delete process.env.PROFILE_FILES_DIR;
  ok('env unset: the default reader refuses', await refuses(() => readConfinedFile(join(dir, 'a.png'))));
  process.env.PROFILE_FILES_DIR = dir;
  ok('env set: the default reader reads', (await readConfinedFile('a.png')).equals(png));
  if (prev === undefined) delete process.env.PROFILE_FILES_DIR; else process.env.PROFILE_FILES_DIR = prev;

  rmSync(base, { recursive: true, force: true });
})().then(() => { console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, (e) => { console.error(e); process.exit(1); });
