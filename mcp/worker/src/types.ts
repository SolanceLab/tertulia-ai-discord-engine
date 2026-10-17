// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Cloudflare Worker environment bindings
 */
export interface Env {
  /** API key for authenticating requests */
  API_KEY: string;
  /** Fly.io bot HTTP API URL */
  BOT_API_URL: string;
  /** Fly.io bot HTTP API secret */
  BOT_API_SECRET: string;
}
