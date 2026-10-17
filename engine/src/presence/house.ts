// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Thin re-export over the House config (src/config/house-config.ts). The values live in
// modules/discord/house/discord.house.json; this file keeps the old export names so importers compile.
import type { Step } from './steps.js';
import { houseConfig } from '../config/house-config.js';

export const HOS_SERVER_ID: string = houseConfig.hosServerId;

export const CHANNEL_POSTURE: Record<string, Step> = houseConfig.channelPosture;

// The owner-only register — same law as INTIMATE_TELLS. These are the two curfew
// stickers ("BED. NOW." / "Sleep, brat.") — they carry her reserved register
// and must never land in a room where she is not the active speaker/addressee.
export const INTIMATE_STICKER_IDS = new Set<string>(houseConfig.intimateStickerIds);
