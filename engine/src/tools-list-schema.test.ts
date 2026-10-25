// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * Guards the public MCP surface: every tool's name + inputSchema must match the stored snapshot.
 * Two views: the Mac server's own list (TOOLS, JSON schema built from the shared zod shapes) and the
 * shared shapes registered on a real McpServer and listed over an in-memory transport. Offline, no Discord.
 * Run: npx tsx src/tools-list-schema.test.ts
 * Regenerate on purpose: UPDATE_SNAPSHOT=1 npx tsx src/tools-list-schema.test.ts
 */
import './test-env.js';
import { writeFileSync, readFileSync } from 'node:fs';
import { deepStrictEqual } from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { TOOLS } from './mcp/tool-definitions.js';
import { buildToolDefinitions } from './mcp/shared/definitions.js';

const SNAP = new URL('../test-fixtures/tools-list.snapshot.json', import.meta.url);

// The snapshot was captured under zod 3. zod 4's converter words two things differently without
// changing what is accepted; strip those from both sides so any real difference still fails:
//  - additionalProperties:false   - the +/- MAX_SAFE_INTEGER bounds zod 4 adds to .int()
function normalise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalise);
  if (node && typeof node === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'additionalProperties' && v === false) continue;
      if ((k === 'minimum' && v === -Number.MAX_SAFE_INTEGER) || (k === 'maximum' && v === Number.MAX_SAFE_INTEGER)) continue;
      o[k] = normalise(v);
    }
    return o;
  }
  return node;
}

async function listOverMcp() {
  const server = new McpServer({ name: 'discord', version: '1.0.0' });
  for (const d of buildToolDefinitions(z)) (server as any).tool(d.name, d.description, d.shape, async () => ({ content: [] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'snap', version: '1.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema })).sort((x, y) => x.name.localeCompare(y.name));
}

const actual = {
  macList: TOOLS.map((t) => ({ name: t.name, inputSchema: t.inputSchema })),
  viaMcpServer: await listOverMcp(),
};
if (process.env.UPDATE_SNAPSHOT) {
  writeFileSync(SNAP, JSON.stringify(actual, null, 2) + '\n');
  console.log('snapshot written');
  process.exit(0);
}
let failed = false;
try { deepStrictEqual(normalise(actual), normalise(JSON.parse(readFileSync(SNAP, 'utf8')))); console.log('  ok   tool names and inputSchemas match the snapshot'); }
catch (e) { failed = true; console.log('  FAIL tool schemas differ from the snapshot'); console.log(String((e as Error).message).slice(0, 1500)); }
console.log(`${actual.macList.length} tools snapshotted`);
process.exit(failed ? 1 : 0);
