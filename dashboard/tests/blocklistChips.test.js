// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Unit tests for the keyword-blocklist chip helpers used by the "Keyword
// filter (memory blocklist)" card on Discord settings.

import { expect, it, describe } from 'vitest'
import { addBlocklistWord, removeBlocklistWord } from '../lib/blocklistChips.js'

describe('addBlocklistWord', () => {
  it('appends a trimmed word to the list', () => {
    expect(addBlocklistWord(['alpha'], '  beta  ')).toEqual(['alpha', 'beta'])
  })

  it('returns the same list reference for empty/whitespace-only input', () => {
    const list = ['alpha']
    expect(addBlocklistWord(list, '   ')).toBe(list)
    expect(addBlocklistWord(list, '')).toBe(list)
  })

  it('skips a case-insensitive duplicate and preserves the existing casing', () => {
    const list = ['Owen']
    const next = addBlocklistWord(list, 'owen')
    expect(next).toBe(list)
    expect(next).toEqual(['Owen'])
  })

  it('preserves the casing of a genuinely new word as typed', () => {
    expect(addBlocklistWord([], 'Bram')).toEqual(['Bram'])
  })

  it('builds up a list across repeated adds without clobbering earlier entries', () => {
    let list = []
    list = addBlocklistWord(list, 'one')
    list = addBlocklistWord(list, 'two')
    list = addBlocklistWord(list, 'one') // duplicate, ignored
    expect(list).toEqual(['one', 'two'])
  })
})

describe('removeBlocklistWord', () => {
  it('removes an exact-match word', () => {
    expect(removeBlocklistWord(['alpha', 'beta'], 'alpha')).toEqual(['beta'])
  })

  it('is case-sensitive (removes the chip as-labeled, not a fuzzy match)', () => {
    expect(removeBlocklistWord(['Owen'], 'owen')).toEqual(['Owen'])
  })

  it('is a no-op for a word not in the list', () => {
    const list = ['alpha', 'beta']
    expect(removeBlocklistWord(list, 'gamma')).toEqual(list)
  })

  it('removes only the matching entry when duplicates somehow exist', () => {
    expect(removeBlocklistWord(['alpha', 'alpha', 'beta'], 'alpha')).toEqual(['beta'])
  })
})
