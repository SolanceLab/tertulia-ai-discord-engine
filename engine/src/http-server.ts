// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * HTTP API Server for the bot Discord Bot
 *
 * Wraps all discordClient methods behind authenticated HTTP endpoints.
 * This enables multiple MCP clients (Desktop, Code, Cowork) to share
 * one Discord bot instance via HTTP instead of fighting over stdio.
 *
 * Auth: Bearer token in Authorization header.
 * All endpoints are POST to keep tokens out of URLs/logs.
 */

import express, { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { DiscordClient, toReplyReference } from './discord-client.js';
import { MemoryManager } from './memory.js';
import { logger } from './logger.js';
import { isImageAttachment, toMessageAttachments, safeFilename } from './attachments.js';
import { isAgentConnected } from './agent-presence.js';
import { type DashboardDeps, createDashboardRouter } from './dashboard/routes.js';
import { updatePersona, readInstructions, readPersona, PersonaEditError, updateInstructions } from './persona-edit.js';
import { validateEmbeds, embedsOf } from './discord/embeds.js';
import { mapMessagesForApi } from './discord/message-api.js';
import { ToolRefusal } from './role-admin.js';
import { renderAttachmentImage, IMAGES_PER_RESULT, AttachmentImageError } from './attachment-image.js';

// --- Rate Limiter ---

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

class RateLimiter {
  private entries: Map<string, RateLimitEntry> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number = 60, windowMs: number = 60_000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.entries.get(ip);

    if (!entry || now > entry.resetAt) {
      this.entries.set(ip, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.maxRequests - 1, resetAt: now + this.windowMs };
    }

    entry.count++;
    const allowed = entry.count <= this.maxRequests;
    return { allowed, remaining: Math.max(0, this.maxRequests - entry.count), resetAt: entry.resetAt };
  }

  // Clean expired entries periodically
  cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.entries) {
      if (now > entry.resetAt) {
        this.entries.delete(ip);
      }
    }
  }
}

// --- Auth Middleware ---

function createAuthMiddleware(apiSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Health check doesn't need auth
    if (req.path === '/health') {
      next();
      return;
    }

    const authHeader = req.headers.authorization;

    if (!authHeader) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }

    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Invalid Authorization format. Use: Bearer <token>' });
      return;
    }

    const token = authHeader.slice(7);

    // Constant-time comparison to prevent timing attacks
    const expected = Buffer.from(apiSecret);
    const received = Buffer.from(token);

    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
      logger.warn('HTTP', `Unauthorized request from ${req.ip}`, { path: req.path });
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    next();
  };
}

// --- Rate Limit Middleware ---

function createRateLimitMiddleware(limiter: RateLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const { allowed, remaining, resetAt } = limiter.check(ip);

    res.setHeader('X-RateLimit-Remaining', remaining.toString());
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAt / 1000).toString());

    if (!allowed) {
      logger.warn('HTTP', `Rate limited ${ip}`, { path: req.path });
      res.status(429).json({ error: 'Too many requests' });
      return;
    }

    next();
  };
}

// --- Server Setup ---

export function createHttpServer(
  discordClient: DiscordClient,
  memory: MemoryManager,
  apiSecret: string,
  port: number = 3000,
  dashboard?: DashboardDeps
) {
  const app = express();
  const rateLimiter = new RateLimiter(60, 60_000); // 60 requests per minute

  // Cleanup rate limiter every 5 minutes
  setInterval(() => rateLimiter.cleanup(), 5 * 60_000);

  // The bot's own settings page: its own password + cookie, mounted BEFORE the bot-secret middleware.
  // Off (503) unless DASHBOARD_PASSWORD is set.
  if (dashboard) app.use('/settings', createDashboardRouter({ ...dashboard, agentLastSeen: dashboard.agentLastSeen ?? (() => discordClient.agentPresence.lastSeen()),
    listener: dashboard.listener ?? (() => discordClient.studyAsides.listener.current()),
    stopListener: dashboard.stopListener ?? (() => discordClient.studyAsides.listener.release()) }));

  // Middleware
  app.use(express.json({ limit: '10mb' })); // 10mb for file uploads (base64)
  app.use(createRateLimitMiddleware(rateLimiter));
  app.use(createAuthMiddleware(apiSecret));

  // --- Health Check (no auth required) ---

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      discord: discordClient.isReady ? 'connected' : 'disconnected',
      uptime: process.uptime(),
    });
  });

  // --- Message Tools ---

  app.post('/api/read-messages', async (req: Request, res: Response) => {
    try {
      const { channel_id, limit = 20 } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }

      const messages = await discordClient.getRecentMessages(channel_id, Math.min(limit, 50));

      const formatted = await mapMessagesForApi(discordClient, messages);

      res.json({ messages: formatted });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/send-message', async (req: Request, res: Response) => {
    try {
      const { channel_id, content, reply_to_message_id, sticker_ids, embeds } = req.body;
      const hasContent = typeof content === 'string' && content.length > 0;
      const hasStickers = Array.isArray(sticker_ids) && sticker_ids.length > 0;
      const hasEmbeds = Array.isArray(embeds) && embeds.length > 0;
      if (!channel_id || (!hasContent && !hasStickers && !hasEmbeds)) {
        res.status(400).json({ error: 'channel_id required, and at least one of content, sticker_ids or embeds must be provided' });
        return;
      }
      const embedError = embeds === undefined ? null : validateEmbeds(embeds);
      if (embedError) {
        res.status(400).json({ error: embedError });
        return;
      }

      const sent = await discordClient.sendMessage(channel_id, content, undefined, reply_to_message_id, sticker_ids, { ownerDirected: true, embeds });
      if (sent) {
        await memory.addMessage(channel_id, {
          role: 'assistant',
          content: hasContent ? content : hasEmbeds ? '[embed]' : '[sticker]',
          timestamp: new Date().toISOString(),
        });
        res.json({ success: true, message_id: sent.id });
      } else {
        res.status(500).json({ error: 'Failed to send message' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- /aside to:study: the Mac's Study session reads, claims and answers the owner's private asks ---
  // While a session is listening (below), pending and claim serve THAT session only: it sends its session_id.
  // The fresh-session watcher sends none, so it gets an empty list and steps back. Nobody listening = open, as before.
  app.get('/api/aside/study/pending', (req: Request, res: Response) => {
    discordClient.agentPresence.touch(); // every authenticated agent poll counts as "seen"
    const sid = typeof req.query?.session_id === 'string' ? req.query.session_id : undefined;
    res.json({ pending: discordClient.studyAsides.pending(sid) });
  });

  // --- the one listening session (study-listener.ts): newest claim wins, a heartbeat inside 3 minutes keeps it ---
  app.post('/api/aside/study/listen', (req: Request, res: Response) => {
    discordClient.agentPresence.touch();
    const { session_id, name } = req.body ?? {};
    if (typeof session_id !== 'string' || !session_id.trim()) { res.status(400).json({ error: 'session_id required' }); return; }
    if (!discordClient.studyAsides.listener.listen({ session_id, name })) { res.status(400).json({ error: 'session_id required' }); return; }
    res.json({ listening: discordClient.studyAsides.listener.current() });
  });
  app.post('/api/aside/study/heartbeat', (req: Request, res: Response) => {
    discordClient.agentPresence.touch();
    const sid = req.body?.session_id;
    // 409 = this session is not the listener (released, replaced by a newer claim, or lapsed): stop, or claim again.
    if (typeof sid !== 'string' || !discordClient.studyAsides.listener.heartbeat(sid)) { res.status(409).json({ error: 'not the listening session', listening: discordClient.studyAsides.listener.current() }); return; }
    res.json({ listening: discordClient.studyAsides.listener.current() });
  });
  app.post('/api/aside/study/unlisten', (req: Request, res: Response) => {
    const sid = typeof req.body?.session_id === 'string' ? req.body.session_id : undefined;   // no id = Stop from the settings page
    const released = discordClient.studyAsides.listener.release(sid);
    res.json({ released, listening: discordClient.studyAsides.listener.current() });
  });
  app.get('/api/aside/study/listener', (_req: Request, res: Response) => {
    res.json({ listening: discordClient.studyAsides.listener.current() });
  });

  app.get('/api/agent/status', (_req: Request, res: Response) => {
    const seen = discordClient.agentPresence.lastSeen();
    res.json({ last_seen: seen === null ? null : new Date(seen).toISOString(), connected: isAgentConnected(seen, Date.now()) });
  });

  app.post('/api/aside/study/claim', (req: Request, res: Response) => {
    const id = String(req.body?.id ?? '');
    const sid = typeof req.body?.session_id === 'string' ? req.body.session_id : undefined;
    if (!discordClient.studyAsides.claim(id, sid)) { res.status(409).json({ error: 'not claimable (unknown, expired or already claimed)' }); return; }
    res.json({ claimed: id });
  });

  app.post('/api/aside/study/release', (req: Request, res: Response) => {
    const id = String(req.body?.id ?? '');
    if (!discordClient.studyAsides.release(id)) { res.status(409).json({ error: 'not releasable' }); return; }
    res.json({ released: id });
  });

  app.post('/api/aside/study/answer', async (req: Request, res: Response) => {
    try {
      const { id, note, proposal } = req.body ?? {};
      if (typeof id !== 'string' || typeof note !== 'string') { res.status(400).json({ error: 'id and note required' }); return; }
      const result = await discordClient.answerStudyAside(id, note.slice(0, 4000), typeof proposal === 'string' && proposal.trim() ? proposal.slice(0, 1900) : null);
      res.status(result.delivered === 'none' ? 409 : 200).json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/send-dm', async (req: Request, res: Response) => {
    try {
      const { user_id, content } = req.body;
      if (!user_id || !content) {
        res.status(400).json({ error: 'user_id and content required' });
        return;
      }

      const sent = await discordClient.sendDM(user_id, content);
      if (sent) {
        res.json({ success: true, message_id: sent.message.id, channel_id: sent.channelId });
      } else {
        res.status(500).json({ error: 'Failed to send DM' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/get-dm-channel', async (req: Request, res: Response) => {
    try {
      const { user_id } = req.body;
      if (!user_id) {
        res.status(400).json({ error: 'user_id required' });
        return;
      }

      const result = await discordClient.getDMChannelId(user_id);
      if (result) {
        res.json(result);
      } else {
        res.status(404).json({ error: 'User not found or cannot create DM channel' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/send-file', async (req: Request, res: Response) => {
    try {
      const { channel_id, file_data, file_name, content } = req.body;
      if (!channel_id || !file_data || !file_name) {
        res.status(400).json({ error: 'channel_id, file_data (base64), and file_name required' });
        return;
      }

      const fileBuffer = Buffer.from(file_data, 'base64');
      const sent = await discordClient.sendFile(channel_id, fileBuffer, {
        name: file_name,
        content,
      });

      if (sent) {
        res.json({ success: true, message_id: sent.id });
      } else {
        res.status(500).json({ error: 'Failed to send file' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Channel Management ---

  app.post('/api/list-channels', async (req: Request, res: Response) => {
    try {
      const { server_id } = req.body;
      if (!server_id) {
        res.status(400).json({ error: 'server_id required' });
        return;
      }

      const channels = await discordClient.listServerChannels(server_id);
      if (channels) {
        res.json(channels);
      } else {
        res.status(404).json({ error: 'Server not found' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/create-channel', async (req: Request, res: Response) => {
    try {
      const { server_id, name, type = 'text', category_id, topic, nsfw } = req.body;
      if (!server_id || !name) {
        res.status(400).json({ error: 'server_id and name required' });
        return;
      }

      const result = await discordClient.createChannel(server_id, name, type, {
        categoryId: category_id,
        topic,
        nsfw,
      });

      if (result) {
        res.json({ success: true, ...result });
      } else {
        res.status(500).json({ error: 'Failed to create channel' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/set-channel-topic', async (req: Request, res: Response) => {
    try {
      const { channel_id, topic } = req.body;
      if (!channel_id || topic === undefined) {
        res.status(400).json({ error: 'channel_id and topic required' });
        return;
      }

      const success = await discordClient.setChannelTopic(channel_id, topic);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/rename-channel', async (req: Request, res: Response) => {
    try {
      const { channel_id, new_name } = req.body;
      if (!channel_id || !new_name) {
        res.status(400).json({ error: 'channel_id and new_name required' });
        return;
      }

      const success = await discordClient.renameChannel(channel_id, new_name);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/delete-channel', async (req: Request, res: Response) => {
    try {
      const { channel_id, reason } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }

      const success = await discordClient.deleteChannel(channel_id, reason);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/create-category', async (req: Request, res: Response) => {
    try {
      const { server_id, name, position } = req.body;
      if (!server_id || !name) {
        res.status(400).json({ error: 'server_id and name required' });
        return;
      }

      const result = await discordClient.createCategory(server_id, name, position);
      if (result) {
        res.json({ success: true, ...result });
      } else {
        res.status(500).json({ error: 'Failed to create category' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/move-channel', async (req: Request, res: Response) => {
    try {
      const { channel_id, category_id, position } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }

      const success = await discordClient.moveChannel(channel_id, category_id, position);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Reactions & Polls ---

  app.post('/api/add-reaction', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id, emoji } = req.body;
      if (!channel_id || !message_id || !emoji) {
        res.status(400).json({ error: 'channel_id, message_id, and emoji required' });
        return;
      }

      const success = await discordClient.addReaction(channel_id, message_id, emoji);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/get-reactions', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id } = req.body;
      if (!channel_id || !message_id) {
        res.status(400).json({ error: 'channel_id and message_id required' });
        return;
      }

      const reactions = await discordClient.getReactions(channel_id, message_id);
      if (reactions !== null) {
        res.json({ reactions });
      } else {
        res.status(500).json({ error: 'Failed to fetch reactions' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/create-poll', async (req: Request, res: Response) => {
    try {
      const { channel_id, question, options, duration_hours = 24, allow_multiselect = false } = req.body;
      if (!channel_id || !question || !options || options.length < 2) {
        res.status(400).json({ error: 'channel_id, question, and options (min 2) required' });
        return;
      }

      const result = await discordClient.createPoll(channel_id, question, options, duration_hours, allow_multiselect);
      if (result) {
        res.json({ success: true, ...result });
      } else {
        res.status(500).json({ error: 'Failed to create poll' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Message Management ---

  app.post('/api/edit-message', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id, new_content, embeds } = req.body;
      if (!channel_id || !message_id) {
        res.status(400).json({ error: 'channel_id and message_id required' });
        return;
      }
      if (typeof new_content !== 'string' && !Array.isArray(embeds)) {
        res.status(400).json({ error: 'at least one of new_content or embeds required' });
        return;
      }
      const embedError = embeds === undefined ? null : validateEmbeds(embeds);
      if (embedError) {
        res.status(400).json({ error: embedError });
        return;
      }

      const success = await discordClient.editMessage(channel_id, message_id, typeof new_content === 'string' ? new_content : undefined, embeds);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/delete-message', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id } = req.body;
      if (!channel_id || !message_id) {
        res.status(400).json({ error: 'channel_id and message_id required' });
        return;
      }

      const success = await discordClient.deleteMessage(channel_id, message_id);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/pin-message', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id } = req.body;
      if (!channel_id || !message_id) {
        res.status(400).json({ error: 'channel_id and message_id required' });
        return;
      }

      const success = await discordClient.pinMessage(channel_id, message_id);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Threads & Forums ---

  app.post('/api/create-thread', async (req: Request, res: Response) => {
    try {
      const { channel_id, name, message_id, auto_archive_duration } = req.body;
      if (!channel_id || !name) {
        res.status(400).json({ error: 'channel_id and name required' });
        return;
      }

      const threadId = await discordClient.createThread(channel_id, name, message_id, auto_archive_duration);
      if (threadId) {
        res.json({ success: true, thread_id: threadId });
      } else {
        res.status(500).json({ error: 'Failed to create thread' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/create-forum-post', async (req: Request, res: Response) => {
    try {
      const { channel_id, title, content, tags } = req.body;
      if (!channel_id || !title || !content) {
        res.status(400).json({ error: 'channel_id, title, and content required' });
        return;
      }

      const result = await discordClient.createForumPost(channel_id, title, content, tags);
      if (result) {
        res.json({ success: true, ...result });
      } else {
        res.status(500).json({ error: 'Failed to create forum post' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/list-forum-threads', async (req: Request, res: Response) => {
    try {
      const { channel_id, limit = 20, include_archived = false } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }

      const threads = await discordClient.listForumThreads(channel_id, limit, include_archived);
      res.json({ threads });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Attachments ---

  app.post('/api/get-attachment-urls', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id, filename } = req.body;
      if (!channel_id || !message_id) {
        res.status(400).json({ error: 'channel_id and message_id required' });
        return;
      }

      // Access the underlying discord.js client to fetch the specific message
      const channel = await (discordClient as any).client.channels.fetch(channel_id);
      if (!channel || !('messages' in channel)) {
        res.status(404).json({ error: 'Channel not found or not readable' });
        return;
      }

      const message = await (channel as any).messages.fetch(message_id);
      if (!message || message.attachments.size === 0) {
        res.status(404).json({ error: 'No attachments found on this message' });
        return;
      }

      let attachments = Array.from(message.attachments.values()) as any[];
      if (filename) {
        attachments = attachments.filter((att: any) => att.name === filename);
      }

      // Return fresh CDN URLs (not base64 — bloats context)
      const urls = attachments.map((att: any) => ({
        name: att.name,
        url: att.url,
        contentType: att.contentType || 'application/octet-stream',
        size: att.size,
        width: att.width,
        height: att.height,
      }));

      res.json({ attachments: urls });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * Return ONE attachment as base64 JPEG, sized to fit an MCP tool result.
   *
   * `/api/get-attachment-urls` deliberately returns links and not bytes ("not
   * base64 — bloats context"), which is correct for every caller that can then
   * go and fetch the link. another client cannot: claude.ai has no filesystem, and
   * its fetch layer rejects a URL that did not arrive from a prior search. So
   * for that wing the bytes have to travel inside the tool result itself, and
   * this is the only endpoint that does that.
   *
   * One image per call is arithmetic, not policy — see IMAGES_PER_RESULT.
   */
  app.post('/api/get-attachment-image', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id, filename } = req.body;
      if (!channel_id || !message_id) {
        res.status(400).json({ error: 'channel_id and message_id required' });
        return;
      }

      const channel = await (discordClient as any).client.channels.fetch(channel_id);
      if (!channel || !('messages' in channel)) {
        res.status(404).json({ error: 'Channel not found or not readable' });
        return;
      }

      const message = await (channel as any).messages.fetch(message_id);
      if (!message || message.attachments.size === 0) {
        res.status(404).json({ error: 'No attachments found on this message' });
        return;
      }

      // Classify with the same predicate the reply path uses, so a file that
      // counts as an image here counts as one everywhere.
      const all = toMessageAttachments(message.attachments);
      const images = all.filter(att => isImageAttachment(att));

      if (images.length === 0) {
        res.status(415).json({
          error: 'That message has attachments, but none of them are viewable images.',
          attachments: all.map(a => a.filename ?? '(unnamed)'),
        });
        return;
      }

      const wanted = filename ? safeFilename(String(filename)) : undefined;
      const chosen = wanted
        ? images.find(att => att.filename === wanted)
        : images[0];

      if (!chosen) {
        res.status(404).json({
          error: `No image named "${wanted}" on that message.`,
          available: images.map(a => a.filename ?? '(unnamed)'),
        });
        return;
      }

      const rendered = await renderAttachmentImage(chosen.url);

      // Always report the siblings. A caller that can only carry one image per
      // result still needs to know a second one exists, or it will describe a
      // two-frame post as though it were one.
      const others = images
        .filter(att => att !== chosen)
        .map(att => att.filename ?? '(unnamed)');

      res.json({
        filename: chosen.filename ?? '(unnamed)',
        image: {
          data: rendered.data,
          mimeType: rendered.mimeType,
          width: rendered.width,
          height: rendered.height,
        },
        rendering: {
          downscaled: rendered.downscaled,
          maxEdge: rendered.edge,
          quality: rendered.quality,
          base64Chars: rendered.base64Chars,
          sourceBytes: rendered.sourceBytes,
        },
        imagesOnMessage: images.length,
        imagesPerResult: IMAGES_PER_RESULT,
        otherImages: others,
      });
    } catch (error) {
      if (error instanceof AttachmentImageError) {
        // A refusal we understand and can explain — not a server fault.
        res.status(422).json({ error: error.message });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  /**
   * Find a message from its ID alone, sweeping every channel the bot can see.
   *
   * Owner, 10 Aug 2026 — she had a bare message ID and no channel, which Discord
   * offers no endpoint for. See DiscordClient.findMessage for why this is a
   * pruned sweep rather than brute force.
   */
  app.post('/api/find-message', async (req: Request, res: Response) => {
    try {
      const { message_id, server_id } = req.body;
      if (!message_id) {
        res.status(400).json({ error: 'message_id required' });
        return;
      }
      const result = await discordClient.findMessage(String(message_id), server_id ? String(server_id) : undefined);
      if (!result.found && result.error) {
        res.status(400).json(result);
        return;
      }
      res.status(result.found ? 200 : 404).json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Moderation ---

  app.post('/api/timeout-user', async (req: Request, res: Response) => {
    try {
      const { server_id, user_id, duration_minutes, reason } = req.body;
      if (!server_id || !user_id || !duration_minutes) {
        res.status(400).json({ error: 'server_id, user_id, and duration_minutes required' });
        return;
      }

      const success = await discordClient.timeoutUser(server_id, user_id, duration_minutes, reason);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/assign-role', async (req: Request, res: Response) => {
    try {
      const { server_id, user_id, role_id, reason } = req.body;
      if (!server_id || !user_id || !role_id) {
        res.status(400).json({ error: 'server_id, user_id, and role_id required' });
        return;
      }

      const success = await discordClient.assignRole(server_id, user_id, role_id, reason);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/remove-role', async (req: Request, res: Response) => {
    try {
      const { server_id, user_id, role_id, reason } = req.body;
      if (!server_id || !user_id || !role_id) {
        res.status(400).json({ error: 'server_id, user_id, and role_id required' });
        return;
      }

      const success = await discordClient.removeRole(server_id, user_id, role_id, reason);
      res.json({ success });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/create-role', async (req: Request, res: Response) => {
    try {
      const { server_id, name, permissions, color, hoist, mentionable, reason } = req.body;
      if (!server_id || !name) {
        res.status(400).json({ error: 'server_id and name required' });
        return;
      }

      const result = await discordClient.createRole(server_id, { name, permissions, color, hoist, mentionable }, reason);
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/edit-role', async (req: Request, res: Response) => {
    try {
      const { server_id, role_id, name, color, add, remove, hoist, mentionable, reason } = req.body;
      if (!server_id || !role_id) {
        res.status(400).json({ error: 'server_id and role_id required' });
        return;
      }

      const result = await discordClient.editRole(server_id, role_id, { name, color, add, remove, hoist, mentionable }, reason);
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/set-channel-permission', async (req: Request, res: Response) => {
    try {
      const { server_id, channel_id, target_id, target_type, allow, deny, neutral, clear, reason } = req.body;
      if (!server_id || !channel_id || !target_id || !target_type) {
        res.status(400).json({ error: 'server_id, channel_id, target_id, and target_type required' });
        return;
      }
      if (target_type !== 'role' && target_type !== 'member') {
        res.status(400).json({ error: "target_type must be 'role' or 'member'" });
        return;
      }

      const result = await discordClient.setChannelPermission(
        server_id,
        channel_id,
        target_id,
        target_type,
        { allow, deny, neutral, clear },
        reason
      );
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Awareness ---

  app.post('/api/list-members', async (req: Request, res: Response) => {
    try {
      const { server_id, limit = 100 } = req.body;
      if (!server_id) {
        res.status(400).json({ error: 'server_id required' });
        return;
      }

      const members = await discordClient.listMembers(server_id, limit);
      if (members) {
        res.json({ members });
      } else {
        res.status(404).json({ error: 'Server not found' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/get-user-info', async (req: Request, res: Response) => {
    try {
      const { server_id, user_id } = req.body;
      if (!server_id || !user_id) {
        res.status(400).json({ error: 'server_id and user_id required' });
        return;
      }

      const userInfo = await discordClient.getUserInfo(server_id, user_id);
      if (userInfo) {
        res.json(userInfo);
      } else {
        res.status(404).json({ error: 'User not found' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/list-roles', async (req: Request, res: Response) => {
    try {
      const { server_id } = req.body;
      if (!server_id) {
        res.status(400).json({ error: 'server_id required' });
        return;
      }

      const roles = await discordClient.listRoles(server_id);
      if (roles) {
        res.json({ roles });
      } else {
        res.status(404).json({ error: 'Server not found' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  app.post('/api/list-stickers', async (req: Request, res: Response) => {
    try {
      const { server_id } = req.body;
      if (!server_id) {
        res.status(400).json({ error: 'server_id required' });
        return;
      }

      const stickers = await discordClient.listStickers(server_id);
      if (stickers) {
        res.json({ stickers });
      } else {
        res.status(404).json({ error: 'Server not found' });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Search ---

  app.post('/api/search-messages', async (req: Request, res: Response) => {
    try {
      const { channel_id, author_id, keyword, before, after, has_attachment, limit = 20, scan_depth = 200 } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }

      // At least one filter required
      if (!author_id && !keyword && !before && !after && has_attachment === undefined) {
        res.status(400).json({ error: 'At least one filter (author_id, keyword, before, after, has_attachment) is required' });
        return;
      }

      const result = await discordClient.searchMessages(
        channel_id,
        {
          authorId: author_id,
          keyword,
          before,
          after,
          hasAttachment: has_attachment,
        },
        Math.min(limit, 50),
        Math.min(scan_depth, 500)
      );

      res.json(result);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Memory / History ---

  app.post('/api/get-history', async (req: Request, res: Response) => {
    try {
      const { channel_id, limit = 20 } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }

      const messages = memory.getRecentMessages(channel_id, limit);
      res.json({ messages });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: msg });
    }
  });

  // --- Persona + extra instructions (the companion's tools; the bot secret is the owner's key) ---
  // Changes made here are recorded as the agent's, so the owner sees who changed what and can undo it.

  const personaFailed = (res: Response, err: unknown) => {
    if (err instanceof PersonaEditError) { res.status(err.status).json({ error: err.message }); return; }
    logger.error('HTTP', 'persona request failed', { error: String((err as any)?.name || 'Error') });
    res.status(500).json({ error: 'persona request failed' });
  };

  app.post('/api/persona-read', async (_req: Request, res: Response) => {
    try {
      if (!dashboard) throw new PersonaEditError(501, 'settings are managed outside this bot for this setup');
      res.json(await readPersona(dashboard.settingsStore, dashboard.persona));
    } catch (err) { personaFailed(res, err); }
  });

  app.post('/api/persona-update', async (req: Request, res: Response) => {
    try {
      if (!dashboard) throw new PersonaEditError(501, 'settings are managed outside this bot for this setup');
      const { text, name, voice } = req.body ?? {};
      const patch: Record<string, unknown> = {};
      if (text !== undefined) patch.text = text;
      if (name !== undefined) patch.name = name;
      if (voice !== undefined) patch.voice = voice;
      res.json(await updatePersona(dashboard.settingsStore, dashboard.persona, patch, 'agent'));
    } catch (err) { personaFailed(res, err); }
  });

  app.post('/api/instructions-read', async (_req: Request, res: Response) => {
    try {
      if (!dashboard) throw new PersonaEditError(501, 'settings are managed outside this bot for this setup');
      res.json(await readInstructions(dashboard.settingsStore));
    } catch (err) { personaFailed(res, err); }
  });

  app.post('/api/instructions-update', async (req: Request, res: Response) => {
    try {
      if (!dashboard) throw new PersonaEditError(501, 'settings are managed outside this bot for this setup');
      const { text } = req.body ?? {};
      res.json(await updateInstructions(dashboard.settingsStore, text, 'agent'));
    } catch (err) { personaFailed(res, err); }
  });

  // --- Start Server ---

  // --- Tertúlia 1.2.0 ---
  // A ToolRefusal (a guard or a bad argument) answers 403 with its own words; anything else is a 500.
  const failTool = (res: Response, error: unknown) => {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(error instanceof ToolRefusal ? 403 : 500).json({ error: msg });
  };

  // Registered first, defined just below: each route's own code must sit after its own app.post line,
  // because mcp/tests/parity.test.mjs reads routes in slices that start at each app.post/get.
  app.get('/api/list-servers', (req: Request, res: Response) => listServersHandler(req, res));
  app.post('/api/list-servers', (req: Request, res: Response) => listServersHandler(req, res));
  // ONE handler for /api/list-servers. List mode (no server_id) answers the tool's shape
  // (member_count, icon_url, is_home) and keeps the settings page's fields (icon, channel_count,
  // joined_at, defaults) on each row; server_id mode answers one server in full.
  const listServersHandler = async (req: Request, res: Response) => {
    try {
      const server_id: unknown = req.body?.server_id ?? req.query?.server_id;
      const serverId = typeof server_id === 'string' && server_id ? server_id : undefined;
      const described: any = await discordClient.describeServers(serverId);
      if (!serverId && Array.isArray(described.servers)) {
        const legacy = new Map<string, Record<string, unknown>>(
          (discordClient.listServers() as Array<{ id: string }>).map((s) => [s.id, s as Record<string, unknown>]),
        );
        described.servers = described.servers.map((s: { id: string }) => ({ ...(legacy.get(s.id) ?? {}), ...s }));
      }
      res.json(described);
    } catch (error) {
      failTool(res, error);
    }
  };

  app.post('/api/unpin-message', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id } = req.body;
      if (!channel_id || !message_id) {
        res.status(400).json({ error: 'channel_id and message_id required' });
        return;
      }
      res.json({ success: await discordClient.unpinMessage(channel_id, message_id) });
    } catch (error) {
      failTool(res, error);
    }
  });

  app.post('/api/list-pins', async (req: Request, res: Response) => {
    try {
      const { channel_id, limit = 50 } = req.body;
      if (!channel_id) {
        res.status(400).json({ error: 'channel_id required' });
        return;
      }
      const messages = await discordClient.getPinnedMessages(channel_id, Number(limit));
      res.json({ messages: await mapMessagesForApi(discordClient, messages) });
    } catch (error) {
      failTool(res, error);
    }
  });

  app.post('/api/remove-reaction', async (req: Request, res: Response) => {
    try {
      const { channel_id, message_id, emoji } = req.body;
      if (!channel_id || !message_id || !emoji) {
        res.status(400).json({ error: 'channel_id, message_id and emoji required' });
        return;
      }
      res.json({ success: await discordClient.removeOwnReaction(channel_id, message_id, emoji) });
    } catch (error) {
      failTool(res, error);
    }
  });

  app.post('/api/read-audit-log', async (req: Request, res: Response) => {
    try {
      const { server_id, action, user_id, limit } = req.body;
      if (!server_id) {
        res.status(400).json({ error: 'server_id required' });
        return;
      }
      res.json(await discordClient.readAuditLog(server_id, { action, userId: user_id, limit }));
    } catch (error) {
      failTool(res, error);
    }
  });

  app.post('/api/edit-thread', async (req: Request, res: Response) => {
    try {
      const { thread_id, name, archived, locked, auto_archive_minutes } = req.body;
      if (!thread_id) {
        res.status(400).json({ error: 'thread_id required' });
        return;
      }
      res.json({ success: true, thread: await discordClient.editThread(thread_id, { name, archived, locked, autoArchiveMinutes: auto_archive_minutes }) });
    } catch (error) {
      failTool(res, error);
    }
  });

  app.post('/api/thread-member', async (req: Request, res: Response) => {
    try {
      const { thread_id, user_id, action } = req.body;
      if (!thread_id || !user_id || !action) {
        res.status(400).json({ error: 'thread_id, user_id and action required' });
        return;
      }
      res.json({ success: await discordClient.setThreadMember(thread_id, user_id, action) });
    } catch (error) {
      failTool(res, error);
    }
  });

  const server = app.listen(port, '0.0.0.0', () => {
    logger.info('HTTP', `API server listening on port ${port}`);
    logger.info('HTTP', `Health check: http://0.0.0.0:${port}/health`);
    logger.info('HTTP', `${Object.keys(ENDPOINT_MAP).length} endpoints available`);
  });

  return server;
}

// Endpoint map for documentation / MCP client reference
const ENDPOINT_MAP = {
  'read-messages': '/api/read-messages',
  'send-message': '/api/send-message',
  'send-dm': '/api/send-dm',
  'get-dm-channel': '/api/get-dm-channel',
  'send-file': '/api/send-file',
  'list-channels': '/api/list-channels',
  'create-channel': '/api/create-channel',
  'set-channel-topic': '/api/set-channel-topic',
  'rename-channel': '/api/rename-channel',
  'delete-channel': '/api/delete-channel',
  'create-category': '/api/create-category',
  'move-channel': '/api/move-channel',
  'add-reaction': '/api/add-reaction',
  'get-reactions': '/api/get-reactions',
  'create-poll': '/api/create-poll',
  'edit-message': '/api/edit-message',
  'delete-message': '/api/delete-message',
  'pin-message': '/api/pin-message',
  'create-thread': '/api/create-thread',
  'create-forum-post': '/api/create-forum-post',
  'list-forum-threads': '/api/list-forum-threads',
  'timeout-user': '/api/timeout-user',
  'assign-role': '/api/assign-role',
  'remove-role': '/api/remove-role',
  'create-role': '/api/create-role',
  'edit-role': '/api/edit-role',
  'set-channel-permission': '/api/set-channel-permission',
  'list-members': '/api/list-members',
  'get-user-info': '/api/get-user-info',
  'list-roles': '/api/list-roles',
  'list-stickers': '/api/list-stickers',
  'get-history': '/api/get-history',
  'search-messages': '/api/search-messages',
  'persona-read': '/api/persona-read',
  'persona-update': '/api/persona-update',
  'instructions-read': '/api/instructions-read',
  'instructions-update': '/api/instructions-update',
  'list-servers': '/api/list-servers',
  'unpin-message': '/api/unpin-message',
  'list-pins': '/api/list-pins',
  'remove-reaction': '/api/remove-reaction',
  'read-audit-log': '/api/read-audit-log',
  'edit-thread': '/api/edit-thread',
  'thread-member': '/api/thread-member',
} as const;

export { ENDPOINT_MAP };
