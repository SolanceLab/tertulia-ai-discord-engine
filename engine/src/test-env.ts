// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
/**
 * test-env.ts — import this FIRST in a test file. It points the engine at the neutral test identity
 * (test-fixtures/test-house.json) unless a config path is already set, so the tests assert the same
 * strings in every checkout and never depend on a deployment's own names. ESM runs imports in order,
 * so this has run before house-config.ts reads the environment.
 */
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

if (!process.env.HOUSE_CONFIG_PATH) {
  process.env.HOUSE_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'test-house.json');
}
