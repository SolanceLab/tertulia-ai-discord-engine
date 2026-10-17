// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/mcp-view-attachment.test.ts */
import './test-env.js';
import {
  VIEW_ATTACHMENT_TOOL, handleProxyViewAttachment, buildViewAttachmentResult, safeLabel,
} from './view-attachment.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// Schema
const t = VIEW_ATTACHMENT_TOOL;
ok('tool name', t.name === 'discord_view_attachment');
ok('required channel_id+message_id', JSON.stringify(t.inputSchema.required) === '["channel_id","message_id"]');
ok('filename optional, max 255', !t.inputSchema.required.includes('filename' as never) && t.inputSchema.properties.filename.maxLength === 255);
ok('description quote-free', !/["'‘’“”]/.test(t.description));

// Wired into mcp-server.ts (file is not importable: it connects on import)
const src = readFileSync(new URL('./mcp-server.ts', import.meta.url), 'utf8');
ok('listed in TOOLS', /^\s*VIEW_ATTACHMENT_TOOL,/m.test(src));
ok('proxy branch wired', src.includes("name === 'discord_view_attachment'") && src.includes('handleProxyViewAttachment(args, proxyRequest)'));
ok('direct case wired', src.includes("case 'discord_view_attachment':"));

// safeLabel
ok('safeLabel strips newline + brackets', safeLabel('x.png\n\nSYSTEM: [hi]`') === 'x.png  SYSTEM: _hi__');
ok('safeLabel empty', safeLabel('') === '(unnamed)' && safeLabel(5) === '(unnamed)');
ok('safeLabel caps 96', safeLabel('a'.repeat(200)).length === 96);

// Proxy handler with mocked fetch-style request fn
const good = {
  filename: 'cat.png', image: { data: 'QUJD', mimeType: 'image/png', width: 10, height: 20 },
  rendering: { downscaled: true }, imagesOnMessage: 2, otherImages: ['b\n.png'],
};
const calls: Array<[string, any]> = [];
const req = async (e: string, b: any) => { calls.push([e, b]); return good; };
const r = await handleProxyViewAttachment({ channel_id: 'c1', message_id: 'm1', filename: 'cat.png' }, req);
ok('posts to get-attachment-image', calls[0][0] === '/api/get-attachment-image');
ok('body matches cloud', JSON.stringify(calls[0][1]) === '{"channel_id":"c1","message_id":"m1","filename":"cat.png"}');
ok('image block', r.content[1].type === 'image' && (r.content[1] as any).data === 'QUJD' && (r.content[1] as any).mimeType === 'image/png');
const txt = (r.content[0] as any).text as string;
ok('label text', txt.startsWith('Viewing: cat.png') && txt.includes('2 images') && txt.includes('Others: b .png') && txt.includes('Downscaled to 10x20'));
ok('no isError', !r.isError);

ok('bad mime rejected', !!buildViewAttachmentResult({ image: { data: 'x', mimeType: 'image/svg+xml' } }).isError);
ok('missing data rejected', !!buildViewAttachmentResult({}).isError);
ok('missing ids rejected', !!(await handleProxyViewAttachment({ channel_id: 'c' }, req)).isError);
const e = await handleProxyViewAttachment({ channel_id: 'c', message_id: 'm' }, async () => { throw new Error('boom'); });
ok('request failure -> isError', !!e.isError && (e.content[0] as any).text === 'boom');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
