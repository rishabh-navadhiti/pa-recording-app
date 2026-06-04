'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { runEngine } = require('../../src/engines/engineRunner')

// Minimal fake ctx for engine runner tests — no real DB or Electron needed.
function fakeCtx(llmResult = { code: 0, text: '', resultEvent: null, errText: '' }) {
  const statusUpdates = []
  return {
    log: () => {},
    config: { get: () => ({ enableIcd: true, enableCdi: false, soapModel: 'claude-test' }) },
    paths: { notesDir: '/tmp/notes' },
    db: null,  // null → skip all DB event calls
    llm: { runSkill: async () => llmResult },
    renderer: { send: () => {} },
    stores: {
      recordings: {
        updateStatus: (tag, s) => statusUpdates.push({ tag, s }),
        updatePatientStatus: (tag, f, s) => statusUpdates.push({ tag, f, s }),
      }
    },
    _statusUpdates: statusUpdates,
  }
}

function fakeCaseCtx() {
  return {
    caseId: 'case-1',
    caseTag: 'jane_doe',
    patientFolderName: null,
    doctor: { id: 'doc-1', name: 'Dr. Smith', specialty: '' },
    soapNoteMdPath: '/tmp/notes/Cases/x/soap.md',
    transcriptAbsPath: '/tmp/notes/Cases/x/transcript.md',
    templatePath: null,
    caseDir: '/tmp/notes/Cases/x',
  }
}

// A minimal engine descriptor for testing the runner boilerplate.
function fakeEngine(interpretResult = { ok: true }) {
  return {
    id: 'fake',
    skillId: 'fake-skill',
    jobKind: 'fake',
    stage: 'coding_icd',
    completesCase: false,
    model: () => 'claude-test',
    effort: null,
    gates: () => [],
    buildInput: () => ({ soapRel: 'Cases/x/soap.md' }),
    interpret: () => interpretResult,
    persist: () => {},
    render: () => null,
  }
}

// We need prompts.js to know about 'fake-skill' — easiest to use 'add-icd-codes' instead.
function icdEngine() {
  return require('../../src/engines/icd')
}

test('runEngine returns null when gate fires', async () => {
  const ctx = fakeCtx()
  const engine = { ...icdEngine(), gates: () => [{ reason: 'disabled' }] }
  const result = await runEngine(engine, ctx, fakeCaseCtx())
  assert.strictEqual(result, null)
})

test('runEngine calls llm.runSkill and returns interpret result', async () => {
  const llmResult = { code: 0, text: 'ICD codes added OK', resultEvent: null, errText: '' }
  const ctx = fakeCtx(llmResult)
  const engine = icdEngine()
  const caseCtx = fakeCaseCtx()
  caseCtx.soapNoteMdPath = '/tmp/notes/Cases/x/soap.md'
  const result = await runEngine(engine, ctx, caseCtx)
  assert.ok(result, 'should return interpret result')
  assert.strictEqual(result.ok, true)
})

test('runEngine returns null and continues on interpret error', async () => {
  const ctx = fakeCtx()
  const engine = { ...icdEngine(), interpret: () => { throw new Error('parse failed') } }
  const result = await runEngine(engine, ctx, fakeCaseCtx())
  // returns null but does not throw
  assert.strictEqual(result, null)
})

test('runEngine sends service-warning on MCP error for ICD', async () => {
  const warnings = []
  const ctx = fakeCtx({ code: 1, text: '', errText: 'Needs authentication: MCP connection error', resultEvent: null })
  ctx.renderer.send = (ch, data) => warnings.push({ ch, data })
  const result = await runEngine(icdEngine(), ctx, fakeCaseCtx())
  assert.ok(warnings.some(w => w.ch === 'service-warning' && w.data.title.includes('ICD')))
})
