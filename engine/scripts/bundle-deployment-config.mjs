#!/usr/bin/env node
// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Copies the deployment layer's discord.config.json into dist/ after tsc. A container image is built
// from this folder alone (see Dockerfile: it copies the prebuilt dist/), so ../deployment is not in the image;
// src/config/deployment-config.ts finds this copy at dist/discord.config.json. No config file = no copy
// (the bot then runs on the generic defaults). Earlier file locations are still found; legacy-names.ts lists them.
import { writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const bot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { bundleSources, isLegacyLayerPath, warnLegacy } = await import('../dist/config/legacy-names.js');
const sources = bundleSources(bot, join);

const src = sources.config.find((p) => existsSync(p));
if (src) {
  if (isLegacyLayerPath(src)) warnLegacy('the earlier config file location', 'deployment/discord.config.json');
  copyFileSync(src, join(bot, 'dist', 'discord.config.json'));
  console.log('bundle-deployment-config: copied discord.config.json into dist/');
} else {
  console.log('bundle-deployment-config: no config file; dist runs on generic defaults');
}

// The optional hooks module (src/hooks.ts loads dist/hooks.js). Transpiled, not type-checked
// (the deployment layer's own tests check it); its config is read from the discord.config.json copied above.
const hooksSrc = sources.hooks.find((p) => existsSync(p));
if (hooksSrc) {
  if (isLegacyLayerPath(hooksSrc)) warnLegacy('the earlier hooks location', 'deployment/hooks.ts');
  const { default: ts } = await import('typescript');
  const out = ts.transpileModule(readFileSync(hooksSrc, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: false,
  });
  writeFileSync(join(bot, 'dist', 'hooks.js'), out.outputText);
  console.log('bundle-deployment-config: wrote dist/hooks.js');
} else {
  console.log('bundle-deployment-config: no hooks module; the bot runs on no-op hooks');
}
