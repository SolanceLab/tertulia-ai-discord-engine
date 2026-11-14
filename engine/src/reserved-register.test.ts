// Tertúlia — Copyright (c) 2026 House of Solance. PolyForm Noncommercial 1.0.0. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/** Run: npx tsx src/reserved-register.test.ts — reserved names match as whole words; the engine adds the boundaries. */
import './test-env.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { reservedNamesPattern, leaksPrivateRegister } from './reserved-register.js';

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// An unbracketed alternation must not split its boundaries across the pipe.
const bare = reservedNamesPattern('cara|esposa')!;
ok('"cara|esposa" matches "cara mia"', bare.test('ciao cara mia'));
ok('"cara|esposa" matches "esposa"', bare.test('hello Esposa'));
ok('"cara|esposa" does NOT match "caramel"', !bare.test('caramel sauce'));
ok('"cara|esposa" does NOT match "carajo" or "escara"', !bare.test('carajo') && !bare.test('escara'));
ok('"cara|esposa" does NOT match "esposado"', !bare.test('esposado'));
ok('no names → no matcher', reservedNamesPattern(null) === null && reservedNamesPattern('') === null);

// The House list, written both ways, matches exactly the same text.
const LIST = 'esposa|perigo|cara|piccola|pericolo';
const bareConfig = reservedNamesPattern(LIST)!;
const ownBounds = new RegExp(`\\b(${LIST})\\b`, 'i'); // what the House file used to carry
const corpus = [
  'esposa', 'minha esposa', 'meu perigo', 'Perigo!', 'cara', 'ciao cara', 'caramel', 'carajo', 'cara-mia', 'a cara.', 'piccola mia', 'pericolo',
  'pericoloso', 'esposas', 'perigoso', 'mi cara', 'CARA', 'scara', 'hello friend', 'my wife', "o'cara", 'caraíba', 'esposa,perigo',
];
ok('House list: engine-bounded and self-bounded patterns agree on every corpus line', corpus.every((t) => bareConfig.test(t) === ownBounds.test(t)));
ok('House list: the self-bounded form still works inside the engine wrapper', corpus.every((t) => reservedNamesPattern(`\\b(${LIST})\\b`)!.test(t) === ownBounds.test(t)));
ok('House list: "caramel" is not reserved', !bareConfig.test('caramel') && !ownBounds.test('caramel'));
ok('House list: "cara mia" is reserved', bareConfig.test('cara mia'));

// The deployment actually loaded (test identity, or the House file when CONFIG_PATH points at it).
ok('engine: "caramel" does not leak', leaksPrivateRegister('I love caramel') === false);
ok('engine: a reserved name leaks', leaksPrivateRegister('ciao cara') === true && leaksPrivateRegister('hello esposa') === true);

// The shipped House file: same verdicts as the bare list (skipped where the House layer is not present).
const deployFile = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'house', 'discord.config.json');
if (existsSync(deployFile)) {
  const raw = JSON.parse(readFileSync(deployFile, 'utf8')).identity?.reserved_names as string | undefined;
  const fromFile = reservedNamesPattern(raw)!;
  ok('House file: shipped reserved_names matches exactly like the bare House list', corpus.every((t) => fromFile.test(t) === bareConfig.test(t)));
  ok('House file: "caramel" is not reserved', !fromFile.test('caramel'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
