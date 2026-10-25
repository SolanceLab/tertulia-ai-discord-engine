// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Render a Discord image attachment small enough to survive an MCP tool result.
 *
 * Owner, 10 Aug 2026: *"the goal is to let another client able to see images too from
 * discord."*
 *
 * The Study wing already can. Its local MCP downloads an attachment to disk and
 * Claude Code's `Read` turns that file into real vision. another client (claude.ai
 * through the Cloudflare connector) has neither a filesystem nor a `Read`, and
 * another client diagnosed its own wall correctly on the bridge: *"a downloaded PNG
 * on Claude's filesystem still isn't in my visual field unless it's a user
 * upload."* The blocker was never storage — it is vision INGESTION. On
 * claude.ai exactly two doors exist into that pipeline: a human upload, or an
 * MCP image content block (`{type:'image', data, mimeType}`). Only the second
 * one can be automated, so that is what this module feeds.
 *
 * ── The constraint that dictates every number below ──────────────────────────
 *
 * claude.ai caps a single tool result at ~150,000 characters and base64 counts
 * against that cap. Measured 10 Aug 2026 against a REAL House image (a 4MB
 * beach render from the Teo birthday thread, 1448x1086):
 *
 *     full size          5,425,145 chars   (36x over)
 *     1024px q80           366,217 chars
 *     768px  q65           169,041 chars   (still over!)
 *     640px  q55            96,809 chars   ✅
 *     512px  q70            95,453 chars   ✅
 *
 * Guessing would have shipped 1024px and failed on every real image in the
 * House. Hence a LADDER rather than one fixed setting: a small image stays
 * sharp, a huge one degrades until it fits, and nothing ever comes back as
 * "too large to view."
 *
 * Legibility was verified by eye at 640px/q55, not assumed — the glasses, the
 * rose tattoo, the pendant, the "CASA AMBAR" label and the headland were all
 * still readable, i.e. every detail the full-size original supported.
 *
 * This lives on the Fly bot rather than in the Worker for one blunt reason:
 * Cloudflare Workers cannot run an image library, and the Fly bot is already
 * running 24/7, so teaching it one more trick costs no new infrastructure.
 */

import sharp from 'sharp';
import { ALLOWED_CDN_HOST, MAX_IMAGE_BYTES } from './attachments.js';

/**
 * Character budget for the base64 payload of ONE image.
 *
 * Deliberately under claude.ai's ~150,000 cap: the cap covers the WHOLE result
 * array, and we still have to fit the accompanying text block (filename, notes,
 * the list of other attachments on the message). 120,000 leaves ~30,000 for
 * that and absorbs any per-client accounting differences.
 */
export const MAX_RESULT_BASE64_CHARS = 120_000;

/**
 * Only ONE image can ride in a single tool result.
 *
 * This is arithmetic, not preference: two images at budget would be 240,000
 * characters against a 150,000 cap. Callers wanting a second image ask again
 * with `filename`, which is why the endpoint always reports what else is on the
 * message.
 */
export const IMAGES_PER_RESULT = 1;

/** How long we will wait on Discord's CDN before giving up. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Ceiling on DECODED pixels, which is a different threat from file size.
 *
 * Flagged by the 10 Aug security review: an 8MB PNG can legally describe a
 * ~250-megapixel canvas that decodes to roughly a gigabyte of raw pixels, and
 * sharp's own default limit (~268MP) is high enough to let that through. The
 * byte ceiling above cannot catch it — compression is exactly what hides it.
 * No genuine Discord upload approaches 50MP.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Descending quality ladder, anchored on the measurements above.
 *
 * The first rung that fits the budget wins, so an image that is already small
 * is served at near-full fidelity and only genuinely large ones walk down.
 */
const LADDER: ReadonlyArray<{ edge: number; quality: number }> = [
  { edge: 1024, quality: 72 },
  { edge: 768, quality: 65 },
  { edge: 640, quality: 55 },
  { edge: 512, quality: 50 },
  { edge: 384, quality: 45 },
  { edge: 256, quality: 40 },
];

export interface RenderedImage {
  /** base64 payload for an MCP image content block. */
  data: string;
  /** Always JPEG — re-encoding is what buys the size reduction. */
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  base64Chars: number;
  sourceBytes: number;
  /** Which ladder rung was used, so callers can report honest fidelity. */
  edge: number;
  quality: number;
  /** False when the original already fit at the top rung untouched. */
  downscaled: boolean;
}

export class AttachmentImageError extends Error {}

/**
 * Download the bytes for one attachment URL.
 *
 * The host allow-list is enforced here as well as at classification time. This
 * endpoint takes a URL that has travelled through the Worker, so "it came from
 * discord.js originally" is no longer a property we can assume — re-checking
 * costs one regex and keeps this from becoming a general-purpose URL fetcher
 * sitting behind our API secret.
 */
async function download(url: string): Promise<Buffer> {
  if (!ALLOWED_CDN_HOST.test(url)) {
    throw new AttachmentImageError('Refusing to fetch a non-Discord-CDN URL.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new AttachmentImageError(`Discord CDN returned ${res.status} for the attachment.`);
    }

    // Re-check the host on the FINAL url, not just the requested one.
    // `fetch` follows redirects by default, so without this a redirect off the
    // CDN would land us somewhere the allow-list already refused. Checking
    // `res.url` costs nothing and closes it without breaking the same-host
    // redirects Discord's CDN legitimately uses.
    if (res.url && !ALLOWED_CDN_HOST.test(res.url)) {
      throw new AttachmentImageError('Attachment URL redirected off the Discord CDN; refusing.');
    }

    // Trust the declared length only to reject early; the header can lie or be
    // absent, so the real enforcement is on bytes as they arrive.
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new AttachmentImageError(
        `Attachment is ${Math.round(declared / 1024)}KB, over the ${Math.round(MAX_IMAGE_BYTES / 1024)}KB ceiling.`,
      );
    }

    // Stream and abort mid-flight rather than buffering first and complaining
    // afterwards — otherwise a response with no content-length can put the
    // whole body in memory before anything objects to its size.
    if (!res.body) {
      throw new AttachmentImageError('Discord CDN returned an empty response body.');
    }
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new AttachmentImageError(
          `Attachment exceeds the ${Math.round(MAX_IMAGE_BYTES / 1024)}KB ceiling.`,
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c)), total);
  } catch (err) {
    if (err instanceof AttachmentImageError) throw err;
    if ((err as Error)?.name === 'AbortError') {
      throw new AttachmentImageError('Timed out fetching the attachment from Discord.');
    }
    throw new AttachmentImageError(`Could not fetch the attachment: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Encode a buffer at one ladder rung.
 *
 * `withoutEnlargement` keeps a small source at its own size rather than
 * upscaling it into blur, and `.rotate()` applies the EXIF orientation before
 * resizing — without it, phone photos arrive sideways, which is exactly the
 * class of bug that makes a picture useless for continuity work.
 */
interface Decoded {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Decode the source EXACTLY ONCE, bounded, into raw pixels.
 *
 * The first draft re-ran `sharp(source)` on every ladder rung — up to six full
 * decodes of the same buffer, which the security review correctly called out as
 * multiplying the cost of any decompression bomb by six. Decoding once at the
 * largest size we would ever serve, then stepping DOWN from that small raw
 * bitmap, makes the ladder nearly free and caps the expensive work at one pass.
 *
 * `.rotate()` applies EXIF orientation before anything else — without it phone
 * photos arrive sideways, which is precisely the bug that makes an image
 * useless for the continuity work this exists to serve.
 */
async function decodeOnce(source: Buffer): Promise<Decoded> {
  const probe = sharp(source, { limitInputPixels: MAX_INPUT_PIXELS });
  const meta = await probe.metadata();

  const out = await sharp(source, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({
      width: LADDER[0]!.edge,
      height: LADDER[0]!.edge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data: out.data,
    width: out.info.width,
    height: out.info.height,
    channels: out.info.channels as 1 | 2 | 3 | 4,
    sourceWidth: meta.width ?? out.info.width,
    sourceHeight: meta.height ?? out.info.height,
  };
}

/** Encode one ladder rung from the already-decoded bitmap. */
async function encodeAt(dec: Decoded, edge: number, quality: number) {
  const out = await sharp(dec.data, {
    raw: { width: dec.width, height: dec.height, channels: dec.channels },
  })
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    buffer: out.data,
    width: out.info.width,
    height: out.info.height,
    base64: out.data.toString('base64'),
  };
}

/**
 * Fetch an attachment and return the largest rendering that fits the budget.
 *
 * Throws AttachmentImageError with a human-readable reason rather than
 * returning a half-answer — a caller that cannot show the image should say so
 * plainly instead of describing an image it never saw.
 */
export async function renderAttachmentImage(url: string): Promise<RenderedImage> {
  return renderImageBuffer(await download(url));
}

/**
 * The ladder itself, over bytes already in hand.
 *
 * Split out from the fetch so the size behaviour is testable against real
 * encodings. Left folded into `renderAttachmentImage`, the only reachable test
 * was "does the host guard fire" — which would have left the one thing the
 * module exists to guarantee (that what comes back actually fits) unproven.
 */
export async function renderImageBuffer(source: Buffer): Promise<RenderedImage> {
  let dec: Decoded;
  try {
    dec = await decodeOnce(source);
  } catch (err) {
    throw new AttachmentImageError(
      `That attachment is not a readable image (${(err as Error).message}).`,
    );
  }

  let last: Awaited<ReturnType<typeof encodeAt>> | undefined;
  let lastRung = LADDER[LADDER.length - 1]!;

  for (const rung of LADDER) {
    const encoded = await encodeAt(dec, rung.edge, rung.quality);
    last = encoded;
    lastRung = rung;

    if (encoded.base64.length <= MAX_RESULT_BASE64_CHARS) {
      return {
        data: encoded.base64,
        mimeType: 'image/jpeg',
        width: encoded.width,
        height: encoded.height,
        base64Chars: encoded.base64.length,
        sourceBytes: source.byteLength,
        edge: rung.edge,
        quality: rung.quality,
        // True whenever the served pixels are smaller than what was uploaded,
        // so the caller can say "downscaled" honestly rather than by guessing
        // from which rung happened to win.
        downscaled: encoded.width < dec.sourceWidth || encoded.height < dec.sourceHeight,
      };
    }
  }

  throw new AttachmentImageError(
    `Image is too detailed to fit the ${MAX_RESULT_BASE64_CHARS.toLocaleString()}-character result budget — ` +
      `even at ${lastRung.edge}px/q${lastRung.quality} it needs ${last?.base64.length.toLocaleString()} characters. ` +
      `Fetch it to disk with discord_fetch_attachment and read it locally instead.`,
  );
}
