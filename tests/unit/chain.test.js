'use strict'

// planChildCases (pure) + runCaseChain tests.
//
// NOTE: an earlier version of this file hung the runner — the cause was NOT
// node:test but a bad fixture: an existsFn of `(p) => p.includes('john')` also
// matched the candidate child folder, so planChildCases's collision while-loop
// span forever. existsFn fixtures here match the soap .md path EXACTLY.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Stub docx.spawnDocxConversion BEFORE requiring chain so runCaseChain never
// spawns the real md_to_docx.py Python process.
const docx = require('../../src/pipeline/docx')
const _docxCalls = []
docx.spawnDocxConversion = (mdPath) => { _docxCalls.push(mdPath) }

const { planChildCases, runCaseChain } = require('../../src/pipeline/chain')

const sanitize = (n) => (n ? n.trim().toLowerCase().replace(/\s+/g, '_') : null)

// ---- planChildCases (pure) -------------------------------------------------

test('planChildCases skips failed cases', () => {
  const cases = [
    { patient_name: 'Jane', soap_note_md: '/notes/jane.md', status: 'failed' },
    { patient_name: 'John', soap_note_md: '/notes/john.md', status: 'ok' },
  ]
  // EXACT match — a substring match would also match the child folder and spin
  // the collision loop forever.
  const planned = planChildCases(cases, '/notes/Cases', '2026-06-04', sanitize, (p) => p === '/notes/john.md')
  assert.strictEqual(planned.length, 1)
  assert.strictEqual(planned[0].slug, 'john')
})

test('planChildCases skips cases where soap_note_md is missing on disk', () => {
  const planned = planChildCases(
    [{ patient_name: 'Jane', soap_note_md: '/notes/jane.md', status: 'ok' }],
    '/notes/Cases', '2026-06-04', sanitize, () => false)
  assert.strictEqual(planned.length, 0)
})

test('planChildCases handles slug collisions', () => {
  const cases = [
    { patient_name: 'John Smith', soap_note_md: '/notes/a.md', status: 'ok' },
    { patient_name: 'John Smith', soap_note_md: '/notes/b.md', status: 'ok' },
  ]
  const used = new Set()
  const existsFn = (p) => { if (p.endsWith('.md')) return true; if (used.has(p)) return true; used.add(p); return false }
  const planned = planChildCases(cases, '/session', '2026-06-04', sanitize, existsFn)
  assert.strictEqual(planned.length, 2)
  assert.notStrictEqual(planned[0].folderName, planned[1].folderName, 'slugs should be deduplicated')
})

test('planChildCases builds correct folder names', () => {
  // sanitizeName keeps the FULL name (jane_doe); extractLastname is last-word.
  const planned = planChildCases(
    [{ patient_name: 'Jane Doe', soap_note_md: '/notes/jane.md', status: 'ok' }],
    '/session', '2026-06-04', sanitize, (p) => p.endsWith('.md'))
  assert.strictEqual(planned[0].slug, 'jane_doe')
  assert.ok(planned[0].folderName.includes('2026-06-04'))
  assert.strictEqual(planned[0].targetDir, path.join('/session', planned[0].folderName))
})

// ---- runCaseChain (with fakes) ---------------------------------------------

function fakeCtx() {
  return {
    log: () => {},
    config: { get: () => ({ enableIcd: true, enableCdi: false, soapModel: 'test' }) },
    paths: { notesDir: os.tmpdir() },
    db: null,
    llm: { runSkill: async () => ({ code: 0, text: '', resultEvent: null, errText: '' }) },
    renderer: { send: () => {} },
    platform: { hideInternal: () => {} },
    stores: {
      session: { get: () => ({ sessionId: 'sess-1', doctorId: 'doc-1', dir: null }) },
      recordings: { updateStatus: () => {}, updatePatientStatus: () => {}, setCdi: () => {}, setPatients: () => {} },
    },
  }
}

test('runCaseChain calls spawnDocx for the SOAP note', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-'))
  const soap = path.join(tmp, 'soap.md'); fs.writeFileSync(soap, '# SOAP')
  try {
    _docxCalls.length = 0
    await runCaseChain(fakeCtx(), { caseId: 'c1', caseTag: 'jane', patientFolderName: null, soapNoteMdPath: soap, caseDir: tmp, doctor: { id: 'doc-1', name: 'Dr', specialty: '' } })
    assert.ok(_docxCalls.includes(soap), 'should call spawnDocx with the SOAP md path')
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('runCaseChain does not call CDI docx when CDI is disabled (gate fires)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-nocdi-'))
  const soap = path.join(tmp, 'soap.md'); fs.writeFileSync(soap, '# SOAP')
  try {
    _docxCalls.length = 0
    await runCaseChain(fakeCtx(), { caseId: 'c2', caseTag: 'john', patientFolderName: null, soapNoteMdPath: soap, caseDir: tmp, doctor: { id: 'doc-1', specialty: '' } })
    assert.strictEqual(_docxCalls.length, 1, 'only soap docx, not CDI (gate blocked)')
    assert.strictEqual(_docxCalls[0], soap)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
