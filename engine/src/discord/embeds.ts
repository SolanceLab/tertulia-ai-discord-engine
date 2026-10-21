// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Embeds for the Discord tools: read them as plain objects, check what the caller
 * sends, and turn it into what discord.js wants.
 *
 * The plain shape is the same going out and coming in, so a caller can read an embed,
 * change one thing and send the whole embed back:
 *   { title, description, url, color: '#rrggbb', fields: [{ name, value, inline }],
 *     footer: { text, icon_url }, author: { name, url, icon_url }, image_url, thumbnail_url, timestamp }
 * Discord's proxy copies (proxy_icon_url, image_proxy_url, thumbnail_proxy_url) are read-only:
 * they come back on reads and are ignored when sending.
 * Empty keys are left out.
 */

export interface PlainEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: string | number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string; icon_url?: string; proxy_icon_url?: string };
  author?: { name: string; url?: string; icon_url?: string; proxy_icon_url?: string };
  image_url?: string;
  image_proxy_url?: string;
  thumbnail_url?: string;
  thumbnail_proxy_url?: string;
  timestamp?: string;
}

/** Structural view of a discord.js Embed; a plain object satisfies it too. */
export interface EmbedLike {
  title?: string | null;
  description?: string | null;
  url?: string | null;
  color?: number | null;
  fields?: ReadonlyArray<{ name: string; value: string; inline?: boolean | null }> | null;
  // discord.js Embed objects use camelCase (iconURL); raw API objects use snake_case (icon_url). Both are read.
  footer?: { text?: string | null; icon_url?: string | null; proxy_icon_url?: string | null; iconURL?: string | null; proxyIconURL?: string | null } | null;
  author?: { name?: string | null; url?: string | null; icon_url?: string | null; proxy_icon_url?: string | null; iconURL?: string | null; proxyIconURL?: string | null } | null;
  image?: { url?: string | null; proxy_url?: string | null; proxyURL?: string | null } | null;
  thumbnail?: { url?: string | null; proxy_url?: string | null; proxyURL?: string | null } | null;
  timestamp?: string | null;
}

export const EMBED_LIMITS = {
  embeds: 10,
  title: 256,
  description: 4096,
  fields: 25,
  fieldName: 256,
  fieldValue: 1024,
  footer: 2048,
  authorName: 256,
  total: 6000,
} as const;

/** discord.js Embed (or API embed) -> plain object, empty keys omitted. */
export function embedToPlain(e: EmbedLike): PlainEmbed {
  const out: PlainEmbed = {};
  if (e.title) out.title = e.title;
  if (e.description) out.description = e.description;
  if (e.url) out.url = e.url;
  if (typeof e.color === 'number') out.color = '#' + e.color.toString(16).padStart(6, '0');
  if (e.fields && e.fields.length > 0) {
    out.fields = e.fields.map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) }));
  }
  if (e.footer?.text) {
    out.footer = { text: e.footer.text };
    const icon = e.footer.icon_url || e.footer.iconURL;
    const proxy = e.footer.proxy_icon_url || e.footer.proxyIconURL;
    if (icon) out.footer.icon_url = icon;
    if (proxy) out.footer.proxy_icon_url = proxy;
  }
  if (e.author?.name) {
    out.author = { name: e.author.name };
    if (e.author.url) out.author.url = e.author.url;
    const icon = e.author.icon_url || e.author.iconURL;
    const proxy = e.author.proxy_icon_url || e.author.proxyIconURL;
    if (icon) out.author.icon_url = icon;
    if (proxy) out.author.proxy_icon_url = proxy;
  }
  if (e.image?.url) out.image_url = e.image.url;
  const imageProxy = e.image?.proxy_url || e.image?.proxyURL;
  if (imageProxy) out.image_proxy_url = imageProxy;
  if (e.thumbnail?.url) out.thumbnail_url = e.thumbnail.url;
  const thumbProxy = e.thumbnail?.proxy_url || e.thumbnail?.proxyURL;
  if (thumbProxy) out.thumbnail_proxy_url = thumbProxy;
  if (e.timestamp) out.timestamp = e.timestamp;
  return out;
}

/** A message's embeds as plain objects; [] when it has none. */
export function embedsOf(msg: { embeds?: ReadonlyArray<EmbedLike> | null }): PlainEmbed[] {
  return (msg.embeds ?? []).map(embedToPlain);
}

function parseColor(c: unknown): number | null {
  if (typeof c === 'number') return Number.isInteger(c) && c >= 0 && c <= 0xffffff ? c : null;
  if (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) return parseInt(c.slice(1), 16);
  return null;
}

function httpUrl(u: unknown): boolean {
  if (typeof u !== 'string') return false;
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/** Plain-text error for the first problem found, or null when the embeds can be sent. */
export function validateEmbeds(embeds: unknown): string | null {
  if (!Array.isArray(embeds)) return 'embeds must be an array (use [] to remove every embed).';
  if (embeds.length > EMBED_LIMITS.embeds) return `At most ${EMBED_LIMITS.embeds} embeds per message (got ${embeds.length}).`;
  for (let i = 0; i < embeds.length; i++) {
    const e = embeds[i];
    const at = `embeds[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return `${at} must be an object.`;
    let total = 0;
    const text = (v: unknown, label: string, max: number): string | null => {
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string') return `${at}.${label} must be text.`;
      if (v.length > max) return `${at}.${label} is ${v.length} characters; the limit is ${max}.`;
      total += v.length;
      return null;
    };
    const bad =
      text(e.title, 'title', EMBED_LIMITS.title) ??
      text(e.description, 'description', EMBED_LIMITS.description) ??
      text(e.footer?.text, 'footer.text', EMBED_LIMITS.footer) ??
      text(e.author?.name, 'author.name', EMBED_LIMITS.authorName);
    if (bad) return bad;
    if (e.footer !== undefined && e.footer !== null && typeof e.footer.text !== 'string') return `${at}.footer needs a text.`;
    if (e.author !== undefined && e.author !== null && typeof e.author.name !== 'string') return `${at}.author needs a name.`;
    if (e.fields !== undefined && e.fields !== null) {
      if (!Array.isArray(e.fields)) return `${at}.fields must be an array.`;
      if (e.fields.length > EMBED_LIMITS.fields) return `${at} has ${e.fields.length} fields; the limit is ${EMBED_LIMITS.fields}.`;
      for (let j = 0; j < e.fields.length; j++) {
        const f = e.fields[j];
        if (!f || typeof f.name !== 'string' || typeof f.value !== 'string') return `${at}.fields[${j}] needs a name and a value, both text.`;
        if (f.name.trim() === '' || f.value.trim() === '') return `${at}.fields[${j}] needs a non-empty name and a non-empty value.`;
        if (f.inline !== undefined && f.inline !== null && typeof f.inline !== 'boolean') return `${at}.fields[${j}].inline must be true or false.`;
        const fb = text(f.name, `fields[${j}].name`, EMBED_LIMITS.fieldName) ?? text(f.value, `fields[${j}].value`, EMBED_LIMITS.fieldValue);
        if (fb) return fb;
      }
    }
    if (e.color !== undefined && e.color !== null && parseColor(e.color) === null) {
      return `${at}.color must be a hex string like #c9a24b, or an integer from 0 to 16777215.`;
    }
    for (const [label, v] of [['url', e.url], ['author.url', e.author?.url], ['author.icon_url', e.author?.icon_url], ['footer.icon_url', e.footer?.icon_url], ['image_url', e.image_url], ['thumbnail_url', e.thumbnail_url]] as const) {
      if (v !== undefined && v !== null && !httpUrl(v)) return `${at}.${label} must be an http or https address.`;
    }
    if (e.timestamp !== undefined && e.timestamp !== null && (typeof e.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp)))) {
      return `${at}.timestamp must be an ISO date such as 2026-10-21T12:00:00Z.`;
    }
    const renderable =
      Boolean(e.title) || Boolean(e.description) || (Array.isArray(e.fields) && e.fields.length > 0) ||
      Boolean(e.image_url) || Boolean(e.thumbnail_url) || Boolean(e.author?.name) || Boolean(e.footer?.text);
    if (!renderable) return `${at} is empty; give it at least one of title, description, fields, image_url, thumbnail_url, author or footer.`;
    if (total > EMBED_LIMITS.total) return `${at} is ${total} characters in all; Discord allows ${EMBED_LIMITS.total} per message.`;
  }
  const all = embeds.reduce((n: number, e: any) => {
    let t = (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.author?.name?.length ?? 0);
    for (const f of e.fields ?? []) t += f.name.length + f.value.length;
    return n + t;
  }, 0);
  if (all > EMBED_LIMITS.total) return `The embeds hold ${all} characters in all; Discord allows ${EMBED_LIMITS.total} per message.`;
  return null;
}

/** Validated plain embeds -> the API shape discord.js sends. */
export function embedsToApi(embeds: PlainEmbed[]): any[] {
  return embeds.map((e) => {
    const o: any = {};
    if (e.title) o.title = e.title;
    if (e.description) o.description = e.description;
    if (e.url) o.url = e.url;
    const color = e.color === undefined ? null : parseColor(e.color);
    if (color !== null) o.color = color;
    if (e.fields && e.fields.length > 0) o.fields = e.fields.map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) }));
    if (e.footer?.text) o.footer = e.footer.icon_url ? { text: e.footer.text, icon_url: e.footer.icon_url } : { text: e.footer.text };
    if (e.author?.name) {
      o.author = { name: e.author.name };
      if (e.author.url) o.author.url = e.author.url;
      if (e.author.icon_url) o.author.icon_url = e.author.icon_url;
    }
    if (e.image_url) o.image = { url: e.image_url };
    if (e.thumbnail_url) o.thumbnail = { url: e.thumbnail_url };
    if (e.timestamp) o.timestamp = new Date(e.timestamp).toISOString();
    return o;
  });
}

/** Text block for the Mac server's read output. */
export function embedsText(embeds: PlainEmbed[]): string {
  return embeds.length ? `\n[Embeds] ${JSON.stringify(embeds)}` : '';
}
