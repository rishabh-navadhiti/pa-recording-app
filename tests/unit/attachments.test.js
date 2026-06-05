'use strict'

// Tests for the Pre-chart attachment-combine port (Phase 5, decision A7).
// Covers the deterministic combine logic (separators, rstrip, missing/unsupported
// markers) + a dependency-wiring smoke. Live .docx/.pdf extraction is exercised
// by the manual Pre-chart smoke in the safety gate (building valid OOXML/PDF
// fixtures in a unit test isn't worth it — mammoth/pdf-parse are well-tested).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { extractOne, combineAttachments, buildCombinedAttachment } = require('../../src/pipeline/attachments')

function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  return p
}

test('combineAttachments: single file is verbatim + rstripped with a trailing newline', async () => {
  const f = tmpFile('note.md', '# Heading\n\nbody text\n\n\n')
  const out = await combineAttachments([f])
  assert.strictEqual(out, '# Heading\n\nbody text\n')
})

test('combineAttachments: second+ files get a --- <name> --- separator', async () => {
  const a = tmpFile('a.txt', 'alpha')
  const b = tmpFile('b.txt', 'beta')
  const out = await combineAttachments([a, b])
  // Three newlines between file 1 and the separator: one from the piece join,
  // two from the separator's leading "\n\n" — faithful to the Python original.
  assert.strictEqual(out, `alpha\n\n\n--- ${path.basename(b)} ---\n\nbeta\n`)
})

test('combineAttachments: missing input becomes an inline failure marker', async () => {
  const missing = path.join(os.tmpdir(), 'does-not-exist-xyz.md')
  const out = await combineAttachments([missing])
  assert.strictEqual(out, `> Failed to read ${path.basename(missing)}: file not found\n`)
})

test('extractOne: unsupported extension returns the skip marker', async () => {
  const f = tmpFile('data.xyz', 'whatever')
  assert.strictEqual(
    await extractOne(f),
    `> Skipped ${path.basename(f)} — unsupported format (.xyz)`
  )
})

test('extractOne: no extension reports "no extension"', async () => {
  const f = tmpFile('READMEnoext', 'whatever')
  assert.strictEqual(
    await extractOne(f),
    `> Skipped ${path.basename(f)} — unsupported format (no extension)`
  )
})

test('buildCombinedAttachment: empty list returns empty string (no temp file)', async () => {
  assert.strictEqual(await buildCombinedAttachment([]), '')
  assert.strictEqual(await buildCombinedAttachment(null), '')
})

test('buildCombinedAttachment: writes a temp .md and returns its path', async () => {
  const f = tmpFile('only.md', 'content here')
  const out = await buildCombinedAttachment([f])
  assert.ok(out.endsWith('.md'), 'returns a .md path')
  assert.strictEqual(fs.readFileSync(out, 'utf8'), 'content here\n')
  fs.rmSync(out, { force: true })
})

test('attachment extractors are wired: dep APIs match what extractOne calls', () => {
  // Guards against the deps drifting out from under the port (e.g. a pdf-parse
  // major bump changing the class API, as 1.x → 2.x did). Live .docx/.pdf
  // extraction is covered by the manual Pre-chart smoke.
  const mammoth = require('mammoth')
  assert.strictEqual(typeof mammoth.extractRawText, 'function', 'mammoth.extractRawText present')
  const { PDFParse } = require('pdf-parse')
  assert.strictEqual(typeof PDFParse, 'function', 'pdf-parse exports the PDFParse class')
  assert.strictEqual(typeof PDFParse.prototype.getText, 'function', 'PDFParse#getText present')
})
