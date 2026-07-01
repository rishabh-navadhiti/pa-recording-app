'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const coder = require('../../src/icd/coder')

// A small in-memory codeset stub (no DB) — mirrors src/icd/lookup.js's surface.
function fakeLookup() {
  const CODES = {
    'M54.50': { code: 'M54.50', exists: true, billable: true,  short: 'Low back pain, unspecified' },
    'M25.77': { code: 'M25.77', exists: true, billable: false, short: 'Osteophyte, ankle and foot' }, // header
    'M54.9':  { code: 'M54.9',  exists: true, billable: true,  short: 'Dorsalgia, unspecified' },      // valid but wrong label
  }
  return {
    validate: (code) => CODES[code] || { code, exists: false, billable: false, short: null },
    search: (terms) => {
      const t = String(terms || '').toLowerCase()
      if (t.includes('osteophyte')) return [{ code: 'M25.775', billable: true, short: 'Osteophyte, left foot' }]
      if (t.includes('back pain') || t.includes('low back')) return [{ code: 'M54.50', billable: true, short: 'Low back pain, unspecified' }]
      return []
    },
  }
}

// ---- descMatch -------------------------------------------------------------

test('descMatch is 1.0 for the same phrase and 0 for disjoint phrases', () => {
  assert.strictEqual(coder.descMatch('Low back pain, unspecified', 'Low back pain, unspecified'), 1)
  assert.strictEqual(coder.descMatch('low back pain', 'Dorsalgia'), 0)
})

// ---- crossCheck dial -------------------------------------------------------

test('crossCheck ACCEPTS a valid, billable, description-matching code', () => {
  const { accepted, flagged } = coder.crossCheck([
    { diagnosis: 'Low back pain', code: 'M54.50', description: 'Low back pain, unspecified', search_terms: 'low back pain' },
  ], fakeLookup())
  assert.strictEqual(flagged.length, 0)
  assert.strictEqual(accepted.length, 1)
  assert.strictEqual(accepted[0].code, 'M54.50')
  assert.strictEqual(accepted[0].status, 'accepted')
})

test('crossCheck CORRECTS a non-billable header to a billable child via search', () => {
  const { accepted } = coder.crossCheck([
    { diagnosis: 'Osteophyte, left foot', code: 'M25.77', description: 'Osteophyte, left foot', search_terms: 'osteophyte foot' },
  ], fakeLookup())
  assert.strictEqual(accepted.length, 1)
  assert.strictEqual(accepted[0].code, 'M25.775')
  assert.strictEqual(accepted[0].status, 'corrected')
})

test('crossCheck CORRECTS a valid-but-mislabeled code via description mismatch → search', () => {
  const { accepted } = coder.crossCheck([
    { diagnosis: 'Low back pain', code: 'M54.9', description: 'Low back pain', search_terms: 'low back pain unspecified' },
  ], fakeLookup())
  assert.strictEqual(accepted.length, 1)
  assert.strictEqual(accepted[0].code, 'M54.50')  // resolved away from the mismatched M54.9
})

test('crossCheck FLAGS a code that does not exist and cannot be resolved', () => {
  const { accepted, flagged } = coder.crossCheck([
    { diagnosis: 'Foobar syndrome', code: 'Z99.999', description: 'Foobar syndrome', search_terms: 'foobar syndrome' },
  ], fakeLookup())
  assert.strictEqual(accepted.length, 0)
  assert.strictEqual(flagged.length, 1)
  assert.strictEqual(flagged[0].code, null)
})

// ---- orderByFirstListed ----------------------------------------------------

test('orderByFirstListed floats the first-listed code to row 1 (dotted or dotless hint)', () => {
  const accepted = [
    { diagnosis: 'A', code: 'M25.774', official: 'x' },
    { diagnosis: 'B', code: 'M54.50', official: 'y' },
  ]
  assert.strictEqual(coder.orderByFirstListed(accepted, 'M54.50')[0].code, 'M54.50')
  assert.strictEqual(coder.orderByFirstListed(accepted, 'M5450')[0].code, 'M54.50')
})

test('orderByFirstListed is a no-op when first_listed is absent or unmatched', () => {
  const accepted = [{ diagnosis: 'A', code: 'M25.774', official: 'x' }, { diagnosis: 'B', code: 'M54.50', official: 'y' }]
  assert.strictEqual(coder.orderByFirstListed(accepted, null)[0].code, 'M25.774')
  assert.strictEqual(coder.orderByFirstListed(accepted, 'Z99.9')[0].code, 'M25.774')
})

// ---- table rendering -------------------------------------------------------

test('buildCodesTable emits the canonical heading + one row per accepted code', () => {
  const block = coder.buildCodesTable([
    { diagnosis: 'Low back pain', code: 'M54.50', official: 'Low back pain, unspecified' },
  ], [])
  assert.match(block, /## ICD-10-CM Codes/)
  assert.match(block, /\| # \| Diagnosis \| ICD-10-CM Code \| Description \|/)
  assert.match(block, /\| 1 \| Low back pain \| M54\.50 \| Low back pain, unspecified \|/)
})

test('buildCodesTable lists flagged diagnoses below the table (never as a code)', () => {
  const block = coder.buildCodesTable(
    [{ diagnosis: 'Low back pain', code: 'M54.50', official: 'Low back pain, unspecified' }],
    [{ diagnosis: 'Foobar syndrome', reason: 'could not be matched' }])
  assert.match(block, /\*\*Needs manual coding:\*\*/)
  assert.match(block, /Foobar syndrome/)
})

test('buildCodesTable escapes pipes in cell text', () => {
  const block = coder.buildCodesTable([
    { diagnosis: 'a | b', code: 'X00', official: 'c | d' },
  ], [])
  assert.match(block, /a \\\| b/)
  assert.match(block, /c \\\| d/)
})

// ---- replace / append ------------------------------------------------------

test('replaceOrAppendCodesSection appends when no section exists', () => {
  const note = '# SOAP Note\n\n**Assessment:** low back pain.\n'
  const out  = coder.replaceOrAppendCodesSection(note, coder.buildCodesTable([
    { diagnosis: 'Low back pain', code: 'M54.50', official: 'Low back pain, unspecified' },
  ], []))
  assert.strictEqual((out.match(/## ICD-10-CM Codes/g) || []).length, 1)
  assert.match(out, /M54\.50/)
  assert.match(out, /\*\*Assessment:\*\*/)  // original content preserved
})

test('replaceOrAppendCodesSection replaces an existing section (pre-chart re-run)', () => {
  const note = '# SOAP Note\n\n**Assessment:** low back pain.\n\n---\n\n## ICD-10-CM Codes\n\n| # | Diagnosis | ICD-10-CM Code | Description |\n|---|---|---|---|\n| 1 | Old dx | X00.0 | old |\n'
  const out  = coder.replaceOrAppendCodesSection(note, coder.buildCodesTable([
    { diagnosis: 'Low back pain', code: 'M54.50', official: 'Low back pain, unspecified' },
  ], []))
  assert.strictEqual((out.match(/## ICD-10-CM Codes/g) || []).length, 1, 'exactly one codes section')
  assert.match(out, /M54\.50/)
  assert.ok(!out.includes('X00.0'), 'old codes removed')
})
