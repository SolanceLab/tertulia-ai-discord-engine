// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
import { expect, it, describe } from 'vitest'
import manifest from '../manifest.js'

describe('discord manifest', () => {
  it('has the module shape the registry expects', () => {
    expect(manifest.id).toBe('discord')
    expect(manifest.label).toBe('Discord')
    expect(typeof manifest.description).toBe('string')
    expect(manifest.defaultEnabled).toBe(true)
    expect(manifest.nav.items).toEqual([])
  })
  it('keeps both page URLs exactly where they were', () => {
    expect(manifest.routes.map((r) => r.path)).toEqual(['settings/discord', 'settings/logs'])
    for (const r of manifest.routes) expect(typeof r.load).toBe('function')
  })
})
