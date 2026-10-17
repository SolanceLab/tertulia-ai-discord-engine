// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Run: npm test  (bundles src/tools.ts with esbuild, then runs node:test)
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { z } from "zod";

const out = await build({
  entryPoints: ["src/tools.ts"], bundle: true, format: "esm", write: false,
  platform: "node",
});
const mod = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

const tools = {};
mod.registerTools({ tool: (name, _d, shape, handler) => { tools[name] = { shape, handler }; } },
  { BOT_API_URL: "https://bot.test/", BOT_API_SECRET: "s3" });

test("send_file posts file_data and file_name", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ success: true, message_id: "1" })); };
  const r = await tools.discord_send_file.handler({ channel_id: "c1", file_name: "a.txt", file_data: "aGk=", content: "yo" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bot.test/api/send-file");
  assert.deepEqual(calls[0].body, { channel_id: "c1", file_data: "aGk=", file_name: "a.txt", content: "yo" });
  assert.equal(JSON.parse(r.content[0].text).success, true);
});

test("missing file_data or file_name is rejected by the schema (so no request is made)", () => {
  const schema = z.object(tools.discord_send_file.shape);
  assert.equal(schema.safeParse({ channel_id: "c", file_name: "a" }).success, false);
  assert.equal(schema.safeParse({ channel_id: "c", file_name: "a", file_data: "" }).success, false);
  assert.equal(schema.safeParse({ channel_id: "c", file_data: "aGk=" }).success, false);
  assert.equal(schema.safeParse({ channel_id: "c", file_name: "a", file_path: "/x" }).success, false);
  assert.equal(schema.safeParse({ channel_id: "c", file_name: "a", file_data: "aGk=" }).success, true);
});

test("description has no double quotes", () => {
  // description is the 2nd arg; re-register to capture it
  let desc; mod.registerTools({ tool: (n, d) => { if (n === "discord_send_file") desc = d; } }, { BOT_API_URL: "x", BOT_API_SECRET: "y" });
  assert.ok(!desc.includes('"'));
});
