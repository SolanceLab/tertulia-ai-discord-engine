// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Thin re-export over the deployment config (src/config/deployment-config.ts). The values live in
// the deployment's discord.config.json; this file keeps the old export names so importers compile.
import type { Step } from './steps.js';
import { deployConfig } from '../config/deployment-config.js';

export const HOME_SERVER_ID: string = deployConfig.homeServerId;

export const CHANNEL_POSTURE: Record<string, Step> = deployConfig.channelPosture;

// The owner-only register — same law as PRIVATE_TELLS. These are the two quiet hours
// stickers ("BED. NOW." / "Sleep, brat.") — they carry her reserved register
// and must never land in a room where she is not the active speaker/addressee.
export const OWNER_ONLY_STICKER_IDS = new Set<string>(deployConfig.ownerOnlyStickerIds);
