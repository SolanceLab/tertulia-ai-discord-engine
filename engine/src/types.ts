// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
export interface BotConfig {
  discordToken: string;
  channelId: string;
  anthropicApiKey: string;
  presenceSyncEnabled: boolean;
  ownerUserId: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  author?: string;
  userId?: string;
}

export interface MemoryEntry {
  channelId: string;
  messages: ConversationMessage[];
  lastUpdated: string;
}

export interface MemoryLedger {
  [channelId: string]: MemoryEntry;
}
