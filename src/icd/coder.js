'use strict'

/**
 * ICD-10-CM cross-check + table rendering — the deterministic "Phase B/C" of the
 * ICD-coding step. The model (Phase A, src/engines/icd.js runLlm) proposes candidate
 * codes from the note; this module verifies every one against the local codeset
 * (src/icd/lookup.js) and renders the `## ICD-10-CM Codes` table.
 *
 * The dial (per the 2026-06-25 decision): CROSS-CHECK — a proposed code is accepted
 * only if it exists, is billable, AND its official description matches the diagnosis.
 * A non-existent / header / description-mismatched code is re-resolved via a codeset
 * search on the model's search terms; if that finds no confident match, the diagnosis
 * is FLAGGED for manual coding rather than emitted with a wrong code. Hallucinations
 * and non-billable header codes never reach the claim.
 *
 * Pure + dependency-injected (takes a `lookup` object) so it unit-tests without a DB.
 */

const STOP = new Set(['and', 'of', 'the', 'with', 'a', 'an', 'to', 'for', 'in', 'on', 'due', 'unspecified', 'other'])
const MATCH_THRESHOLD = 0.5

function tokenize(s) {
  return new Set((String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter(t => !STOP.has(t)))
}

/**
 * Fraction of the model description's meaningful tokens present in the codeset description.
 * Note: divides by the model's token count, so a very terse model description (one token)
 * can score 1.0 against a longer official description. That is acceptable here — this guard
 * exists to catch hallucinated / non-billable / grossly-mislabeled codes, not to prove full
 * semantic equivalence; the add-icd-codes-api skill is instructed to give a faithful,
 * full-length description, which keeps this from being a real gap in practice.
 */
function descMatch(modelDesc, dbShort) {
  const m = tokenize(modelDesc)
  if (!m.size) return 0
  const d = tokenize(dbShort)
  let hit = 0
  for (const t of m) if (d.has(t)) hit++
  return hit / m.size
}

/**
 * Search the codeset by the model's terms and return the first BILLABLE result whose
 * official description matches the model's intended description (the "model proposes,
 * codeset disposes" resolution). Returns {code, short} or null.
 */
function searchResolve(terms, expectedDesc, lookup) {
  const results = lookup.search(terms, { billableOnly: true, limit: 8 })
  for (const r of results) {
    if (descMatch(expectedDesc, r.short) >= MATCH_THRESHOLD) return r
  }
  return null
}

/**
 * Cross-check ONE model candidate against the codeset.
 * @returns {{diagnosis, code, official, status, reason}}
 *   status: 'accepted' (proposed code valid + desc matches)
 *         | 'corrected' (proposed code invalid/header/mismatch → resolved via search)
 *         | 'flagged'   (could not confidently code → excluded from the table)
 */
function resolveCandidate(cand, lookup) {
  const diagnosis  = (cand.diagnosis || cand.description || '').trim()
  const proposed   = (cand.code || '').trim()
  const modelDesc  = cand.description || diagnosis
  const terms      = cand.search_terms || cand.description || diagnosis

  const v = proposed ? lookup.validate(proposed) : { exists: false, billable: false }

  if (v.exists && v.billable) {
    if (descMatch(modelDesc, v.short) >= MATCH_THRESHOLD) {
      return { diagnosis, code: v.code, official: v.short, status: 'accepted', reason: '' }
    }
    // Valid + billable but the official label disagrees with the diagnosis — likely a
    // right-sounding-but-wrong code. Try to resolve; don't emit a mismatched code.
    const s = searchResolve(terms, modelDesc, lookup)
    if (s) return { diagnosis, code: s.code, official: s.short, status: 'corrected',
                    reason: `model proposed ${v.code} but its description did not match; resolved to ${s.code}` }
    return { diagnosis, code: null, official: null, status: 'flagged',
             reason: `${v.code} is valid but its official description ("${v.short}") does not match the diagnosis` }
  }

  // Non-existent OR header/non-billable — resolve via search.
  const s = searchResolve(terms, modelDesc, lookup)
  if (s) {
    const why = v.exists ? `${proposed} is a non-billable header` : `${proposed || '(no code)'} is not in the FY2026 codeset`
    return { diagnosis, code: s.code, official: s.short, status: 'corrected', reason: `${why}; resolved to billable ${s.code}` }
  }
  return { diagnosis, code: null, official: null, status: 'flagged',
           reason: v.exists ? `${proposed} is a non-billable header and no billable child matched the documentation`
                            : `${proposed || '(no code)'} could not be matched to a billable FY2026 code` }
}

/**
 * Cross-check all candidates.
 * @param {Array} candidates  [{diagnosis, code, description, search_terms, specificity}]
 * @param {object} lookup     src/icd/lookup.js (or a compatible stub)
 * @returns {{rows, accepted, flagged, codesAdded}}
 */
function crossCheck(candidates, lookup) {
  const rows = (candidates || []).map(c => resolveCandidate(c, lookup))
  const accepted = rows.filter(r => (r.status === 'accepted' || r.status === 'corrected') && r.code)
  const flagged  = rows.filter(r => r.status === 'flagged' || !r.code)
  return { rows, accepted, flagged, codesAdded: accepted.length }
}

/**
 * Float the first-listed diagnosis to row 1 so the claim's primary diagnosis is unambiguous.
 * The model already emits candidates in priority order; this honors an explicit `first_listed`
 * hint when that code survived cross-check unchanged (no-op if it was corrected away or absent).
 */
function orderByFirstListed(accepted, firstListed) {
  if (!firstListed || accepted.length < 2) return accepted
  const key = String(firstListed).replace(/\./g, '').toUpperCase()
  const i = accepted.findIndex(r => String(r.code || '').replace(/\./g, '').toUpperCase() === key)
  if (i <= 0) return accepted
  return [accepted[i], ...accepted.slice(0, i), ...accepted.slice(i + 1)]
}

/** Escape a cell for a markdown table (pipes + newlines). */
function esc(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * Build the `## ICD-10-CM Codes` markdown block (starts at the `---` separator).
 * Matches the format the app has always appended, so downstream docx is unchanged.
 * Flagged diagnoses (couldn't be confidently coded) are listed below the table for
 * the scribe — never emitted as a code.
 */
function buildCodesTable(accepted, flagged = []) {
  const lines = [
    '---',
    '',
    '## ICD-10-CM Codes',
    '',
    '| # | Diagnosis | ICD-10-CM Code | Description |',
    '|---|-----------|----------------|-------------|',
  ]
  accepted.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${esc(r.diagnosis)} | ${r.code} | ${esc(r.official)} |`)
  })
  if (flagged.length) {
    lines.push('', '**Needs manual coding:**')
    for (const f of flagged) lines.push(`- ${esc(f.diagnosis)} — ${esc(f.reason)}`)
  }
  return lines.join('\n')
}

/**
 * Replace an existing `## ICD-10-CM Codes` section (on a pre-chart re-run) or append
 * a fresh one. Returns the full updated note text.
 */
function replaceOrAppendCodesSection(noteText, block) {
  let txt = String(noteText || '').replace(/\r\n/g, '\n')
  const idx = txt.search(/^##\s+ICD-10-CM Codes\b/m)
  if (idx >= 0) {
    txt = txt.slice(0, idx)                              // drop heading + everything after
    txt = txt.replace(/\n[ \t]*-{3,}[ \t]*\n?\s*$/, '')  // drop the preceding --- separator
  }
  return txt.replace(/\s+$/, '') + '\n\n' + block + '\n'
}

module.exports = {
  crossCheck, resolveCandidate, orderByFirstListed, buildCodesTable, replaceOrAppendCodesSection,
  descMatch, MATCH_THRESHOLD,
}
