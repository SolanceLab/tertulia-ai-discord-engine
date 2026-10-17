// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Pure layers run in node; the page tests opt into jsdom with a file docblock.
// Rooted at the module (jsdom and react resolve from its node_modules), so the
// suite finds its files whether it is run from the module or from dashboard/.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    environment: 'node',
    include: ['dashboard/tests/**/*.test.js'],
  },
})
