#!/usr/bin/env node
// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Copies the shared tool definitions (modules/discord/mcp/definitions.ts) into
// bot/src/mcp/shared/, because the bot cannot import outside bot/src (tsc rootDir,
// and the Fly image is built from bot/ alone). The copy is tracked: commit it.
// Runs in prebuild and at the start of npm test. --check exits 1 if the copy is stale.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEADER = '// GENERATED — edit modules/discord/mcp/definitions.ts, then run: node bot/scripts/sync-shared.mjs\n';
const bot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(bot, '..', 'mcp', 'definitions.ts');
const dest = join(bot, 'src', 'mcp', 'shared', 'definitions.ts');

if (!existsSync(src)) {
  // Building from bot/ alone (no module checkout around it): keep the tracked copy.
  console.log(`sync-shared: ${src} not found; keeping the tracked copy`);
  process.exit(0);
}
const want = HEADER + readFileSync(src, 'utf8');
const have = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
if (have === want) {
  console.log('sync-shared: bot/src/mcp/shared/definitions.ts is current');
} else if (process.argv.includes('--check')) {
  console.error('sync-shared: bot/src/mcp/shared/definitions.ts is stale; run node bot/scripts/sync-shared.mjs');
  process.exit(1);
} else {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, want);
  console.log('sync-shared: copied mcp/definitions.ts -> bot/src/mcp/shared/definitions.ts');
}
