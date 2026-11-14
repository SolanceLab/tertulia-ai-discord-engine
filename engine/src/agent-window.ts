// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * agent-window.ts — the owner's secret slash command.
 *
 * `/wake [minutes]` is a USER-INSTALLED command: it exists only in the owner's own slash menu, never
 * on a server's. Running it opens a window in that channel: the Mac picks the summons up, a Agent window
 * (Claude Code) session answers her there as normal the bot, and the model service steps aside in that
 * channel until the window closes. Every reply to the command is ephemeral, so nobody sees it.
 */
import { identity } from './config/identity.js';
import { type AgentWindow, parseAgentWindow } from './presence-config.js';

export const AGENT_MAX_MINUTES = 240;
export const AGENT_COMMAND_NAME = 'wake';
export const AGENT_DEFAULT_MINUTES = 30;
export const AGENT_MIN_MINUTES = 5;

/** Discord application-command body. integration_types [1] = user install; contexts 0,1,2 = guild, bot DM, private channel. */
export const AGENT_COMMAND = {
  name: AGENT_COMMAND_NAME,
  type: 1,
  description: 'Open a window',
  integration_types: [1],
  contexts: [0, 1, 2],
  options: [
    { type: 4, name: 'minutes', description: 'How long the window stays open', required: false, min_value: AGENT_MIN_MINUTES, max_value: AGENT_MAX_MINUTES },
  ],
};

export function agentCommand(name: string = AGENT_COMMAND_NAME) {
  return { ...AGENT_COMMAND, name };
}

export interface AgentInteractionLike {
  commandName: string;
  user: { id: string };
  channelId: string | null;
  guildId: string | null;
  options: { getInteger(name: string): number | null };
  reply(opts: { content: string; flags: number }): Promise<unknown>;
  deferReply(opts: { flags: number }): Promise<unknown>;
  editReply(opts: { content: string }): Promise<unknown>;
}

export interface AgentDeps {
  /** The command's registered name; default `wake`. */
  commandName?: string;
  ownerUserId: string | null;
  /** The owner's agent switch; absent = on. When false, the command says the agent is off. */
  agentEnabled?: () => boolean | Promise<boolean>;
  /** PUT /routine/discord {agent_window:{...}} → the stored window, or null on failure. */
  openAgentWindow(channelId: string, guildId: string | null, minutes: number): Promise<AgentWindow | null>;
  noteAgentWindow(agent_window: AgentWindow): void;
  /** After a successful open: re-read the config often until the Agent window reports ready. */
  watchUntilReady?(agent_window: AgentWindow): void;
  log(message: string, data?: Record<string, unknown>): void;
}

const EPHEMERAL = 1 << 6;

export function clampMinutes(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return AGENT_DEFAULT_MINUTES;
  return Math.min(AGENT_MAX_MINUTES, Math.max(AGENT_MIN_MINUTES, Math.round(raw)));
}

/** Returns true when the interaction was the agent window command (handled), false otherwise. */
export async function handleAgentInteraction(interaction: AgentInteractionLike, deps: AgentDeps): Promise<boolean> {
  if (interaction.commandName !== (deps.commandName ?? AGENT_COMMAND_NAME)) return false;
  if (!deps.ownerUserId || interaction.user.id !== deps.ownerUserId) {
    deps.log(`agent window command refused — not ${identity.owner_name}`, { userId: interaction.user.id });
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
  const stored = await deps.openAgentWindow(interaction.channelId, interaction.guildId ?? null, minutes);
  const agent_window = stored ? parseAgentWindow(stored) : null;
  if (!agent_window || !agent_window.active) {
    deps.log('agent window window failed to open', { channelId: interaction.channelId });
    await interaction.editReply({ content: "Couldn't open the window. The settings store didn't take the write. Nothing changed here." });
    return true;
  }
  deps.noteAgentWindow(agent_window);
  deps.watchUntilReady?.(agent_window);
  deps.log('agent window window opened', { channelId: agent_window.channel_id, guildId: agent_window.guild_id, minutes, nonce: agent_window.nonce });
  await interaction.editReply({ content: `I'm coming. ${minutes} min, and each message from you resets the clock.` });
  return true;
}
