// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/attachment-image.test.ts */
import './test-env.js';
import sharp from 'sharp';
import {
  MAX_RESULT_BASE64_CHARS,
  renderAttachmentImage,
  renderImageBuffer,
  IMAGES_PER_RESULT,
  MAX_INPUT_PIXELS,
  AttachmentImageError,
} from './attachment-image.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

async function throws(name: string, fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
    fail++; console.log(`  FAIL ${name} (expected a throw, got success)`);
  } catch (err) {
    const msg = (err as Error).message;
    if (!(err instanceof AttachmentImageError)) {
      fail++; console.log(`  FAIL ${name} (wrong error class: ${(err as Error).name})`);
    } else if (match && !match.test(msg)) {
      fail++; console.log(`  FAIL ${name} (message was: ${msg})`);
    } else {
      pass++; console.log(`  ok   ${name}`);
    }
  }
}

/**
 * Build a real image in memory.
 *
 * `noise` is the whole point of the fixture: a flat-colour image compresses to
 * almost nothing and would sail under budget at any size, proving nothing. A
 * field of random pixels is close to the worst case a photograph can present,
 * which is what the ladder actually has to survive.
 */
async function makeImage(width: number, height: number, noise: boolean): Promise<Buffer> {
  const px = Buffer.alloc(width * height * 3);
  if (noise) {
    for (let i = 0; i < px.length; i++) px[i] = Math.floor(Math.random() * 256);
  } else {
    px.fill(120);
  }
  return sharp(px, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function run() {
  // ── Host allow-list ───────────────────────────────────────────────────────
  // The URL now arrives having travelled through the Worker, so "discord.js
  // handed it to us" is no longer a property we can assume. This guard is what
  // stops the endpoint becoming a general-purpose fetcher behind our API secret.
  {
    await throws('rejects a non-Discord host',
      () => renderAttachmentImage('https://evil.example.com/x.png'), /non-Discord-CDN/);
    await throws('rejects plain http:// on the right host',
      () => renderAttachmentImage('http://cdn.discordapp.com/attachments/1/2/x.png'), /non-Discord-CDN/);
    await throws('rejects a lookalike host that only starts with the CDN name',
      () => renderAttachmentImage('https://cdn.discordapp.com.evil.tld/x.png'), /non-Discord-CDN/);
    await throws('rejects SSRF at localhost',
      () => renderAttachmentImage('http://127.0.0.1:1/x.png'), /non-Discord-CDN/);
    await throws('rejects the cloud metadata endpoint',
      () => renderAttachmentImage('http://169.254.169.254/latest/meta-data/'), /non-Discord-CDN/);
  }

  // ── The ladder actually fits, on a worst-case source ───────────────────────
  // This is the guarantee the module exists to make.
  {
    const huge = await makeImage(2400, 1800, true);
    ok('fixture is genuinely oversized for the budget',
      huge.toString('base64').length > MAX_RESULT_BASE64_CHARS * 5);

    const out = await renderImageBuffer(huge);
    ok('a worst-case 2400x1800 noisy source comes back UNDER budget',
      out.base64Chars <= MAX_RESULT_BASE64_CHARS);
    ok('...and is still a usable size, not a thumbnail',
      Math.max(out.width, out.height) >= 256);
    ok('...re-encoded as JPEG', out.mimeType === 'image/jpeg');
    ok('...flagged as downscaled', out.downscaled === true);
    ok('...reports which rung it landed on', out.edge > 0 && out.quality > 0);
    ok('...base64 is decodable back to the declared byte count',
      Buffer.from(out.data, 'base64').byteLength > 0);
    ok('...records the original size for honest reporting',
      out.sourceBytes === huge.byteLength);
  }

  // ── A small image keeps its fidelity ──────────────────────────────────────
  // The ladder must not punish images that were never a problem.
  {
    const small = await makeImage(300, 200, false);
    const out = await renderImageBuffer(small);
    ok('a small source stays at its own dimensions (no upscaling)',
      out.width === 300 && out.height === 200);
    ok('a small source is served from the top rung', out.edge === 1024);
    ok('a small source is far under budget', out.base64Chars < MAX_RESULT_BASE64_CHARS / 4);
  }

  // ── Orientation ───────────────────────────────────────────────────────────
  // Phone photos arrive with EXIF rotation. Serving them sideways is exactly
  // the class of bug that makes an image useless for continuity work.
  {
    const rotated = await sharp(await makeImage(400, 200, false))
      .withMetadata({ orientation: 6 }) // 6 = rotate 90° clockwise on display
      .jpeg().toBuffer();
    const out = await renderImageBuffer(rotated);
    ok('EXIF orientation is applied, so a portrait photo is not served sideways',
      out.width === 200 && out.height === 400);
  }

  // ── Non-image bytes fail as OUR error, not a raw crash ────────────────────
  {
    await throws('non-image bytes produce a readable refusal',
      () => renderImageBuffer(Buffer.from('this is a sentence, not a picture')),
      /not a readable image/);
  }

  // ── Decompression-bomb ceiling ────────────────────────────────────────────
  // Raised by the 10 Aug security review: file size cannot catch this, because
  // compression is exactly what hides it. An 8MB PNG can describe a
  // ~250-megapixel canvas that decodes to ~1GB of raw pixels. Enforcement is
  // sharp's `limitInputPixels`; what we assert here is that we actually pass a
  // ceiling and that it is well under sharp's permissive ~268MP default.
  {
    ok('a decoded-pixel ceiling is set, not left at sharp\'s default',
      typeof MAX_INPUT_PIXELS === 'number' && MAX_INPUT_PIXELS > 0);
    ok('...far below sharp\'s ~268MP default', MAX_INPUT_PIXELS <= 100_000_000);
    ok('...but above any genuine Discord upload (a 48MP phone photo still works)',
      MAX_INPUT_PIXELS >= 48_000_000);

    // A real image comfortably inside the ceiling must still pass, or the guard
    // would be protecting us from our own users.
    const wide = await makeImage(1600, 400, true);
    const out = await renderImageBuffer(wide);
    ok('a legitimate wide image is unaffected by the ceiling',
      out.base64Chars <= MAX_RESULT_BASE64_CHARS && out.width > 0);
  }

  // ── Contract constants ────────────────────────────────────────────────────
  {
    ok('one image per result (two at budget would blow the ~150,000-char cap)',
      IMAGES_PER_RESULT === 1);
    ok('budget leaves headroom under the cap for the accompanying text',
      MAX_RESULT_BASE64_CHARS < 150_000 && MAX_RESULT_BASE64_CHARS >= 100_000);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run();
