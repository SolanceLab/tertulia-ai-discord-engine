// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * profile-edit.ts — the one place the bot's display picture, banner and server bio are read and changed.
 * The bot-secret routes behind the profile tools and the Mac server's direct mode both call these,
 * so a refusal reads the same everywhere. Images arrive as data URIs only: a URL is never fetched.
 * No server_id = the whole account (PATCH /users/@me); a server_id = that server's profile only
 * (PATCH /guilds/{id}/members/@me). null clears a field.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024; // decoded size cap
// Base64 grows 4/3, and avatar + banner can travel in one request: the JSON body limit for the profile route must cover both.
export const PROFILE_BODY_LIMIT_BYTES = 24 * 1024 * 1024;
export const BIO_MAX = 190; // Discord's limit for a server bio

export class ProfileEditError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

/** The two REST calls this file needs; discord.js's REST satisfies it, tests pass a fake. */
export interface ProfileRest {
  get(route: string): Promise<any>;
  patch(route: string, options: { body: Record<string, unknown> }): Promise<any>;
}

export interface ProfileInput { avatar?: unknown; banner?: unknown; bio?: unknown; server_id?: unknown }
export interface ProfilePatch { server_id: string | null; body: Record<string, string | null> }

const DATA_URI = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/** The image type the first bytes say it is, or null. */
export function sniffImage(b: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  const at = (i: number, s: string) => [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (b.length > 3 && b[0] === 0x89 && at(1, 'PNG')) return 'png';
  if (b.length > 2 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (at(0, 'GIF8')) return 'gif';
  if (b.length > 11 && at(0, 'RIFF') && at(8, 'WEBP')) return 'webp';
  return null;
}

/** One image field: null clears; otherwise a png/jpeg/gif/webp data URI under the size cap whose bytes match its type. */
export function cleanImage(input: unknown, field: string): string | null {
  if (input === null) return null;
  if (typeof input !== 'string') throw new ProfileEditError(400, `${field} must be an image as a data URI (or null to clear it)`);
  const m = DATA_URI.exec(input.trim());
  if (!m) throw new ProfileEditError(400, `${field} must be a data URI for a png, jpeg, gif or webp image (data:image/png;base64,...); links are never fetched`);
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > IMAGE_MAX_BYTES) throw new ProfileEditError(400, `${field} is too large (max ${IMAGE_MAX_BYTES / 1024 / 1024} MB)`);
  if (sniffImage(bytes) !== m[1]) throw new ProfileEditError(400, `${field} is not really a ${m[1]} image`);
  return `data:image/${m[1]};base64,${m[2]}`;
}

export function cleanBio(input: unknown): string | null {
  if (input === null) return null;
  if (typeof input !== 'string') throw new ProfileEditError(400, 'bio must be text (or null to clear it)');
  const t = input.trim();
  if (t === '') return null;
  if ([...t].length > BIO_MAX) throw new ProfileEditError(400, `bio is too long (max ${BIO_MAX})`);
  return t;
}

function cleanServerId(sid: unknown): string | null {
  if (sid === undefined || sid === null || sid === '') return null;
  if (typeof sid !== 'string' || !/^\d{5,25}$/.test(sid)) throw new ProfileEditError(400, 'server_id must be a Discord server id');
  return sid;
}

/** Validate a request into what Discord is sent. Nothing leaves this function unchecked. */
export function buildPatch(input: ProfileInput): ProfilePatch {
  const sid = cleanServerId(input.server_id);
  const body: Record<string, string | null> = {};
  if (input.avatar !== undefined) body.avatar = cleanImage(input.avatar, 'avatar');
  if (input.banner !== undefined) body.banner = cleanImage(input.banner, 'banner');
  if (input.bio !== undefined) {
    if (!sid) throw new ProfileEditError(400, 'bio can only be set for one server: give server_id');
    body.bio = cleanBio(input.bio);
  }
  if (Object.keys(body).length === 0) throw new ProfileEditError(400, 'send at least one of avatar, banner or bio');
  return { server_id: sid, body };
}

/** A Discord refusal as a plain reason. */
export function plainReason(err: any): ProfileEditError {
  const status = Number(err?.status ?? err?.httpStatus ?? 0);
  const said = typeof err?.message === 'string' ? err.message : '';
  if (status === 429 || err?.name === 'RateLimitError') return new ProfileEditError(429, 'Discord is rate limiting profile changes (it allows only a few per hour); try again later');
  if (status === 400) return new ProfileEditError(400, `Discord refused the image or text: ${said || 'invalid form body'}`);
  if (status === 403) return new ProfileEditError(403, `Discord says this bot may not change that profile: ${said}`);
  if (status === 404) return new ProfileEditError(404, 'Discord does not know that server (the bot must be a member)');
  return new ProfileEditError(502, `Discord did not accept the change${said ? `: ${said}` : ''}`);
}

const imageUrl = (kind: 'avatars' | 'banners', id: string, hash: string | null | undefined, guildId?: string) => {
  if (!hash) return null;
  const path = guildId ? `guilds/${guildId}/users/${id}/${kind}` : `${kind}/${id}`;
  return `https://cdn.discordapp.com/${path}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}`;
};

/** Discord accepts a server bio but never returns it (checked live, 30 Oct), so `bio_sent` says what was sent and nothing claims to read one back. */
export interface ProfileView { server_id: string | null; avatar_url: string | null; banner_url: string | null; bio_sent?: string | null }

function view(raw: any, serverId: string | null): ProfileView {
  const user = serverId ? raw?.user : raw;
  return {
    server_id: serverId,
    avatar_url: imageUrl('avatars', user?.id, raw?.avatar, serverId ?? undefined),
    banner_url: imageUrl('banners', user?.id, raw?.banner, serverId ?? undefined),
  };
}

// Discord documents @me on /guilds/{id}/members/@me for PATCH only. The read /users/@me/guilds/{id}/member needs an OAuth2 bearer token,
// not a bot token, so a server read asks for the bot's own id first and then GET /guilds/{id}/members/{botUserId}.
const writeRoute = (sid: string | null) => (sid ? `/guilds/${sid}/members/@me` : '/users/@me');

export async function readProfile(rest: ProfileRest, serverId?: unknown): Promise<ProfileView> {
  const sid = cleanServerId(serverId);
  try {
    if (!sid) return view(await rest.get('/users/@me'), null);
    const me = await rest.get('/users/@me');
    return view(await rest.get(`/guilds/${sid}/members/${me?.id}`), sid);
  } catch (err) { throw plainReason(err); }
}

export async function setProfile(rest: ProfileRest, input: ProfileInput): Promise<ProfileView> {
  const { server_id, body } = buildPatch(input);
  try {
    const out = view(await rest.patch(writeRoute(server_id), { body }), server_id);
    if ('bio' in body) out.bio_sent = body.bio as string | null;
    return out;
  } catch (err) { throw plainReason(err); }
}

/** A refusal from the local file reader that is safe to show the caller as it is. */
export class LocalFileRefusal extends Error {}

/**
 * The only way a profile tool reads a local path. Reads are OFF unless PROFILE_FILES_DIR names a folder.
 * With a folder set: the folder and the requested path are both resolved with realpath, the resolved path must be the
 * folder or sit under it (so a symlink that leaves the folder is refused), it must be a regular file, the file is
 * opened once, its size is taken from that open handle and refused above the image cap before any byte is read,
 * and the bytes are read from that same handle.
 * Trust assumption: the folder is owned and writable only by the operator. This does not defend against a hostile writer in it.
 */
export async function readConfinedFile(requested: string, dir: string | undefined = process.env.PROFILE_FILES_DIR): Promise<Buffer> {
  if (!dir || !dir.trim()) throw new LocalFileRefusal('Local file reads are off. Send the image as base64 or a data URI, or ask the operator to set PROFILE_FILES_DIR to a folder for profile images.');
  let root: string;
  let real: string;
  try {
    root = await fs.realpath(dir);
    real = await fs.realpath(path.resolve(root, requested));
  } catch { throw new LocalFileRefusal('That file was not found in the profile images folder.'); }
  if (real !== root && !real.startsWith(root + path.sep)) throw new LocalFileRefusal('That path is outside the profile images folder.');
  const handle = await fs.open(real, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new LocalFileRefusal('That path is not a regular file.');
    if (st.size > IMAGE_MAX_BYTES) throw new LocalFileRefusal(`That file is too large (max ${IMAGE_MAX_BYTES / 1024 / 1024} MB).`);
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const { bytesRead } = await handle.read(buf, off, st.size - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    return buf.subarray(0, off);
  } finally { await handle.close(); }
}

/**
 * Turn avatar_path / banner_path into avatar_base64 / banner_base64 by reading the local file.
 * The bytes stay inside this process. Returns the arguments to post, or a plain refusal.
 */
export async function withLocalImages(
  args: Record<string, unknown>,
  read: (path: string) => Promise<Buffer>,
): Promise<{ args: Record<string, unknown> } | { refusal: string }> {
  const out = { ...args };
  for (const f of ['avatar', 'banner'] as const) {
    const p = out[`${f}_path`];
    delete out[`${f}_path`];
    if (p === undefined || p === null || p === '') continue;
    if (out[`${f}_base64`] !== undefined) return { refusal: `Give ${f}_path or ${f}_base64, not both.` };
    let buf: Buffer;
    try { buf = await read(String(p)); } catch (err) {
      return { refusal: err instanceof LocalFileRefusal ? err.message : `Could not read the ${f} file: ${p}` };
    }
    if (buf.length > IMAGE_MAX_BYTES) return { refusal: `The ${f} file is too large (max ${IMAGE_MAX_BYTES / 1024 / 1024} MB).` };
    out[`${f}_base64`] = buf.toString('base64');
  }
  return { args: out };
}
