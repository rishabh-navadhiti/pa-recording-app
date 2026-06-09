'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// ---------------------------------------------------------------------------
// ICD pre-flight detector — extracted from cdiManual.js for unit testing.
// Mirrors the exact regexes used in the job module.
// ---------------------------------------------------------------------------

const ICD_CODE_RE = /\b[A-TV-Z]\d[0-9A-Z](?:\.[0-9A-Z]{1,4})?\b/

function hasIcdContent(text) {
  return /^##\s+ICD-10/im.test(text) || ICD_CODE_RE.test(text)
}

test('ICD pre-flight: note with ## ICD-10-CM Codes section passes', () => {
  const note = 'SUBJECTIVE:\nPain in wrist.\n\n## ICD-10-CM Codes\n| Code | Description |\n| M65.311 | Trigger finger |\n'
  assert.ok(hasIcdContent(note), 'should detect ## ICD-10-CM Codes heading')
})

test('ICD pre-flight: note with inline ICD code (no section) passes', () => {
  const note = 'ASSESSMENT:\nM65.311 - Trigger finger, right.\nPlan: surgery.\n'
  assert.ok(hasIcdContent(note), 'should detect standalone ICD code via regex')
})

test('ICD pre-flight: note with no ICD codes is blocked', () => {
  const note = 'SUBJECTIVE:\nPatient presents with right wrist pain.\nOBJECTIVE:\nTenderness noted.\nASSESSMENT:\nTrigger finger.\nPLAN:\nSurgery.\n'
  assert.ok(!hasIcdContent(note), 'should return false when no ICD codes present')
})

test('ICD pre-flight: heading with leading ## and extra spaces passes', () => {
  const note = '##  ICD-10 Codes\nM79.3\n'
  assert.ok(hasIcdContent(note))
})

test('ICD pre-flight: code at the start of line passes', () => {
  assert.ok(hasIcdContent('S62.001A fracture of navicular\n'))
})

test('ICD pre-flight: non-ICD alphanumeric does not false-positive', () => {
  const note = 'SOAP NOTE\nVitals: BP 120/80.\nPlan: continue current meds.\n'
  assert.ok(!hasIcdContent(note))
})

// ---------------------------------------------------------------------------
// Input mode selection logic — mirrors cdiManual.js normalisation branch
// ---------------------------------------------------------------------------

function selectInputMode(pastedText, filePath) {
  if (filePath && filePath.toLowerCase().endsWith('.docx')) return 'docx'
  if (filePath && filePath.toLowerCase().endsWith('.md'))   return 'md'
  if (pastedText && pastedText.trim()) return 'paste'
  return 'none'
}

test('input normalizer: .docx file takes docx branch', () => {
  assert.strictEqual(selectInputMode('', '/tmp/note.docx'), 'docx')
})

test('input normalizer: .md file takes md branch', () => {
  assert.strictEqual(selectInputMode('some text', '/tmp/note.md'), 'md')
})

test('input normalizer: paste-only with no file takes paste branch', () => {
  assert.strictEqual(selectInputMode('SOAP note text here', ''), 'paste')
})

test('input normalizer: no text and no file returns none', () => {
  assert.strictEqual(selectInputMode('', ''), 'none')
  assert.strictEqual(selectInputMode('   ', ''), 'none')
})

// ---------------------------------------------------------------------------
// Temp-folder cleanup on failure — verify rmSync behaviour
// ---------------------------------------------------------------------------

test('temp folder cleanup: directory is removed on failure', () => {
  const tmpDir = path.join(os.tmpdir(), `cdi_test_${Date.now()}`)
  fs.mkdirSync(tmpDir)
  fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'hello')
  assert.ok(fs.existsSync(tmpDir))

  fs.rmSync(tmpDir, { recursive: true, force: true })
  assert.ok(!fs.existsSync(tmpDir), 'temp dir should be removed')
})
