// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Guards the public MCP surface: every tool's name + inputSchema must match the stored snapshot.
// Offline: registers the real tools on a real McpServer and lists them over an in-memory transport.
// Regenerate on purpose with: UPDATE_SNAPSHOT=1 node --test test/tools-list-schema.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const SNAP = new URL("./fixtures/tools-list.snapshot.json", import.meta.url).pathname;
const out = await build({
  stdin: {
    contents: `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "./src/tools.ts";
export async function listAll() {
  const server = new McpServer({ name: "discord", version: "1.0.0" });
  registerTools(server, { BOT_API_URL: "https://bot.test", BOT_API_SECRET: "test-only" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "snap", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => ({ name: t.name, inputSchema: t.inputSchema })).sort((x, y) => x.name.localeCompare(y.name));
}
export async function callBad(name, args) {
  const server = new McpServer({ name: "discord", version: "1.0.0" });
  registerTools(server, { BOT_API_URL: "https://bot.test", BOT_API_SECRET: "test-only" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "snap", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  let r;
  try { r = await client.callTool({ name, arguments: args }); } catch (e) { r = { threw: true }; }
  await client.close();
  return r.threw || r.isError === true;
}
`,
    resolveDir: new URL("..", import.meta.url).pathname,
    loader: "ts",
  },
  bundle: true, format: "esm", write: false, platform: "node", logLevel: "silent",
});
const mod = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

// The snapshot was captured under zod 3 (zod-to-json-schema). zod 4's converter words two things
// differently without changing what is accepted; strip those from both sides so every real
// difference (name, property, type, enum, default, bound, description, required) still fails:
//  - additionalProperties:false on plain objects  - the +/- MAX_SAFE_INTEGER bounds zod 4 adds to .int()
function normalise(node) {
  if (Array.isArray(node)) return node.map(normalise);
  if (node && typeof node === "object") {
    const o = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "additionalProperties" && v === false) continue;
      if ((k === "minimum" && v === -Number.MAX_SAFE_INTEGER) || (k === "maximum" && v === Number.MAX_SAFE_INTEGER)) continue;
      o[k] = normalise(v);
    }
    return o;
  }
  return node;
}

test("tools/list names and inputSchemas match the snapshot", async () => {
  const actual = await mod.listAll();
  if (process.env.UPDATE_SNAPSHOT) { await writeFile(SNAP, JSON.stringify(actual, null, 2) + "\n"); return; }
  assert.deepEqual(normalise(actual), normalise(JSON.parse(await readFile(SNAP, "utf8"))));
});

test("a call with a wrong-typed argument is rejected, not forwarded", async () => {
  assert.equal(await mod.callBad("discord_read_messages", { channel_id: 123 }), true);
});
