// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Discord API client — thin wrapper around Fly.io HTTP API
 *
 * Forwards to the bot's HTTP endpoints.
 * The bot handles Discord.js, rate limiting, and error handling.
 */

import type { Env } from "./types";

export class DiscordClient {
  private baseUrl: string;
  private secret: string;

  constructor(env: Env) {
    this.baseUrl = env.BOT_API_URL.replace(/\/$/, "");
    this.secret = env.BOT_API_SECRET;
  }

  /**
   * Make an authenticated request to the Fly.io bot API
   */
  async call<T = unknown>(endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.baseUrl}/api/${endpoint}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.secret}`,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  // No per-endpoint convenience methods: they were where the bodies drifted from
  // the bot (send_file, get_user_info, 12 Oct 2026). Tools now post their own
  // arguments, shaped by ../../definitions.ts, through call().
}
