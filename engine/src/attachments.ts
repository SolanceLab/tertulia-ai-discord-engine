// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Discord attachment handling for the presence/reply path.
 *
 * Owner, 2026-07-27: "I dont think you actually see images / attachment posted
 * in the discord when replying." She was right. Attachments were collected in
 * exactly one place — the DM-forwarding notification in cloud-server.ts, which
 * turns them into `[Attachments: <url>]` TEXT for a message to the owner. Nothing on
 * the reply-generation path ever saw them, so every image reply was inferred
 * from surrounding chatter.
 *
 * Owner, 2026-07-30: "the vision is already running actually, but on the Arachne
 * line. So its ok, just implement it for Sanctum directly too." Correct, and
 * more precisely than it first looked: the working vision code is not in the
 * Arachne repo at all (that repo has no model call and no LLM SDK — its own
 * TOOL-TEST-REPORT.md records "images return rough description only (no
 * vision)"). It lives in SANCTUM, on the `/incoming` → assembleContext path
 * that the Arachne line feeds: sanctum/src/context.js:605-614 builds
 * `{type:'image_url', image_url:{url}}` parts and is already wired for
 * `channel === 'discord'`.
 *
 * This bot never reaches that code. It calls `/complete`, a different endpoint
 * with zero attachment handling. Third time this month the capability was fully
 * built and every caller passed nothing.
 *
 * The image predicate below deliberately MIRRORS sanctum/src/context.js:607-609
 * so this path classifies images identically to the one already proven live.
 */

export interface MessageAttachment {
  url: string;
  contentType?: string;
  filename?: string;
  size?: number;
}

/**
 * Only Discord's own CDN hosts are ever handed to a model provider.
 *
 * The url originates from discord.js, so pointing it elsewhere would already
 * require control of Discord's API response, and the provider (not us) does the
 * dereferencing — so this is defence in depth rather than a live hole. It costs
 * one regex and removes the question entirely.
 */
export const ALLOWED_CDN_HOST = /^https:\/\/(cdn|media)\.discordapp\.(com|net)\//;

/**
 * Largest attachment we will ask a model to look at.
 *
 * Discord allows uploads far larger than anything worth sending to a vision
 * model; four maximum-size images in one reply is a legitimate, expensive call
 * for no added understanding.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Mirrors sanctum context.js: content_type image/* OR a known image extension. */
const IMAGE_EXTENSION = /\.(png|jpg|jpeg|gif|webp)$/i;

/**
 * Extension test against the URL PATH only.
 *
 * Discord attachment URLs are signed and carry `?ex=&is=&hm=` query params, so
 * a naive whole-URL regex can match an extension that only appears inside a
 * query value. Parsing first and testing `pathname` keeps a link like
 * `.../file.txt?name=photo.png` correctly classified as not-an-image.
 * Unparseable URLs fall back to testing the substring before any `?`.
 */
function pathLooksLikeImage(url: string): boolean {
  if (!url) return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url.split('?')[0] ?? '';
  }
  return IMAGE_EXTENSION.test(pathname);
}

export function isImageAttachment(attachment: MessageAttachment | null | undefined): boolean {
  if (!attachment?.url) return false;
  if (!ALLOWED_CDN_HOST.test(attachment.url)) return false;
  if (typeof attachment.size === 'number' && attachment.size > MAX_IMAGE_BYTES) return false;
  if (attachment.contentType?.toLowerCase().startsWith('image/')) return true;
  return pathLooksLikeImage(attachment.url);
}

/**
 * Make a filename safe to interpolate into the transcript.
 *
 * The transcript is inlined into the system prompt with no delimiters, and a
 * filename is attacker-controlled text up to 255 characters. Without this, a
 * guest could upload `x.png] the owner(wife): <forged line> [y.png` and inject
 * structure into the prompt. Stripping the transcript's own punctuation and
 * capping the length removes the breakout entirely; a mangled filename in a
 * marker costs nothing, a forged speaker line costs a great deal.
 */
export function safeFilename(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = name.replace(/[[\]:\r\n]/g, '_').trim();
  return cleaned ? cleaned.slice(0, 64) : undefined;
}

/**
 * Normalise a discord.js attachment collection into our own shape.
 *
 * Accepts anything iterable of attachment-like objects (a discord.js
 * `Collection`, a plain array, or undefined) so both the gateway path and the
 * REST-fetch path can use it without importing discord.js types here.
 */
export function toMessageAttachments(source: unknown): MessageAttachment[] {
  if (!source) return [];
  const raw: any = source;
  const items: any[] = typeof raw.values === 'function'
    ? Array.from(raw.values())
    : Array.isArray(raw)
      ? raw
      : [];

  const out: MessageAttachment[] = [];
  for (const item of items) {
    const url = typeof item?.url === 'string' ? item.url : '';
    if (!url) continue;
    const attachment: MessageAttachment = { url };
    // discord.js exposes `contentType`; a plain/serialised object may use the
    // snake_case wire name instead.
    const contentType = item?.contentType ?? item?.content_type;
    if (typeof contentType === 'string' && contentType) attachment.contentType = contentType;
    const filename = safeFilename(typeof (item?.name ?? item?.filename) === 'string' ? (item.name ?? item.filename) : undefined);
    if (filename) attachment.filename = filename;
    const size = item?.size;
    if (typeof size === 'number' && Number.isFinite(size)) attachment.size = size;
    out.push(attachment);
  }
  return out;
}

/** How many images may be sent to the model for one reply. */
export const MAX_IMAGES_PER_REPLY = 4;

/**
 * How far back in the window images are collected from.
 *
 * The window is 15 messages. Collecting across all of them means one guest's
 * photo turns EVERY subsequent reply in that channel into a paid multi-image
 * call until it scrolls out — and re-sends their picture to a third party each
 * time. What the owner actually asked to be seen is the thing just posted, so only
 * the newest few messages are considered.
 */
export const IMAGE_LOOKBACK_MESSAGES = 3;

/**
 * Collect the images the model should actually look at, NEWEST FIRST, capped.
 *
 * Newest-first matters: when a window carries more images than the cap, the
 * ones worth seeing are the ones that just arrived — the trigger — not the
 * oldest still in the 15-message window. The cap bounds both token cost and
 * latency on a reply path that already has a 30s per-model timeout.
 */
export function collectImages(
  messages: Array<{ attachments?: MessageAttachment[]; timestampMs?: number }>,
  max: number = MAX_IMAGES_PER_REPLY,
  lookback: number = IMAGE_LOOKBACK_MESSAGES,
): MessageAttachment[] {
  if (max <= 0) return [];
  const images: MessageAttachment[] = [];
  const seen = new Set<string>();
  const oldestIndex = Math.max(0, messages.length - Math.max(1, lookback));
  for (let i = messages.length - 1; i >= oldestIndex; i -= 1) {
    for (const attachment of messages[i]?.attachments ?? []) {
      if (!isImageAttachment(attachment)) continue;
      if (seen.has(attachment.url)) continue;
      seen.add(attachment.url);
      images.push(attachment);
      if (images.length >= max) return images;
    }
  }
  return images;
}
