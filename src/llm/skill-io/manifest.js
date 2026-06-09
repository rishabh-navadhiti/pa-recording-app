'use strict'

// Parse + validate skill manifest lines emitted by generate-note, cdi-review,
// and (eventually) all other skills. Two exports:
//   parseSkillManifest(text)         — layered defensive parser; returns obj | null
//   validateManifest(obj, schema)    — per-engine structural check; returns { valid, errors }

// ---- parser -----------------------------------------------------------------

// Layered defensive parser — returns the parsed object on success, null on failure.
// Layers, tried in order:
//   1. Last non-empty trimmed line of the input, direct JSON.parse.
//   2. Strip ```json / ``` code fences (single-line or split across last two lines).
//   3. Brace-balance scan from each '}' walking left to find a matching '{'.
// Caller treats null as "skill output not understood" → mark the run failed.
// For CDI: when this returns null (e.g. a 429 cut the run before the manifest
// line arrived), main.js falls back to reading the on-disk <case>_cdi.json.
// That filesystem fallback is NOT this function's responsibility — it stays null.
function parseSkillManifest(text) {
  if (!text || typeof text !== 'string') return null

  const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (rawLines.length === 0) return null

  // Layer 1: last non-empty trimmed line, direct parse.
  const lastLine = rawLines[rawLines.length - 1]
  try { return JSON.parse(lastLine) } catch {}

  // Layer 2: strip code fences off the last line; also try the line above the fence.
  const stripped = lastLine.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  if (stripped && stripped !== lastLine) {
    try { return JSON.parse(stripped) } catch {}
  }
  if (rawLines.length >= 2 && /^```/.test(lastLine)) {
    try { return JSON.parse(rawLines[rawLines.length - 2]) } catch {}
  }

  // Layer 3: brace-balance scan from each '}' walking back for a matching '{'.
  let end = text.lastIndexOf('}')
  while (end >= 0) {
    let depth = 0
    let matched = -1
    for (let i = end; i >= 0; i--) {
      const ch = text[i]
      if (ch === '}') depth++
      else if (ch === '{') {
        depth--
        if (depth === 0) { matched = i; break }
      }
    }
    if (matched >= 0) {
      const block = text.slice(matched, end + 1)
      try { return JSON.parse(block) } catch {}
    }
    end = text.lastIndexOf('}', end - 1)
  }

  return null
}

// ---- validator --------------------------------------------------------------

// Per-engine manifest validator. Phase 2 fills this in per engine when the
// engine descriptors land and each skill's output contract is locked.
// For now it's a no-op pass-through so callers can be written against the
// final API today without waiting for Phase 2.
//
// @param {object} obj    - the parsed manifest object (from parseSkillManifest)
// @param {object} schema - per-engine expected shape (keys + types)
// @returns {{ valid: boolean, errors: string[] }}
function validateManifest(obj, schema) {
  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['manifest is null or not an object'] }
  }
  if (!schema || typeof schema !== 'object') {
    return { valid: true, errors: [] }  // no schema = accept anything (Phase 0 default)
  }
  const errors = []
  for (const [key, type] of Object.entries(schema)) {
    if (!(key in obj)) {
      errors.push(`missing required field '${key}'`)
    } else if (type !== null && typeof obj[key] !== type) {
      errors.push(`field '${key}' expected ${type}, got ${typeof obj[key]}`)
    }
  }
  return { valid: errors.length === 0, errors }
}

module.exports = { parseSkillManifest, validateManifest }
