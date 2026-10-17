// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/mcp-structure.test.ts */
import './test-env.js';
import { TOOLS } from './mcp/tool-definitions.js';
import { TOOL_TO_ENDPOINT } from './mcp/proxy.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

ok('42 tools', TOOLS.length === 42);
const names = TOOLS.map(t => t.name);
ok('unique names', new Set(names).size === names.length);
ok('every tool has a description', TOOLS.every(t => typeof t.description === 'string' && t.description.length > 0));
ok('every tool has an object inputSchema', TOOLS.every(t => (t.inputSchema as { type?: string })?.type === 'object'));

// Special cases handled outside the plain endpoint table
const SPECIAL = new Set(['check_mentions', 'check_dms', 'fetch_attachment', 'send_file', 'view_attachment'].map(n => `discord_${n}`));
const unmapped = names.filter(n => !TOOL_TO_ENDPOINT[n] && !SPECIAL.has(n));
ok(`every tool has an endpoint or documented special case${unmapped.length ? ' (missing: ' + unmapped.join(', ') + ')' : ''}`, unmapped.length === 0);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
