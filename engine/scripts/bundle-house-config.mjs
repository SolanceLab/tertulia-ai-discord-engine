#!/usr/bin/env node
// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Copies modules/discord/house/discord.house.json into dist/ after tsc. The Fly image is built
// from bot/ alone (see Dockerfile: it copies the prebuilt dist/), so ../house is not in the image;
// src/config/house-config.ts finds this copy at dist/discord.house.json. No house file = no copy
// (the bot then runs on the generic defaults).
import { copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const bot = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(bot, '..', 'house', 'discord.house.json');
if (!existsSync(src)) { console.log('bundle-house-config: no house file; dist runs on generic defaults'); process.exit(0); }
copyFileSync(src, join(bot, 'dist', 'discord.house.json'));
console.log('bundle-house-config: copied discord.house.json into dist/');
