// Solance House — Copyright (c) 2026 House of Solance. All rights reserved. Required Notice: Copyright (c) 2026 House of Solance (https://github.com/SolanceLab)
// Pure helpers for the keyword-blocklist chip editor (Discord settings —
// "Keyword filter (memory blocklist)" card). Extracted from the component
// so add/remove/dedupe logic is unit-testable without mounting React or
// hitting the Sanctum API.

/**
 * Add a word to a blocklist. Trims whitespace, skips empty input, and skips
 * a duplicate (case-insensitive, so "Owen" and "owen" don't produce two
 * chips) — but preserves the ORIGINAL casing of whatever gets added, since
 * this is a literal-match filter, not a normalized tag list.
 *
 * Returns the SAME array reference when nothing changes (empty/duplicate
 * input), so callers can cheaply detect a no-op with `next === list`.
 */
export function addBlocklistWord(list, word) {
  const trimmed = (word || '').trim()
  if (!trimmed) return list
  const exists = list.some(w => w.toLowerCase() === trimmed.toLowerCase())
  if (exists) return list
  return [...list, trimmed]
}

/**
 * Remove a word from a blocklist by exact match against its chip label
 * (case-sensitive — it's removing the specific chip the user clicked, not
 * doing a fuzzy match).
 */
export function removeBlocklistWord(list, word) {
  return list.filter(w => w !== word)
}
