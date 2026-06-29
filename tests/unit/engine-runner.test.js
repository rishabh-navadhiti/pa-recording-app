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

// ---- API-only engine branch (runLlm) ---------------------------------------

// A minimal API-only engine descriptor (exposes runLlm).
function apiEngine(runLlm) {
  return {
    id: 'em-score', skillId: 'em-score', jobKind: 'em_score', stage: 'scoring_em',
    label: 'E/M scoring', completesCase: false,
    model: () => 'unused-for-api', effort: 'high',
    gates: () => [],
    buildInput: () => ({ caseDir: '/tmp/notes/Cases/x' }),
    runLlm,
    interpret: () => ({ ok: true }),
    persist: () => {},
    render: () => null,
  }
}

test('runEngine uses runLlm (not runSkill) for an API engine and passes ctx.api', async () => {
  let runSkillCalled = false
  let seenOpts = null
  const ctx = fakeCtx()
  ctx.llm.runSkill = async () => { runSkillCalled = true; return { code: 0 } }
  ctx.api = { tag: 'anthropic-fake' }

  const engine = apiEngine(async (_input, _ctx, _caseCtx, opts) => {
    seenOpts = opts
    return { code: 0, text: '{"status":"ok"}', usage: { inputTokens: 5 } }
  })

  const result = await runEngine(engine, ctx, fakeCaseCtx())
  assert.strictEqual(runSkillCalled, false, 'CLI path must not run for an API engine')
  assert.ok(seenOpts, 'runLlm should be called')
  assert.strictEqual(seenOpts.provider, ctx.api, 'provider should be ctx.api')
  assert.strictEqual(seenOpts.model, 'claude-sonnet-4-6', 'pinned Anthropic model resolved')
  assert.deepStrictEqual(result, { ok: true })
})

test('runEngine treats runLlm isRateLimit as a usage-limit service-warning', async () => {
  const warnings = []
  const ctx = fakeCtx()
  ctx.api = {}
  ctx.renderer.send = (ch, data) => warnings.push({ ch, data })

  const engine = apiEngine(async () => ({ code: 1, text: '', errText: 'HTTP 429', isRateLimit: true, statusCode: 429, usage: {} }))
  await runEngine(engine, ctx, fakeCaseCtx())
  assert.ok(warnings.some(w => w.ch === 'service-warning' && /usage limit/i.test(w.data.title)))
})

test('runEngine surfaces an auth (401) failure for an API engine', async () => {
  const warnings = []
  const ctx = fakeCtx()
  ctx.api = {}
  ctx.renderer.send = (ch, data) => warnings.push({ ch, data })

  const engine = apiEngine(async () => ({ code: 1, text: '', errText: 'HTTP 401', statusCode: 401, usage: {} }))
  await runEngine(engine, ctx, fakeCaseCtx())
  assert.ok(warnings.some(w => w.ch === 'service-warning' && /API key/i.test(w.data.title)))
})
