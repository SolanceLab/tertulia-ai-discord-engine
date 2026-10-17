// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * study-summons.ts — the owner's secret slash command (Owner, 2 Oct 2026;
 * specs/2026-10-01-discord-study-summons-and-guild-recall.md §B).
 *
 * `/study [minutes]` is a USER-INSTALLED command: it exists only in the owner's own slash menu, never
 * on a server's. Running it opens a window in that channel: the Mac picks the summons up, a Study
 * (Claude Code) session answers her there as normal the bot, and Sanctum steps aside in that
 * channel until the window closes. Every reply to the command is ephemeral, so nobody sees it.
 */
import { identity } from './config/identity.js';
import { parseStudy, type StudyWindow } from './presence-config.js';

export const STUDY_MAX_MINUTES = 240;
export const STUDY_MIN_MINUTES = 5;
export const STUDY_COMMAND_NAME = 'wake';
export const STUDY_DEFAULT_MINUTES = 30;

/** Discord application-command body. integration_types [1] = user install; contexts 0,1,2 = guild, bot DM, private channel. */
export const STUDY_COMMAND = {
  name: STUDY_COMMAND_NAME,
  type: 1,
  description: 'Open a window',
  integration_types: [1],
  contexts: [0, 1, 2],
  options: [
    { type: 4, name: 'minutes', description: 'How long the window stays open', required: false, min_value: STUDY_MIN_MINUTES, max_value: STUDY_MAX_MINUTES },
  ],
};

export function studyCommand(name: string = STUDY_COMMAND_NAME) {
  return { ...STUDY_COMMAND, name };
}

export interface StudyInteractionLike {
  commandName: string;
  user: { id: string };
  channelId: string | null;
  guildId: string | null;
  options: { getInteger(name: string): number | null };
  reply(opts: { content: string; flags: number }): Promise<unknown>;
  deferReply(opts: { flags: number }): Promise<unknown>;
  editReply(opts: { content: string }): Promise<unknown>;
}

export interface StudyDeps {
  /** The command's registered name; default `wake`. */
  commandName?: string;
  ownerUserId: string | null;
  /** The owner's agent switch; absent = on. When false, the command says the agent is off. */
  agentEnabled?: () => boolean | Promise<boolean>;
  /** PUT /routine/discord {study:{...}} → the stored window, or null on failure. */
  openStudy(channelId: string, guildId: string | null, minutes: number): Promise<StudyWindow | null>;
  noteStudy(study: StudyWindow): void;
  /** After a successful open: re-read the config often until the Study reports ready. */
  watchUntilReady?(study: StudyWindow): void;
  log(message: string, data?: Record<string, unknown>): void;
}

const EPHEMERAL = 1 << 6;

export function clampMinutes(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return STUDY_DEFAULT_MINUTES;
  return Math.min(STUDY_MAX_MINUTES, Math.max(STUDY_MIN_MINUTES, Math.round(raw)));
}

/** Returns true when the interaction was the study command (handled), false otherwise. */
export async function handleStudyInteraction(interaction: StudyInteractionLike, deps: StudyDeps): Promise<boolean> {
  if (interaction.commandName !== (deps.commandName ?? STUDY_COMMAND_NAME)) return false;
  if (!deps.ownerUserId || interaction.user.id !== deps.ownerUserId) {
    deps.log(`study command refused — not ${identity.owner_name}`, { userId: interaction.user.id });
    await interaction.reply({ content: 'Not available.', flags: EPHEMERAL });
    return true;
  }
  if (!interaction.channelId) {
    await interaction.reply({ content: 'No channel here to open a window in.', flags: EPHEMERAL });
    return true;
  }
  const minutes = clampMinutes(interaction.options.getInteger('minutes'));
  // Acknowledge first (ephemeral): Discord allows 3s, and the write below may take most of that.
  await interaction.deferReply({ flags: EPHEMERAL });
  if (deps.agentEnabled && !(await deps.agentEnabled())) {
    await interaction.editReply({ content: 'Your agent is off. Turn it on in the settings page.' });
    return true;
  }
  const stored = await deps.openStudy(interaction.channelId, interaction.guildId ?? null, minutes);
  const study = stored ? parseStudy(stored) : null;
  if (!study || !study.active) {
    deps.log('study window failed to open', { channelId: interaction.channelId });
    await interaction.editReply({ content: "Couldn't open the window. The House config didn't take the write. Nothing changed here." });
    return true;
  }
  deps.noteStudy(study);
  deps.watchUntilReady?.(study);
  deps.log('study window opened', { channelId: study.channel_id, guildId: study.guild_id, minutes, nonce: study.nonce });
  await interaction.editReply({ content: `I'm coming. ${minutes} min, and each message from you resets the clock.` });
  return true;
}
