'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { planChildCases, runCaseChain } = require('../../src/pipeline/chain')

// ---- planChildCases (pure) -------------------------------------------------

function sanitize(name) {
  if (!name) return null
  return name.trim().toLowerCase().replace(/\s+/g, '_')
}

test('planChildCases skips failed cases', () => {
  const cases = [
    { patient_name: 'Jane', soap_note_md: '/notes/jane.md', status: 'failed' },
    { patient_name: 'John', soap_note_md: '/notes/john.md', status: 'ok' },
  ]
  const existsFn = (p) => p.includes('john')  // john.md exists, jane.md doesn't matter (status=failed)
  const planned = planChildCases(cases, '/notes/Cases', '2026-06-04', sanitize, existsFn)
  assert.strictEqual(planned.length, 1)
  assert.strictEqual(planned[0].slug, 'john')
})

test('planChildCases skips cases where soap_note_md is missing on disk', () => {
  const cases = [
    { patient_name: 'Jane', soap_note_md: '/notes/jane.md', status: 'ok' },
  ]
  const existsFn = () => false  // file doesn't exist
  const planned = planChildCases(cases, '/notes/Cases', '2026-06-04', sanitize, existsFn)
  assert.strictEqual(planned.length, 0)
})

test('planChildCases handles slug collisions', () => {
  const cases = [
    { patient_name: 'John Smith', soap_note_md: '/notes/a.md', status: 'ok' },
    { patient_name: 'John Smith', soap_note_md: '/notes/b.md', status: 'ok' },
  ]
  const usedFolders = new Set()
  const existsFn = (p) => {
    if (p.endsWith('.md')) return true  // soap files exist
    if (usedFolders.has(p)) return true  // folder collision
    usedFolders.add(p)
    return false
  }
  const planned = planChildCases(cases, '/session', '2026-06-04', sanitize, existsFn)
  assert.strictEqual(planned.length, 2)
  assert.notStrictEqual(planned[0].folderName, planned[1].folderName, 'slugs should be deduplicated')
})

test('planChildCases builds correct folder names', () => {
  const cases = [
    { patient_name: 'Jane Doe', soap_note_md: '/notes/jane.md', status: 'ok' },
  ]
  const existsFn = (p) => p.endsWith('.md')
  const planned = planChildCases(cases, '/session', '2026-06-04', sanitize, existsFn)
  assert.strictEqual(planned[0].slug, 'doe')  // sanitize takes last word
  assert.ok(planned[0].folderName.includes('2026-06-04'))
  assert.ok(planned[0].targetDir.startsWith('/session'))
})

// ---- runCaseChain (with fakes) ---------------------------------------------

function fakeCtx(llmText = '') {
  const statusLog = []
  return {
    log: () => {},
    config: { get: () => ({ enableIcd: true, enableCdi: false, soapModel: 'test' }) },
    paths: { notesDir: os.tmpdir() },
    db: null,
    llm: { runSkill: async () => ({ code: 0, text: llmText, resultEvent: null, errText: '' }) },
    renderer: { send: () => {} },
    platform: { hideInternal: () => {} },
    stores: {
      session: { get: () => ({ sessionId: 'sess-1', doctorId: 'doc-1', dir: null }) },
      recordings: {
        updateStatus: (t, s) => statusLog.push({ t, s }),
        updatePatientStatus: (t, f, s) => statusLog.push({ t, f, s }),
        setCdi: () => {},
        setPatients: () => {},
      }
    },
    _statusLog: statusLog,
  }
}

test('runCaseChain calls spawnDocx for the SOAP note', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-'))
  const soapMd = path.join(tmpDir, 'soap.md')
  fs.writeFileSync(soapMd, '# SOAP Note')
  try {
    const docxCalls = []
    const ctx = fakeCtx()
    await runCaseChain(ctx, {
      caseId: 'c1', caseTag: 'jane', patientFolderName: null,
      soapNoteMdPath: soapMd, caseDir: tmpDir,
      doctor: { id: 'doc-1', name: 'Dr. Smith', specialty: '' },
    }, (mdPath, tag, folder, id) => docxCalls.push(mdPath))
    assert.ok(docxCalls.includes(soapMd), 'should call spawnDocx with the SOAP md path')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('runCaseChain does not call CDI docx when CDI is disabled (gate fires)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-nodci-'))
  const soapMd = path.join(tmpDir, 'soap.md')
  fs.writeFileSync(soapMd, '# SOAP')
  try {
    const docxCalls = []
    const ctx = fakeCtx()
    ctx.config.get = () => ({ enableIcd: true, enableCdi: false })
    await runCaseChain(ctx, {
      caseId: 'c2', caseTag: 'john', patientFolderName: null,
      soapNoteMdPath: soapMd, caseDir: tmpDir,
      doctor: { id: 'doc-1', specialty: '' },
    }, (mdPath) => docxCalls.push(mdPath))
    // Only soap docx should be called, not CDI (CDI gate blocked)
    assert.strictEqual(docxCalls.length, 1)
    assert.strictEqual(docxCalls[0], soapMd)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
