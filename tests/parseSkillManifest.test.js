'use strict'

// Static unit tests for the manifest parser. Run with `node tests/parseSkillManifest.test.js`.
// No test framework dependency — this is a plain Node script that exits non-zero on first
// failed assertion. Used to verify the four defensive parse layers without spinning up the
// full Electron app or running Claude.

const assert = require('assert')
const { parseSkillManifest } = require('../parseSkillManifest')

let passed = 0
let failed = 0

function it(name, fn) {
  try {
    fn()
    process.stdout.write(`  ok   ${name}\n`)
    passed++
  } catch (e) {
    process.stdout.write(`  FAIL ${name}\n        ${e.message}\n`)
    failed++
  }
}

const SINGLE_OK = '{"schema_version":1,"skill":"generate-note","status":"ok","multi_patient":false,"summary":"Generated SOAP note for Jane Doe.","recording_folder":"/Users/scribe/Documents/AI Medical Notes/Cases/2026-05-22/jane_doe_2026-05-22","cases":[{"patient_name":"Jane Doe","doctor_lastname":"sabbag","visit_type":"pr2_follow_up","chief_complaint":"Left wrist pain s/p ORIF","soap_note_md":"/Users/scribe/Documents/AI Medical Notes/Cases/2026-05-22/jane_doe_2026-05-22/jane_doe_2026-05-22_soap_note.md","placeholders":[],"warnings":[],"status":"ok"}],"warnings":[]}'

const MULTI_OK = '{"schema_version":1,"skill":"generate-note","status":"ok","multi_patient":true,"summary":"3 SOAP notes","recording_folder":"/abs/path/Cases/2026-05-22/recording_2026-05-22_14-33-10","cases":[{"patient_name":"Jane Doe","doctor_lastname":"spencer","visit_type":"follow_up","chief_complaint":"x","soap_note_md":"/abs/path/Cases/2026-05-22/recording_2026-05-22_14-33-10/jane_doe_soap_note.md","placeholders":[],"warnings":[],"status":"ok"},{"patient_name":"John Smith","doctor_lastname":"spencer","visit_type":"new_patient","chief_complaint":"y","soap_note_md":"/abs/path/Cases/2026-05-22/recording_2026-05-22_14-33-10/john_smith_soap_note.md","placeholders":[],"warnings":[],"status":"ok"}],"warnings":[]}'

process.stdout.write('parseSkillManifest\n')

// Layer 1 — direct parse of the last line
it('parses a clean single-line manifest (last-line direct)', () => {
  const m = parseSkillManifest(SINGLE_OK)
  assert.strictEqual(m.schema_version, 1)
  assert.strictEqual(m.multi_patient, false)
  assert.strictEqual(m.cases[0].patient_name, 'Jane Doe')
})

it('parses a manifest preceded by prose, both single-patient', () => {
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

it('parses a multi-patient manifest with 2 cases', () => {
  const m = parseSkillManifest(MULTI_OK)
  assert.strictEqual(m.multi_patient, true)
  assert.strictEqual(m.cases.length, 2)
  assert.strictEqual(m.cases[1].patient_name, 'John Smith')
})

// Layer 2 — strip code fences
it('handles ```json fences wrapping the manifest on a single line', () => {
  const wrapped = 'Some prose.\n\n```json' + SINGLE_OK.slice(0, 0) + '\n' + SINGLE_OK + '\n```'
  const m = parseSkillManifest(wrapped)
  assert.ok(m, 'should parse')
  assert.strictEqual(m.cases[0].patient_name, 'Jane Doe')
})

it('handles a single-line fence: ```json{...}```', () => {
  const wrapped = 'Done.\n\n```json' + SINGLE_OK + '```'
  const m = parseSkillManifest(wrapped)
  assert.ok(m, 'should parse')
  assert.strictEqual(m.schema_version, 1)
})

// Layer 3 — brace balance scan
it('falls back to brace-balance when manifest has trailing prose after', () => {
  const trailing = SINGLE_OK + '\n\nLet me know if you need anything else!'
  const m = parseSkillManifest(trailing)
  assert.ok(m, 'should parse via brace-balance')
  assert.strictEqual(m.cases[0].doctor_lastname, 'sabbag')
})

it('finds the manifest even when embedded in mid-prose', () => {
  const buried = 'Header.\n\nHere is the manifest you asked for:\n\n' + SINGLE_OK + '\n\nTrailing prose after.'
  const m = parseSkillManifest(buried)
  assert.ok(m, 'should parse')
  assert.strictEqual(m.cases[0].patient_name, 'Jane Doe')
})

// Failure modes
it('returns null for empty input', () => {
  assert.strictEqual(parseSkillManifest(''), null)
})

it('returns null for null input', () => {
  assert.strictEqual(parseSkillManifest(null), null)
})

it('returns null for input with no JSON at all', () => {
  assert.strictEqual(parseSkillManifest('No JSON in here whatsoever, just words.'), null)
})

it('returns null for malformed JSON with no valid block', () => {
  const broken = 'Prose here.\n\n{"schema_version":1,"cases":[broken syntax}'
  assert.strictEqual(parseSkillManifest(broken), null)
})

it('does not throw on adversarial input — only valid blocks succeed', () => {
  // Pathological: nested malformed braces followed by a real manifest.
  const tricky = '{ this is broken { still broken } } and here:\n' + SINGLE_OK
  const m = parseSkillManifest(tricky)
  assert.ok(m, 'should still find the trailing valid manifest')
  assert.strictEqual(m.schema_version, 1)
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
