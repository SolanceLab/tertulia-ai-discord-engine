#!/usr/bin/env node
// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)

import './load-env.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { DiscordClient, MentionEvent, toReplyReference } from './discord-client.js';
import { MemoryManager } from './memory.js';
import { ClaudeClient } from './claude.js';
import { logger } from './logger.js';
import { createHttpServer } from './http-server.js';
import { VIEW_ATTACHMENT_TOOL, VIEW_ATTACHMENT_DIRECT_ERROR, handleProxyViewAttachment } from './view-attachment.js';
import { composeTools } from './mcp/tool-definitions.js';
import { proxyRequest as proxyRequestWith, type ProxyConfig, handleProxyToolCall } from './mcp/proxy.js';
import { handleDirectToolCall } from './mcp/direct.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { houseConfig } from './config/house-config.js';
import { resolveOwnerUserId, identity, identityVars } from './config/identity.js';
import { LocalSettingsStore } from './seams/local-settings-store.js';
import { personaFromEnv } from './seams/persona-provider.js';

// Lock file mechanism to prevent multiple instances
const PROCESS_PATTERN = 'discord-bot-v2/dist/mcp-server.js';
const LOCK_FILE = identity.runtime.lock_file;

/**
 * Kill ALL orphan processes matching our pattern, not just the one in the lock file.
 * This catches orphans that existed before the lock mechanism or were started differently.
 */
function killOrphanProcesses(): void {
  const myPid = process.pid;

  try {
    // Use pgrep to find all matching processes
    const result = execSync(`pgrep -f "${PROCESS_PATTERN}" 2>/dev/null || true`, { encoding: 'utf-8' });
    const pids = result.trim().split('\n').filter(p => p).map(p => parseInt(p, 10));

    for (const pid of pids) {
      if (isNaN(pid) || pid === myPid) continue;

      try {
        logger.warn('MCP', `Found orphan process (PID: ${pid}) — killing it`);
        process.kill(pid, 'SIGTERM');

        // Wait briefly for graceful shutdown
        const start = Date.now();
        while (isProcessRunning(pid) && Date.now() - start < 2000) {
          // Busy wait up to 2 seconds
        }

        if (isProcessRunning(pid)) {
          logger.warn('MCP', `Orphan ${pid} didn't exit gracefully, sending SIGKILL`);
          process.kill(pid, 'SIGKILL');
        }

        logger.info('MCP', `✅ Orphan ${pid} terminated`);
      } catch (killError) {
        // Ignore errors for individual kills (process may have died)
      }
    }
  } catch (error) {
    // pgrep failed or no matches - that's fine
    logger.debug('MCP', 'No orphan processes found');
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  try {
    // First, kill ANY orphan processes matching our pattern (not just lock file PID)
    killOrphanProcesses();

    // Check if lock file exists
    if (fs.existsSync(LOCK_FILE)) {
      const existingPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);

      if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
        // Another instance is running — kill it and take over
        console.error(`⚠️  Another Discord MCP instance running (PID: ${existingPid}) — killing it`);
        try {
          process.kill(existingPid, 'SIGTERM');
          // Give it a moment to clean up
          const start = Date.now();
          while (isProcessRunning(existingPid) && Date.now() - start < 3000) {
            // Busy wait up to 3 seconds for old process to die
          }
          if (isProcessRunning(existingPid)) {
            // Force kill if still running
            console.error(`   Old process didn't exit gracefully, sending SIGKILL`);
            process.kill(existingPid, 'SIGKILL');
          }
          console.error(`   ✅ Old instance terminated, taking over`);
        } catch (killError) {
          console.error(`   Failed to kill old process:`, killError);
        }
      } else {
        // Stale lock file - PID not running, just log it
        console.error(`🧹 Removing stale lock file (PID ${existingPid} not running)`);
      }

      // Remove the lock file if it still exists (old process may have cleaned it up on exit)
      if (fs.existsSync(LOCK_FILE)) {
        fs.unlinkSync(LOCK_FILE);
      }
    }

    // Write our PID to lock file
    fs.writeFileSync(LOCK_FILE, process.pid.toString());
    console.error(`🔒 Lock acquired (PID: ${process.pid})`);
    return true;
  } catch (error) {
    console.error(`❌ Failed to acquire lock:`, error);
    return false;
  }
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const lockedPid = parseInt(fs.readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      // Only remove if we own the lock
      if (lockedPid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
        console.error(`🔓 Lock released (PID: ${process.pid})`);
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// Register cleanup handlers
process.on('exit', () => {
  logger.info('MCP', 'Process exiting');
  releaseLock();
});
process.on('SIGINT', () => {
  logger.info('MCP', 'Received SIGINT');
  logger.stopHeartbeat();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  logger.info('MCP', 'Received SIGTERM');
  logger.stopHeartbeat();
  releaseLock();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  logger.fatal('MCP', 'Uncaught exception', { error: err.message, stack: err.stack });
  logger.stopHeartbeat();
  releaseLock();
  process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Configuration
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const OWNER_USER_ID = resolveOwnerUserId();
const BOT_API_SECRET = process.env.BOT_API_SECRET || '';
const BOT_API_PORT = parseInt(process.env.BOT_API_PORT || '3000', 10);
const BOT_API_URL = process.env.BOT_API_URL || ''; // If set, proxy mode — forward to cloud

// --- Proxy Mode ---
// When BOT_API_URL is set, this MCP server becomes a thin HTTP client.
// No Discord connection, no lock needed. Just forwards tool calls to the cloud bot.
const PROXY_MODE = !!BOT_API_URL;


// Store pending mentions and DMs for MCP tools (direct mode only)
const pendingDMs: MentionEvent[] = [];
const pendingMentions: MentionEvent[] = [];

// Initialize components (only in direct mode)
const discordClient = PROXY_MODE ? null! : new DiscordClient(OWNER_USER_ID);
// Journal sync only when the memory plug is on; with memory 'off' (public default) nothing queues (14 Oct review).
const memory = new MemoryManager(path.resolve(__dirname, '../memory-ledger.json'), undefined, houseConfig.plugs.memory !== 'off');
const claude = PROXY_MODE ? null! : new ClaudeClient(ANTHROPIC_API_KEY);

// Create low-level MCP server
const server = new Server(
  {
    name: identity.runtime.mcp_server_name,
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define available tools
const TOOLS = composeTools(
  VIEW_ATTACHMENT_TOOL,
);

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Proxy-mode config: the values the proxy handlers read from module scope
const proxyConfig: ProxyConfig = {
  botApiUrl: BOT_API_URL,
  botApiSecret: BOT_API_SECRET,
  defaultAttachmentsDir: path.resolve(__dirname, '../.discord_attachments'),
};
const proxyRequest = (endpoint: string, body: Record<string, unknown>) => proxyRequestWith(proxyConfig, endpoint, body);

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Proxy mode: forward everything to cloud
  if (PROXY_MODE) {
    if (name === 'discord_view_attachment') {
      return handleProxyViewAttachment(args, proxyRequest);
    }
    return handleProxyToolCall(proxyConfig, name, args as Record<string, unknown> | undefined);
  }

  // Direct mode: handle locally
  if (!discordClient.isReady && name !== 'discord_check_mentions') {
    return {
      content: [{ type: 'text', text: 'Discord client is not ready yet.' }],
    };
  }
  switch (name) {
    case 'discord_view_attachment':
      return {
        content: [{ type: 'text', text: VIEW_ATTACHMENT_DIRECT_ERROR }],
        isError: true,
      };
  }

  return handleDirectToolCall(name, args as Record<string, unknown> | undefined, {
    discordClient,
    memory,
    pendingMentions,
    pendingDMs,
  });
});

// --- Event Handlers (direct mode only) ---
// In proxy mode, the cloud server handles all events.
if (!PROXY_MODE) {

  // Handle mentions - remove existing listeners first to prevent duplicates on reconnect
  discordClient.removeAllListeners('mention');
  discordClient.removeAllListeners('dm');
  discordClient.removeAllListeners('ownerPresenceChange');

  discordClient.on('mention', async (event: MentionEvent) => {
    console.error(`\n📨 Mention detected from ${event.authorTag} in ${event.channelName}`);

    if (discordClient.isOwner(event.authorId)) {
      // The owner mentioned the bot — log only, no auto-response
      console.error(`   👑 ${identity.owner_name} mentioned — auto-response disabled`);
    } else {
      // Someone else mentioned the bot - DM the owner, don't respond
      console.error(`   📩 Non-owner mention - notifying ${identity.owner_name} via DM`);

      const location = event.guildName
        ? `#${event.channelName} in ${event.guildName}`
        : 'a DM';

      // Build message link: https://discord.com/channels/[server_id]/[channel_id]/[message_id]
      const guildId = event.message.guild?.id || '@me';
      const messageLink = `https://discord.com/channels/${guildId}/${event.channelId}/${event.message.id}`;

      const notification = `**${identityVars().Bot} mentioned**\n\n` +
        `**By:** ${event.authorTag}\n` +
        `**Where:** ${location}\n` +
        `**When:** ${event.timestamp.toISOString()}\n` +
        `**Message:** "${event.content}"\n\n` +
        `**[Jump to message](${messageLink})**`;

      await discordClient.sendDM(OWNER_USER_ID, notification);

      // Also store in pending mentions for MCP tool
      pendingMentions.push(event);
      console.error(`   ✅ ${identity.owner_name} notified via DM`);
    }
  });

  // Handle incoming DMs
  discordClient.on('dm', async (event: MentionEvent) => {
    console.error(`\n💬 DM received from ${event.authorTag}`);

    // Extract forwarded message content if present
    let fullContent = event.content;
    if (event.message.messageSnapshots && event.message.messageSnapshots.size > 0) {
      const forwardedParts = Array.from(event.message.messageSnapshots.values()).map((snapshot: any) => {
        const fwdContent = snapshot.message?.content ?? snapshot.content;
        const fwdAttachments = snapshot.message?.attachments ?? snapshot.attachments;

        let fwdText = '[Forwarded Message]';
        if (fwdContent) {
          fwdText += `\n${fwdContent}`;
        }
        if (fwdAttachments && fwdAttachments.size > 0) {
          const attachList = Array.from(fwdAttachments.values()).map((att: any) => att.url).join('\n');
          fwdText += `\n[Attachments: ${attachList}]`;
        }
        return fwdText;
      });
      fullContent = fullContent ? `${fullContent}\n\n${forwardedParts.join('\n')}` : forwardedParts.join('\n');
    }

    // Store in memory for context
    await memory.addMessage(event.channelId, {
      role: 'user',
      content: fullContent,
      timestamp: event.timestamp.toISOString(),
      author: event.authorTag,
      userId: event.authorId,
    });

    // Add to pending DMs for MCP tool access
    pendingDMs.push(event);

    // Also notify the owner via DM — forward full message including attachments
    const dmAttachments = event.message?.attachments;
    let attachmentInfo = '';
    const forwardedFiles: Array<{ file: string; name?: string }> = [];

    if (dmAttachments && dmAttachments.size > 0) {
      const attList = Array.from(dmAttachments.values()).map(att => {
        forwardedFiles.push({ file: att.url, name: att.name || undefined });
        return `- ${att.name} (${att.contentType || 'unknown'})`;
      });
      attachmentInfo = `\n**Attachments:** ${dmAttachments.size} file(s) (forwarded below)\n${attList.join('\n')}\n`;
    }

    const notification = `**New DM received**\n\n` +
      `**From:** ${event.authorTag}\n` +
      `**User ID:** ${event.authorId}\n` +
      `**Channel ID:** ${event.channelId}\n` +
      `**When:** ${event.timestamp.toISOString()}\n` +
      `**Message:** "${fullContent}"` +
      `${attachmentInfo}\n\n` +
      `Use \`discord_get_dm_channel\` with the user ID to read the full conversation.`;

    await discordClient.sendDM(
      OWNER_USER_ID,
      notification,
      forwardedFiles.length > 0 ? forwardedFiles : undefined
    );
    console.error(`   ✅ DM stored and ${identity.owner_name} notified${forwardedFiles.length > 0 ? ` (${forwardedFiles.length} attachment(s) forwarded)` : ''}`);
  });

  // Handle the owner's presence changes
  discordClient.on('ownerPresenceChange', (isOnline: boolean) => {
    console.error(`🔄 ${identity.owner_name} is now ${isOnline ? 'online' : 'offline'}`);
  });

} // end if (!PROXY_MODE)

// Main startup
async function main() {
  const logPaths = logger.getLogPaths();

  if (PROXY_MODE) {
    // --- Proxy Mode: thin HTTP client ---
    logger.info('MCP', `🚀 Starting ${identityVars().Bot} MCP Server (PROXY MODE)...`);
    logger.info('MCP', `Forwarding to: ${BOT_API_URL}`);

    if (!BOT_API_SECRET) {
      logger.fatal('MCP', '❌ BOT_API_SECRET is required for proxy mode');
      process.exit(1);
    }

    // Start MCP server on stdio — just forwards to cloud
    logger.info('MCP', '🔌 Starting MCP server on stdio...');
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('MCP', '✅ Proxy MCP Server running');
    logger.info('MCP', `All tool calls → ${BOT_API_URL}`);
  } else {
    // --- Direct Mode: full bot ---
    logger.info('MCP', `🚀 Starting ${identityVars().Bot} Discord MCP Server (DIRECT MODE)...`);
    logger.info('MCP', `Log directory: ${logPaths.logDir}`);

    // Acquire lock to prevent multiple instances
    if (!acquireLock()) {
      logger.warn('MCP', '🛑 Exiting to prevent duplicate instance.');
      process.exit(0);
    }

    // Validate configuration
    if (!DISCORD_TOKEN) {
      logger.fatal('MCP', '❌ DISCORD_BOT_TOKEN is required');
      process.exit(1);
    }
    if (!ANTHROPIC_API_KEY) {
      logger.fatal('MCP', '❌ ANTHROPIC_API_KEY is required');
      process.exit(1);
    }

    // Start heartbeat
    logger.startHeartbeat();

    // Initialize memory
    await memory.initialize();

    // Login to Discord
    logger.info('MCP', '🔌 Connecting to Discord...');
    await discordClient.login(DISCORD_TOKEN);

    // Start HTTP API server if secret is configured
    if (BOT_API_SECRET) {
      logger.info('MCP', '🌐 Starting HTTP API server...');
      // Settings page in run-on-your-own-computer mode too (public default: local settings file).
      // A House setup keeps its settings in solance-api and serves the page from the cloud bot only.
      let dashboard;
      if (houseConfig.plugs.settings === 'local') {
        const localStore = new LocalSettingsStore();
        // The same persona provider the cloud entry builds: the page's persona section needs it (501 without).
        // Public direct builds only; a sanctum-model setup keeps the House path with no persona section.
        const persona = houseConfig.plugs.model === 'sanctum' ? undefined : personaFromEnv(process.env, () => localStore.peekPersona());
        dashboard = { settingsStore: localStore, plugs: houseConfig.plugs, houseLabels: houseConfig.labels, persona };
      }
      createHttpServer(discordClient, memory, BOT_API_SECRET, BOT_API_PORT, dashboard);
    } else {
      logger.info('MCP', '⏭️  HTTP API skipped (no BOT_API_SECRET configured)');
    }

    // Start MCP server on stdio
    logger.info('MCP', '🔌 Starting MCP server on stdio...');
    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info('MCP', `✅ ${identityVars().Bot} MCP Server running`);
    logger.info('MCP', `Owner user ID: ${OWNER_USER_ID}`);
    logger.info('MCP', `Responding to ${identity.owner_name}'s mentions automatically`);
    logger.info('MCP', `Other mentions will DM ${identity.owner_name}`);
    logger.info('MCP', `Heartbeat file: ${logPaths.heartbeatFile}`);
    if (BOT_API_SECRET) {
      logger.info('MCP', `HTTP API: http://0.0.0.0:${BOT_API_PORT}`);
    }
  }
}

main().catch((error) => {
  logger.fatal('MCP', 'Fatal error during startup', { error: error.message, stack: error.stack });
  process.exit(1);
});
