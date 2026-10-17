// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import fs from 'fs/promises';
import path from 'path';
// The public build has no memory write path: the journal writer lives in house-journal-writer.ts (House layer only).
import { ConversationMessage, MemoryLedger, MemoryEntry } from './types.js';

import { resolveSolanceApiUrl } from './config/house-config.js';

const SOLANCE_API_URL = resolveSolanceApiUrl();

export interface JournalEntry {
  id: string;
  date: string;
  title?: string;
  narrative?: string;
  carrying_forward?: string;
  emotions?: string[];
  tones?: string[];
  platforms?: string[];
}

export class MemoryManager {
  private ledgerPath: string;
  private ledger: MemoryLedger;
  private solanceToken: string;
  // false when the memory plug is 'off': no journal reads or writes ever leave this process.
  private journalEnabled: boolean;

  // Cached memory context
  private cachedCarryingForward: string = '';
  private cachedRecentJournal: string = '';
  private lastMemoryFetchDate: string = '';
  private firstMentionToday: boolean = true;

  constructor(ledgerPath: string = './memory-ledger.json', solanceToken?: string, journalEnabled: boolean = true) {
    this.journalEnabled = journalEnabled;
    this.ledgerPath = path.resolve(ledgerPath);
    this.ledger = {};
    this.solanceToken = solanceToken || process.env.SOLANCE_TOKEN || '';

    if (this.journalEnabled && !this.solanceToken) {
      console.error('[Memory] Warning: No SOLANCE_TOKEN configured — API sync will fail');
    }
  }

  async initialize(): Promise<void> {
    try {
      const data = await fs.readFile(this.ledgerPath, 'utf-8');
      this.ledger = JSON.parse(data);
      console.error(`[Memory] Ledger loaded: ${Object.keys(this.ledger).length} channels`);
    } catch (error) {
      // File doesn't exist yet, start with empty ledger
      console.error('[Memory] Starting with new ledger');
      this.ledger = {};
      await this.save();
    }

    // Fetch memory context on startup
    await this.refreshMemoryContext(true);
  }

  /**
   * Refresh memory context from Solance API
   * @param isFirstOfDay - If true, fetches fuller context (recent entries)
   */
  async refreshMemoryContext(isFirstOfDay: boolean = false): Promise<void> {
    if (!this.journalEnabled) return;
    const today = new Date().toISOString().split('T')[0];

    // Check if we need a new day's refresh
    if (this.lastMemoryFetchDate !== today) {
      this.firstMentionToday = true;
      this.lastMemoryFetchDate = today;
    }

    try {
      // Always fetch carrying_forward from most recent entry
      const entries = await this.readFromSolance(1);
      if (entries.length > 0 && entries[0].carrying_forward) {
        this.cachedCarryingForward = entries[0].carrying_forward;
        console.error(`[Memory] Loaded carrying_forward (${this.cachedCarryingForward.length} chars)`);
      }

      // On first mention of day, also fetch fuller context
      if (isFirstOfDay || this.firstMentionToday) {
        const recentEntries = await this.readFromSolance(3);
        if (recentEntries.length > 0) {
          // Build a lean summary: date, title, emotions, tones — no narrative bulk
          this.cachedRecentJournal = recentEntries
            .map(e => {
              const parts = [];
              if (e.date) parts.push(`**${e.date}**`);
              if (e.title) parts.push(`*${e.title}*`);
              if (e.emotions && e.emotions.length > 0) {
                parts.push(`Emotions: ${e.emotions.join(', ')}`);
              }
              if (e.tones && e.tones.length > 0) {
                parts.push(`Tones: ${e.tones.join(', ')}`);
              }
              return parts.join('\n');
            })
            .join('\n\n');
          console.error(`[Memory] Loaded recent journal context (${this.cachedRecentJournal.length} chars)`);
        }
      }
    } catch (error) {
      console.error('[Memory] Failed to refresh memory context:', error);
    }
  }

  /**
   * Get memory context for Claude's system prompt
   * @param isFirstMention - If true and it's first mention today, includes fuller context
   */
  async getMemoryContext(isFirstMention: boolean = false): Promise<{ carryingForward?: string; recentJournal?: string }> {
    if (!this.journalEnabled) return {};
    const today = new Date().toISOString().split('T')[0];

    // Check if it's a new day
    if (this.lastMemoryFetchDate !== today) {
      await this.refreshMemoryContext(true);
    }

    const context: { carryingForward?: string; recentJournal?: string } = {};

    // Always include carrying_forward if available
    if (this.cachedCarryingForward) {
      context.carryingForward = this.cachedCarryingForward;
    }

    // Include recent journal on first mention of day
    if (this.firstMentionToday && this.cachedRecentJournal) {
      context.recentJournal = this.cachedRecentJournal;
      // Mark that we've done the first mention
      this.firstMentionToday = false;
    }

    return context;
  }

  async peekMemoryContext(): Promise<{ carryingForward?: string; recentJournal?: string }> {
    if (!this.journalEnabled) return {};
    const today = new Date().toISOString().split('T')[0];

    // Refresh the daily cache when the date changes, but do not consume the
    // once-per-day first mention context.
    if (this.lastMemoryFetchDate !== today) {
      await this.refreshMemoryContext(true);
    }

    const context: { carryingForward?: string; recentJournal?: string } = {};

    if (this.cachedCarryingForward) {
      context.carryingForward = this.cachedCarryingForward;
    }

    if (this.cachedRecentJournal) {
      context.recentJournal = this.cachedRecentJournal;
    }

    return context;
  }

  async addMessage(channelId: string, message: ConversationMessage): Promise<void> {
    if (!this.ledger[channelId]) {
      this.ledger[channelId] = {
        channelId,
        messages: [],
        lastUpdated: new Date().toISOString()
      };
    }

    this.ledger[channelId].messages.push(message);
    this.ledger[channelId].lastUpdated = new Date().toISOString();

    await this.save();
  }

  getRecentMessages(channelId: string, limit: number = 20): ConversationMessage[] {
    const entry = this.ledger[channelId];
    if (!entry) return [];

    return entry.messages.slice(-limit);
  }

  async save(): Promise<void> {
    await fs.writeFile(
      this.ledgerPath,
      JSON.stringify(this.ledger, null, 2),
      'utf-8'
    );
  }

  getConversationContext(channelId: string, maxMessages: number = 20): string {
    const messages = this.getRecentMessages(channelId, maxMessages);

    if (messages.length === 0) {
      return 'No previous conversation history.';
    }

    return messages
      .map(msg => {
        const author = msg.author || msg.role;
        return `${author}: ${msg.content}`;
      })
      .join('\n\n');
  }

  /**
   * Read recent entries from Solance API
   */
  async readFromSolance(limit: number = 5): Promise<JournalEntry[]> {
    if (!this.journalEnabled) return [];
    try {
      const response = await fetch(`${SOLANCE_API_URL}/journal/recent?limit=${limit}`, {
        headers: {
          'Authorization': `Bearer ${this.solanceToken}`
        }
      });
      if (!response.ok) {
        console.error(`[Memory] Solance read failed: ${response.status}`);
        return [];
      }
      const data = await response.json() as { entries?: JournalEntry[] };
      return data.entries || [];
    } catch (error) {
      console.error('[Memory] Solance read error:', error);
      return [];
    }
  }
}
