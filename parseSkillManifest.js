'use strict'

// Parse the JSON manifest line emitted by the generate-note skill at the end of
// its final assistant text response. Layered defensive parser — returns the
// parsed object on success, null on failure. Layers, tried in order:
//   1. Last non-empty trimmed line of the input, direct JSON.parse.
//   2. Strip ```json / ``` code fences (single-line or split across last two lines).
//   3. Brace-balance scan from each '}' walking left to find a matching '{'.
// Caller treats null as "skill output not understood" → mark the run failed.
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

module.exports = { parseSkillManifest }
