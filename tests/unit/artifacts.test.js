'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const os = require('os')
const fs = require('fs')

const {
  sanitizeName, extractLastname, relForSkill,
  cdiPaths, caseStemFromSoapMd, buildCaseFolder
} = require('../../src/pipeline/artifacts')

// ---- sanitizeName ----------------------------------------------------------
test('sanitizeName lowercases and replaces spaces with underscores', () => {
  assert.strictEqual(sanitizeName('Jane Doe'), 'jane_doe')
})
test('sanitizeName strips special characters', () => {
  assert.strictEqual(sanitizeName("O'Brien"), 'obrien')
})
test('sanitizeName returns null for empty/null', () => {
  assert.strictEqual(sanitizeName(null), null)
  assert.strictEqual(sanitizeName('   '), null)
})
test('sanitizeName collapses double underscores', () => {
  assert.strictEqual(sanitizeName('Dr  Smith'), 'dr_smith')
})

// ---- extractLastname -------------------------------------------------------
test('extractLastname strips Dr. prefix and returns slug of last word', () => {
  assert.strictEqual(extractLastname('Dr. Jane Sabbag'), 'sabbag')
})
test('extractLastname handles single word', () => {
  assert.strictEqual(extractLastname('Smith'), 'smith')
})
test('extractLastname returns null for empty', () => {
  assert.strictEqual(extractLastname(''), null)
})

// ---- relForSkill -----------------------------------------------------------
test('relForSkill converts absolute path to forward-slash relative', () => {
  const notesDir = path.join(os.tmpdir(), 'notes')
  const absPath  = path.join(notesDir, 'Cases', '2026-06-05', 'soap.md')
  const rel = relForSkill(absPath, notesDir)
  assert.ok(!rel.includes('\\'), 'no backslashes')
  assert.match(rel, /Cases\/2026-06-05\/soap\.md/)
})

// ---- cdiPaths --------------------------------------------------------------
test('cdiPaths returns correct json/md/docx paths', () => {
  const p = cdiPaths('/notes/Cases/jane', 'jane_2026-06-05')
  assert.ok(p.jsonPath.endsWith('_cdi.json'))
  assert.ok(p.mdPath.endsWith('_cdi.md'))
  assert.ok(p.docxPath.endsWith('_cdi.docx'))
})

// ---- caseStemFromSoapMd ----------------------------------------------------
test('caseStemFromSoapMd strips _soap_note.md suffix', () => {
  const stem = caseStemFromSoapMd('/notes/Cases/jane_2026-06-05/jane_2026-06-05_soap_note.md')
  assert.strictEqual(stem, 'jane_2026-06-05')
})

// ---- buildCaseFolder -------------------------------------------------------
test('buildCaseFolder creates directory and returns caseDir + folderName', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-test-'))
  const ctx = {
    stores: { session: { get: () => ({ dir: tmpDir }) } },
    paths: { casesDir: tmpDir },
  }
  const { caseDir, folderName } = buildCaseFolder('jane_doe', ctx)
  assert.ok(fs.existsSync(caseDir), 'directory was created')
  assert.ok(folderName.startsWith('jane_doe_'))
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
