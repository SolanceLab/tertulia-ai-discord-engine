// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Run from the repository root: node --test 'mcp/tests/*.test.mjs'
//
// The plugin installs in Codex: its manifest points at files that exist, the versions agree,
// and the server key comes from an environment variable, never from a value in the plugin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const plugin = join(root, "plugin");
const read = (p) => JSON.parse(readFileSync(join(plugin, p), "utf8"));

test("Codex manifest paths resolve from the plugin folder", () => {
  const m = read(".codex-plugin/plugin.json");
  assert.equal(m.name, "tertulia-ai-discord-engine");
  assert.match(m.skills, /^\.\//);
  assert.match(m.mcpServers, /^\.\//);
  assert.ok(existsSync(join(plugin, m.skills)), "skills folder");
  assert.ok(existsSync(join(plugin, m.mcpServers)), "server file");
  const skillDirs = readdirSync(join(plugin, m.skills));
  assert.ok(skillDirs.some((d) => existsSync(join(plugin, m.skills, d, "SKILL.md"))), "a SKILL.md");
});

test("Codex and Claude manifests carry the same version, equal to the newest changelog heading", () => {
  const codex = read(".codex-plugin/plugin.json").version;
  const claude = read(".claude-plugin/plugin.json").version;
  const top = /^## \[?(\d+\.\d+\.\d+)\]?/m.exec(readFileSync(join(root, "CHANGELOG.md"), "utf8"))[1];
  assert.equal(codex, claude);
  assert.equal(codex, top);
});

test("Codex server file reads the key from an environment variable and holds no secret", () => {
  const raw = readFileSync(join(plugin, read(".codex-plugin/plugin.json").mcpServers), "utf8");
  const servers = JSON.parse(raw).mcpServers;
  const names = Object.keys(servers);
  assert.ok(names.length >= 1);
  for (const name of names) {
    const s = servers[name];
    assert.equal(typeof s.url, "string");
    assert.match(s.bearer_token_env_var, /^[A-Z_][A-Z0-9_]*$/);
    for (const k of Object.keys(s)) {
      assert.ok(["url", "bearer_token_env_var"].includes(k), `unexpected field ${k}`);
    }
    assert.ok(!/[?&](key|token|secret)=/i.test(s.url), "no key in the address");
  }
});
