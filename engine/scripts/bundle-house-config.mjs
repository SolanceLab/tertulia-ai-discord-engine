#!/usr/bin/env node
// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Copies modules/discord/house/discord.house.json into dist/ after tsc. The Fly image is built
// from bot/ alone (see Dockerfile: it copies the prebuilt dist/), so ../house is not in the image;
// src/config/house-config.ts finds this copy at dist/discord.house.json. No house file = no copy
// (the bot then runs on the generic defaults).
import { writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const bot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(bot, '..', 'house', 'discord.house.json');
if (existsSync(src)) {
  copyFileSync(src, join(bot, 'dist', 'discord.house.json'));
  console.log('bundle-house-config: copied discord.house.json into dist/');
} else {
  console.log('bundle-house-config: no house file; dist runs on generic defaults');
}

// The optional House hooks module (src/house-hooks.ts loads dist/house.hooks.js). Transpiled, not type-checked
// (the House test and `tsc -p ../house` check it); its config is read from the discord.house.json copied above.
const hooksSrc = join(bot, '..', 'house', 'hooks.ts');
if (existsSync(hooksSrc)) {
  const { default: ts } = await import('typescript');
  const out = ts.transpileModule(readFileSync(hooksSrc, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: false,
  });
  writeFileSync(join(bot, 'dist', 'house.hooks.js'), out.outputText);
  console.log('bundle-house-config: wrote dist/house.hooks.js');
} else {
  console.log('bundle-house-config: no house hooks; the bot runs on no-op hooks');
}
