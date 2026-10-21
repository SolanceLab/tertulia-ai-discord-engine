// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// The Worker's front door, end to end through the real MCP SDK (12 Oct outage:
// SDK 1.26+ refuses a reused stateless transport, and every tool call 500'd).
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const out = await build({ entryPoints: ["src/index.ts"], bundle: true, format: "esm", write: false, platform: "node" });
const worker = (await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"))).default;
const env = { API_KEY: "k", BOT_API_URL: "https://bot.test", BOT_API_SECRET: "s" };
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const call = (body, key = "k") => worker.fetch(new Request(`https://w.test/mcp/${key}`, { method: "POST", headers: H, body: JSON.stringify(body) }), env);

test("wrong key is refused", async () => {
  assert.equal((await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "nope")).status, 401);
});

test("initialize answers", async () => {
  const r = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).result.serverInfo);
});

test("tools/list without a prior initialize lists all 49 tools", async () => {
  const r = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).result.tools.length, 49);
});

test("tools/call reaches the bot, twice in a row (no transport reuse)", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(url); return new Response(JSON.stringify({ categories: [], uncategorized: [] })); };
  for (let i = 0; i < 2; i++) {
    const r = await call({ jsonrpc: "2.0", id: 3 + i, method: "tools/call", params: { name: "discord_list_channels", arguments: { server_id: "g" } } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.result.isError, undefined, JSON.stringify(j));
  }
  assert.deepEqual(seen, ["https://bot.test/api/list-channels", "https://bot.test/api/list-channels"]);
});
