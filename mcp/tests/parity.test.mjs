// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Run from modules/discord: node --test mcp/tests/  (npm test does; needs bot/ and mcp/worker/ installed)
//
// Parity between the two Discord MCP servers and the bot they both call.
// On 12 Oct 2026 the cloud connector's send_file and get_user_info had been
// posting bodies the bot's routes rejected, for weeks. The route check below is
// the one that would have caught it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const moduleDir = join(here, '..', '..');
// The engine lives in bot/ in the House module and in engine/ in the public release.
const botDir = existsSync(join(moduleDir, 'bot')) ? join(moduleDir, 'bot') : join(moduleDir, 'engine');
const workerDir = join(moduleDir, 'mcp', 'worker');
const { build } = createRequire(join(workerDir, 'package.json'))('esbuild');

async function bundle(contents, resolveDir) {
  const out = await build({
    stdin: { contents, resolveDir, loader: 'ts', sourcefile: 'entry.ts' },
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
  });
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
}

// The Mac server's list, built from bot/src exactly as the bot builds it.
const local = await bundle(`
  export { TOOLS, DEFINITIONS } from './src/mcp/tool-definitions.ts';
  export { TOOL_TO_ENDPOINT } from './src/mcp/proxy.ts';
  export { TOOL_NAMES, bodyFor } from '../mcp/definitions.ts';
`, botDir);

// The cloud connector's list, as a real MCP client sees it over tools/list.
const cloud = await bundle(`
  export { registerTools } from './src/tools.ts';
  export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
  export { Client } from '@modelcontextprotocol/sdk/client/index.js';
  export { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
`, workerDir);

const server = new cloud.McpServer({ name: 'parity', version: '0' });
cloud.registerTools(server, { BOT_API_URL: 'https://bot.test', BOT_API_SECRET: 'x', API_KEY: 'x' });
const [serverSide, clientSide] = cloud.InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new cloud.Client({ name: 'parity', version: '0' });
await client.connect(clientSide);
const cloudTools = (await client.listTools()).tools;
await client.close();

const localTools = local.TOOLS;
const defs = local.DEFINITIONS;

/** Strip converter noise that neither side controls the meaning of. */
function norm(node) {
  if (Array.isArray(node)) return node.map(norm);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema' || k === 'additionalProperties') continue;
      out[k] = norm(v);
    }
    return out;
  }
  return node;
}

function withoutKeys(schema, keys) {
  const s = norm(schema);
  const properties = { ...(s.properties ?? {}) };
  for (const k of keys) delete properties[k];
  return { type: s.type, properties, required: (s.required ?? []).filter((k) => !keys.includes(k)) };
}

test('exactly the 49 frozen names, in the same order, in both servers', () => {
  assert.equal(local.TOOL_NAMES.length, 49);
  assert.ok(Object.isFrozen(local.TOOL_NAMES));
  assert.deepEqual(defs.map((d) => d.name), [...local.TOOL_NAMES]);
  assert.deepEqual(localTools.map((t) => t.name), [...local.TOOL_NAMES]);
  assert.deepEqual(cloudTools.map((t) => t.name), [...local.TOOL_NAMES]);
});

test('same description in both servers', () => {
  for (let i = 0; i < 49; i++) {
    assert.equal(cloudTools[i].description, localTools[i].description, cloudTools[i].name);
  }
});

test('cloud schema = local schema minus the Mac-only fields', () => {
  for (const def of defs) {
    const c = cloudTools.find((t) => t.name === def.name);
    const l = localTools.find((t) => t.name === def.name);
    const macOnly = Object.keys(def.localShape ?? {});
    assert.deepEqual(withoutKeys(c.inputSchema, macOnly), withoutKeys(l.inputSchema, macOnly), def.name);
    for (const k of macOnly) {
      assert.ok(k in l.inputSchema.properties, `${def.name}.${k} listed on the Mac`);
      if (!(k in def.shape)) assert.ok(!(k in (c.inputSchema.properties ?? {})), `${def.name}.${k} not offered in the cloud`);
    }
  }
});

test('no double quotes in any description (ChatGPT drops such parameters)', () => {
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, where));
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (k === 'description') assert.ok(!String(v).includes('"'), `${where}: ${v}`);
        walk(v, `${where}.${k}`);
      }
    }
  };
  for (const t of [...cloudTools, ...localTools]) {
    assert.ok(!t.description.includes('"'), t.name);
    walk(t.inputSchema, t.name);
  }
});

// ---- the bot's routes, read statically from http-server.ts
const httpSrc = readFileSync(join(botDir, 'src', 'http-server.ts'), 'utf8');
const routes = new Map();
{
  const parts = httpSrc.split(/app\.(?:post|get)\('/).slice(1);
  for (const part of parts) {
    const path = part.slice(0, part.indexOf("'"));
    const keys = new Set();
    for (const m of part.matchAll(/const\s*\{([^}]*)\}\s*=\s*req\.body/g)) {
      for (const piece of m[1].split(',')) {
        const name = piece.split('=')[0].split(':')[0].trim();
        if (name) keys.add(name);
      }
    }
    for (const m of part.matchAll(/req\.body\??\.(\w+)/g)) keys.add(m[1]);
    // the route's own guard: the first `if (...)` naming body keys as !key or key === undefined
    const required = new Set();
    const guard = part.match(/if\s*\(([^\n]*)\)\s*\{\s*\n\s*res\.status\(400\)/);
    if (guard) {
      for (const m of guard[1].matchAll(/!\s*(\w+)\b(?!\s*\.)|(\w+)\s*===\s*undefined/g)) {
        const k = m[1] ?? m[2];
        if (keys.has(k)) required.add(k);
      }
    }
    routes.set(path, { keys, required });
  }
}

test('the route extractor reads the bot (sanity)', () => {
  assert.ok(routes.size >= 35, `found ${routes.size} routes`);
  assert.deepEqual([...routes.get('/api/send-file').keys].sort(), ['channel_id', 'content', 'file_data', 'file_name']);
  assert.deepEqual([...routes.get('/api/get-user-info').required].sort(), ['server_id', 'user_id']);
});

test('every endpoint is a real bot route, and every body key it sends is one the route reads', () => {
  for (const def of defs) {
    if (def.endpoint === null) continue;
    const route = routes.get(def.endpoint);
    assert.ok(route, `${def.name}: no app.post('${def.endpoint}') in http-server.ts`);
    const sample = Object.fromEntries(Object.keys(def.shape).map((k) => [k, 'x']));
    for (const k of Object.keys(local.bodyFor(def, sample))) {
      assert.ok(route.keys.has(k), `${def.name} sends ${k}, which ${def.endpoint} never reads`);
    }
  }
});

// Keys a route reads that are deliberately not tool inputs: path -> { key: reason }.
const NOT_TOOL_INPUTS = {};

test('every key a route reads is one its tool offers (shape + localShape)', () => {
  for (const def of defs) {
    if (def.endpoint === null) continue;
    const sample = Object.fromEntries(Object.keys(def.shape).map((k) => [k, 'x']));
    const offered = new Set([...Object.keys(local.bodyFor(def, sample)), ...Object.keys(def.shape), ...Object.keys(def.localShape ?? {})]);
    const internal = NOT_TOOL_INPUTS[def.endpoint] ?? {};
    for (const k of routes.get(def.endpoint).keys) {
      if (k in internal) continue;
      assert.ok(offered.has(k), `${def.name}: ${def.endpoint} reads ${k}, the tool does not offer it`);
    }
  }
});

test('every either/or guard in a route has a check on its tool', () => {
  // a 400 guard that joins negations with && ("neither x nor y") is an either/or requirement
  const found = [];
  for (const part of httpSrc.split(/app\.(?:post|get)\('/).slice(1)) {
    const path = part.slice(0, part.indexOf("'"));
    for (const m of part.matchAll(/if\s*\(([^\n]*)\)\s*\{\s*\n\s*res\.status\(400\)/g)) {
      const either = m[1].match(/!\s*\w+(?:\s*&&\s*!\s*\w+)+|\(\s*!\w+\s*&&\s*!\w+/);
      if (either) found.push(path);
    }
  }
  assert.deepEqual([...new Set(found)].sort(), ['/api/search-messages', '/api/send-message']);
  for (const path of new Set(found)) {
    const def = defs.find((d) => d.endpoint === path);
    assert.equal(typeof def.check, 'function', `${path} has an either/or guard but ${def.name} has no check`);
  }
});

test('every field a route requires is a required field of its tool', () => {
  for (const def of defs) {
    if (def.endpoint === null) continue;
    for (const k of routes.get(def.endpoint).required) {
      assert.ok(k in def.shape, `${def.name}: ${def.endpoint} requires ${k}, the tool does not offer it`);
      assert.ok(!def.shape[k].isOptional(), `${def.name}: ${def.endpoint} requires ${k}, the tool makes it optional`);
    }
  }
});

test('the Mac proxy posts each tool to its definition route', () => {
  for (const def of defs) {
    assert.equal(local.TOOL_TO_ENDPOINT[def.name], def.endpoint ?? undefined, def.name);
  }
});

test("the bot's generated copy matches the source (sync-shared.mjs)", () => {
  const source = readFileSync(join(moduleDir, 'mcp', 'definitions.ts'), 'utf8');
  const copy = readFileSync(join(botDir, 'src', 'mcp', 'shared', 'definitions.ts'), 'utf8');
  const nl = copy.indexOf('\n');
  assert.match(copy.slice(0, nl), /^\/\/ GENERATED — edit modules\/discord\/mcp\/definitions\.ts/);
  assert.equal(copy.slice(nl + 1), source, 'stale copy: run node bot/scripts/sync-shared.mjs');
});
