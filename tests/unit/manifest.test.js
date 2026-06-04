'use strict'

// Unit tests for the manifest parser.
// Run with: node --test tests/unit/manifest.test.js
// (or via: npm run test:unit)

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseSkillManifest, validateManifest } = require('../../src/llm/skill-io/manifest')
const { SINGLE_OK, MULTI_OK, CDI_OK, CDI_SKIPPED } = require('../fixtures/manifests/index')

// ---- Layer 1: direct parse of the last line --------------------------------

test('parses a clean single-line manifest (last-line direct)', () => {
  const m = parseSkillManifest(SINGLE_OK)
  assert.strictEqual(m.schema_version, 1)
  assert.strictEqual(m.multi_patient, false)
  assert.strictEqual(m.cases[0].patient_name, 'Jane Doe')
})

test('parses a manifest preceded by prose, single-patient', () => {
  const prose = [
    '**Done.** SOAP note generated for Dr. Sabbag.',
    '',
    '- Chief complaint: left wrist pain s/p ORIF',
    '- Primary assessment: nonunion of distal radius',
    '',
    SINGLE_OK
  ].join('\n')
  const m = parseSkillManifest(prose)
  assert.ok(m, 'should parse')
  assert.strictEqual(m.cases[0].doctor_lastname, 'sabbag')
})

test('parses a multi-patient manifest with 2 cases', () => {
  const m = parseSkillManifest(MULTI_OK)
  assert.strictEqual(m.multi_patient, true)
  assert.strictEqual(m.cases.length, 2)
  assert.strictEqual(m.cases[1].patient_name, 'John Smith')
})

// ---- Layer 2: strip code fences --------------------------------------------

test('handles ```json fences wrapping the manifest on a single line', () => {
  const wrapped = 'Some prose.\n\n```json' + '\n' + SINGLE_OK + '\n```'
  const m = parseSkillManifest(wrapped)
  assert.ok(m, 'should parse')
  assert.strictEqual(m.cases[0].patient_name, 'Jane Doe')
})

test('handles a single-line fence: ```json{...}```', () => {
  const wrapped = 'Done.\n\n```json' + SINGLE_OK + '```'
  const m = parseSkillManifest(wrapped)
  assert.ok(m, 'should parse')
  assert.strictEqual(m.schema_version, 1)
})

// ---- Layer 3: brace-balance scan -------------------------------------------

test('falls back to brace-balance when manifest has trailing prose', () => {
  const trailing = SINGLE_OK + '\n\nLet me know if you need anything else!'
  const m = parseSkillManifest(trailing)
  assert.ok(m, 'should parse via brace-balance')
  assert.strictEqual(m.cases[0].doctor_lastname, 'sabbag')
})

test('finds the manifest embedded in mid-prose', () => {
  const buried = 'Header.\n\nHere is the manifest:\n\n' + SINGLE_OK + '\n\nTrailing prose.'
  const m = parseSkillManifest(buried)
  assert.ok(m, 'should parse')
  assert.strictEqual(m.cases[0].patient_name, 'Jane Doe')
})

// ---- Failure modes ---------------------------------------------------------

test('returns null for empty input', () => {
  assert.strictEqual(parseSkillManifest(''), null)
})

test('returns null for null input', () => {
  assert.strictEqual(parseSkillManifest(null), null)
})

test('returns null for input with no JSON', () => {
  assert.strictEqual(parseSkillManifest('No JSON in here whatsoever, just words.'), null)
})

test('returns null for malformed JSON with no valid block', () => {
  const broken = 'Prose here.\n\n{"schema_version":1,"cases":[broken syntax}'
  assert.strictEqual(parseSkillManifest(broken), null)
})

test('does not throw on adversarial input — finds trailing valid manifest', () => {
  const tricky = '{ this is broken { still broken } } and here:\n' + SINGLE_OK
  const m = parseSkillManifest(tricky)
  assert.ok(m, 'should still find the trailing valid manifest')
  assert.strictEqual(m.schema_version, 1)
})

// ---- CDI manifest shape ----------------------------------------------------

test('parses a CDI ok manifest', () => {
  const m = parseSkillManifest(CDI_OK)
  assert.ok(m, 'should parse')
  assert.strictEqual(m.skill, 'cdi-review')
  assert.strictEqual(m.status, 'ok')
  assert.strictEqual(m.flag_count, 2)
  assert.strictEqual(m.quality_score, 72)
  assert.strictEqual(m.clinician_approval_required, false)
  assert.strictEqual(m.icd_validated, true)
})

test('parses a CDI skipped manifest', () => {
  const m = parseSkillManifest(CDI_SKIPPED)
  assert.ok(m, 'should parse')
  assert.strictEqual(m.status, 'skipped')
  assert.strictEqual(m.skipped_reason, 'specialty not configured')
})

test('returns null when CDI manifest line is missing (rate-limit truncated output)', () => {
  // Simulates a claude run cut off by a 429 — the manifest line never arrives.
  // The CDI on-disk fallback (reading _cdi.json) is not parseSkillManifest's job;
  // it must simply return null so the caller knows to attempt the fallback.
  const rateLimitOutput = 'Claude usage limit reached. Please try again after 3pm.\n\nI was generating your CDI review but ran out of time.'
  assert.strictEqual(parseSkillManifest(rateLimitOutput), null)
})

// ---- validateManifest ------------------------------------------------------

test('validateManifest returns valid for an object matching the schema', () => {
  const obj = { status: 'ok', flag_count: 2, quality_score: 72 }
  const schema = { status: 'string', flag_count: 'number', quality_score: 'number' }
  const result = validateManifest(obj, schema)
  assert.strictEqual(result.valid, true)
  assert.strictEqual(result.errors.length, 0)
})

test('validateManifest reports missing required fields', () => {
  const obj = { status: 'ok' }
  const schema = { status: 'string', flag_count: 'number' }
  const result = validateManifest(obj, schema)
  assert.strictEqual(result.valid, false)
  assert.ok(result.errors.some(e => e.includes('flag_count')), 'should report missing flag_count')
})

test('validateManifest reports type mismatches', () => {
  const obj = { status: 42 }
  const schema = { status: 'string' }
  const result = validateManifest(obj, schema)
  assert.strictEqual(result.valid, false)
  assert.ok(result.errors.some(e => e.includes('status')))
})

test('validateManifest with no schema accepts anything', () => {
  const result = validateManifest({ anything: true }, null)
  assert.strictEqual(result.valid, true)
})

test('validateManifest returns invalid for null input', () => {
  const result = validateManifest(null, { status: 'string' })
  assert.strictEqual(result.valid, false)
})
