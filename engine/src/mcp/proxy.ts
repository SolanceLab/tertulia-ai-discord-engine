// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import path from 'path';
import fs from 'fs';
import { DEFINITIONS } from './tool-definitions.js';
import { bodyFor } from './shared/definitions.js';

/** Values the proxy handlers read from the server's module scope. */
export interface ProxyConfig {
  botApiUrl: string;
  botApiSecret: string;
  /** Used when DISCORD_ATTACHMENTS_DIR is not set. */
  defaultAttachmentsDir: string;
}

/**
 * Make an authenticated HTTP request to the cloud bot.
 * Used in proxy mode to forward MCP tool calls.
 */
export async function proxyRequest(cfg: ProxyConfig, endpoint: string, body: Record<string, unknown>): Promise<any> {
  const url = `${cfg.botApiUrl}${endpoint}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.botApiSecret}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Proxy request to ${endpoint} failed: ${msg}`);
  }
}

// --- Proxy Mode Tool Handler ---
// Maps MCP tool names to HTTP API endpoints, straight from the shared definitions
// (modules/discord/mcp/definitions.ts) so the Mac and the cloud connector post the same bodies.
const DEFINITION_BY_NAME = new Map(DEFINITIONS.map((d) => [d.name, d]));
export const TOOL_TO_ENDPOINT: Record<string, string> = Object.fromEntries(
  DEFINITIONS.filter((d) => d.endpoint).map((d) => [d.name, d.endpoint as string]),
);

export async function handleProxyToolCall(cfg: ProxyConfig, name: string, args: Record<string, unknown> | undefined) {
  // Check mentions / DMs don't exist in proxy mode — the cloud handles them
  if (name === 'discord_check_mentions' || name === 'discord_check_dms') {
    return {
      content: [{ type: 'text', text: 'Not available in cloud proxy mode. The cloud bot handles mentions and DMs automatically (auto-responds to the owner, DMs notifications for others).' }],
    };
  }

  // Special case: fetch_attachment downloads locally instead of forwarding
  // Cloud returns fresh CDN URLs, we download to DISCORD_ATTACHMENTS_DIR on this machine
  if (name === 'discord_fetch_attachment') {
    return handleProxyFetchAttachment(cfg, args);
  }

  // Special case: send_file with file_path — read locally, convert to base64, forward
  // The base64 stays inside this process; Claude's context only sees the file_path string
  if (name === 'discord_send_file' && args?.file_path && !args?.file_data) {
    return handleProxySendFile(cfg, args);
  }

  const def = DEFINITION_BY_NAME.get(name);
  const endpoint = TOOL_TO_ENDPOINT[name];
  if (!def || !endpoint) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  const refusal = def.check?.(args ?? {});
  if (refusal) {
    return { content: [{ type: 'text', text: refusal }], isError: true };
  }

  try {
    const result = await proxyRequest(cfg, endpoint, bodyFor(def, args));
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Proxy error: ${msg}` }],
      isError: true,
    };
  }
}

/**
 * Proxy fetch_attachment: get fresh URLs from cloud, download locally.
 * No base64 — files go straight to DISCORD_ATTACHMENTS_DIR on the owner's machine.
 */
async function handleProxyFetchAttachment(cfg: ProxyConfig, args: Record<string, unknown> | undefined) {
  const channelId = args?.channel_id as string;
  const messageId = args?.message_id as string;
  const filename = args?.filename as string | undefined;

  if (!channelId || !messageId) {
    return {
      content: [{ type: 'text', text: 'channel_id and message_id are required.' }],
      isError: true,
    };
  }

  try {
    // 1. Get fresh attachment URLs from cloud
    const result = await proxyRequest(cfg, '/api/get-attachment-urls', {
      channel_id: channelId,
      message_id: messageId,
      filename,
    });

    if (!result.attachments || result.attachments.length === 0) {
      return {
        content: [{ type: 'text', text: 'No attachments found on this message.' }],
      };
    }

    // 2. Download each to local DISCORD_ATTACHMENTS_DIR
    const cacheDir = process.env.DISCORD_ATTACHMENTS_DIR || cfg.defaultAttachmentsDir;
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const downloaded: string[] = [];
    const errors: string[] = [];

    for (const att of result.attachments) {
      const safeName = att.name?.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
      const localPath = path.join(cacheDir, `${messageId}_${safeName}`);

      try {
        const response = await fetch(att.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(localPath, buffer);
        downloaded.push(localPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to download ${att.name}: ${msg}`);
      }
    }

    const parts: string[] = [];
    if (downloaded.length > 0) {
      parts.push(`Downloaded ${downloaded.length} attachment(s):`);
      downloaded.forEach(p => parts.push(`  ${p}`));
    }
    if (errors.length > 0) {
      parts.push(`Errors:`);
      errors.forEach(e => parts.push(`  ${e}`));
    }

    return {
      content: [{ type: 'text', text: parts.join('\n') }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Proxy fetch attachment error: ${msg}` }],
      isError: true,
    };
  }
}

/**
 * Proxy send_file with file_path: read file locally, convert to base64,
 * forward as file_data to the Fly.io bot.
 * The base64 stays in this process — Claude's context never sees it.
 */
async function handleProxySendFile(cfg: ProxyConfig, args: Record<string, unknown>) {
  const channelId = args.channel_id as string;
  const filePath = args.file_path as string;
  const fileName = args.file_name as string;
  const content = args.content as string | undefined;

  if (!channelId || !fileName) {
    return {
      content: [{ type: 'text', text: 'channel_id and file_name are required.' }],
      isError: true,
    };
  }

  try {
    // Read the file from local disk
    const fsPromises = await import('fs/promises');
    const fileBuffer = await fsPromises.readFile(filePath);
    const fileData = fileBuffer.toString('base64');

    // Forward to Fly.io with base64 data
    const result = await proxyRequest(cfg, '/api/send-file', {
      channel_id: channelId,
      file_data: fileData,
      file_name: fileName,
      content,
    });

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Proxy send file error: ${msg}` }],
      isError: true,
    };
  }
}
