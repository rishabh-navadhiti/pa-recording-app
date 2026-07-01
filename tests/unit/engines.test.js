'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const soap = require('../../src/engines/soap')
const icd  = require('../../src/engines/icd')
const cdi  = require('../../src/engines/cdi')
const { synthesizeManifestFromDisk } = require('../../src/engines/cdi')
const emScore = require('../../src/engines/emScore')
const { synthesizeEmFromDisk } = require('../../src/engines/emScore')
const patientSummary = require('../../src/engines/patientSummary')
const { synthesizePatientSummaryFromDisk } = require('../../src/engines/patientSummary')
const registry = require('../../src/engines/registry')

// ---- soap descriptor -------------------------------------------------------

test('soap.gates always returns empty (no gate)', () => {
  assert.deepStrictEqual(soap.gates({}, {}), [])
})

test('soap.completesCase is true', () => {
  assert.strictEqual(soap.completesCase, true)
})

test('soap.interpret parses a valid manifest', () => {
  const manifest = JSON.stringify({
    schema_version: 1, skill: 'generate-note', status: 'ok',
    multi_patient: false, cases: [{ patient_name: 'Jane Doe', status: 'ok' }]
  })
  const result = soap.interpret({ text: manifest, code: 0, errText: '' })
  assert.ok(result, 'should parse manifest')
  assert.strictEqual(result.status, 'ok')
})

test('soap.interpret returns null when text has no manifest', () => {
  const result = soap.interpret({ text: 'Claude usage limit reached.', code: 1, errText: '' })
  assert.strictEqual(result, null)
})

// ---- icd descriptor -------------------------------------------------------

test('icd.gates returns skip when enableIcd is false', () => {
  const ctx = { config: { get: () => ({ enableIcd: false }) } }
  const skips = icd.gates(ctx, {})
  assert.strictEqual(skips.length, 1)
  assert.match(skips[0].reason, /disabled/)
})

test('icd.gates returns [] when enableIcd is true', () => {
  const ctx = { config: { get: () => ({ enableIcd: true }) } }
  assert.deepStrictEqual(icd.gates(ctx, {}), [])
})

test('icd.interpret ok when code=0', () => {
  const result = icd.interpret({ code: 0, text: 'ICD codes added.', errText: '' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.skipped, false)
  assert.strictEqual(result.rateLimited, false)
})

test('icd.interpret reads status:skipped from the manifest', () => {
  const manifest = JSON.stringify({ schema_version: 1, skill: 'add-icd-codes', status: 'skipped', codes_added: 0 })
  const result = icd.interpret({ code: 0, text: manifest, errText: '' })
  assert.strictEqual(result.skipped, true)
  assert.strictEqual(result.ok, false)
})

test('icd.interpret reads codes_added + flagged from an ok manifest', () => {
  const manifest = JSON.stringify({ schema_version: 1, skill: 'add-icd-codes', status: 'ok', codes_added: 3, flagged: 1 })
  const result = icd.interpret({ code: 0, text: manifest, errText: '' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.codesAdded, 3)
  assert.strictEqual(result.flagged, 1)
})

test('icd.interpret detects rate limit', () => {
  const result = icd.interpret({ code: 1, text: '', errText: 'Claude AI usage limit reached' })
  assert.strictEqual(result.rateLimited, true)
})

// ---- cdi descriptor -------------------------------------------------------

test('cdi.gates: gate 1 fires when enableCdi is false', () => {
  const ctx = { config: { get: () => ({ enableCdi: false }) } }
  const skips = cdi.gates(ctx, { doctor: { specialty: 'orthopedics' } })
  assert.strictEqual(skips.length, 1)
  assert.match(skips[0].reason, /disabled/)
})

test('cdi.gates: gate 2 fires when specialty not set', () => {
  const ctx = { config: { get: () => ({ enableCdi: true }) } }
  const skips = cdi.gates(ctx, { doctor: { name: 'Dr. Smith', specialty: '' } })
  assert.strictEqual(skips.length, 1)
  assert.match(skips[0].reason, /specialty not set/)
})

test('cdi.gates: gate 3 fires when standards file missing', () => {
  const ctx = {
    config: { get: () => ({ enableCdi: true }) },
    paths: { notesDir: '/nonexistent/notes' },
  }
  const skips = cdi.gates(ctx, { doctor: { specialty: 'orthopedics' } })
  assert.strictEqual(skips.length, 1)
  assert.match(skips[0].reason, /unsupported specialty/)
})

test('cdi.interpret parses a valid CDI manifest', () => {
  const manifest = JSON.stringify({
    schema_version: 1, skill: 'cdi-review', status: 'ok',
    flag_count: 2, quality_score: 75, clinician_approval_required: false,
    icd_validated: true,
  })
  const ctx = { log: () => {} }
  const result = cdi.interpret({ text: manifest, code: 0, errText: '' }, ctx, {})
  assert.ok(result.manifest, 'should have manifest')
  assert.strictEqual(result.recovered, false)
  assert.strictEqual(result.rateLimited, false)
})

test('cdi.interpret returns skippedReason on status=skipped manifest', () => {
  const manifest = JSON.stringify({
    schema_version: 1, skill: 'cdi-review', status: 'skipped',
    skipped_reason: 'specialty not configured',
  })
  const ctx = { log: () => {} }
  const result = cdi.interpret({ text: manifest, code: 0, errText: '' }, ctx, {})
  assert.strictEqual(result.manifest, null)
  assert.strictEqual(result.skippedReason, 'specialty not configured')
})

// ---- CDI filesystem fallback (the load-bearing reliability test) -----------

test('synthesizeManifestFromDisk returns null when json file absent', () => {
  const result = synthesizeManifestFromDisk('/nonexistent/caseDir', () => {})
  assert.strictEqual(result, null)
})

test('synthesizeManifestFromDisk recovers from a valid _cdi.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdi-test-'))
  try {
    // Write a fake _cdi.json anchored to a fake soap note name.
    const fakeCdiJson = {
      summary: {
        overall_quality_score: 80,
        flag_counts: { critical: 1, high: 0, medium: 1, low: 0 },
        medical_necessity_status: 'supported',
        claim_defense_readiness: 'adequate',
        clinician_approval_required: false,
      },
      flags: [
        { type: 'critical', title: 'Missing specificity', body: 'Add laterality' }
      ],
      code_validation: true,
    }
    const stem = path.basename(tmpDir)
    fs.writeFileSync(path.join(tmpDir, `${stem}_soap_note.md`), '# SOAP Note\n')
    fs.writeFileSync(path.join(tmpDir, `${stem}_cdi.json`), JSON.stringify(fakeCdiJson))
    fs.writeFileSync(path.join(tmpDir, `${stem}_cdi.md`), '# CDI Review\n')

    const result = synthesizeManifestFromDisk(tmpDir, () => {})
    assert.ok(result, 'should synthesize manifest')
    assert.strictEqual(result.status, 'ok')
    assert.strictEqual(result.flag_count, 1)
    assert.strictEqual(result.quality_score, 80)
    assert.strictEqual(result.icd_validated, true)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('cdi.interpret falls back to disk when manifest line missing (rate-limit scenario)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdi-fallback-'))
  try {
    const stem = path.basename(tmpDir)
    fs.writeFileSync(path.join(tmpDir, `${stem}_soap_note.md`), '# SOAP Note\n')
    fs.writeFileSync(path.join(tmpDir, `${stem}_cdi.json`), JSON.stringify({
      summary: {
        overall_quality_score: 72, flag_counts: {},
        medical_necessity_status: null, claim_defense_readiness: null,
        clinician_approval_required: false,
      },
      flags: [{ type: 'high', title: 'Missing code', body: 'detail' }],
      code_validation: false,
    }))

    const ctx = { log: () => {} }
    // Simulate a 429-truncated run: no manifest line in the output
    const result = cdi.interpret(
      { text: 'Claude usage limit reached. Please try again.', code: 1, errText: '' },
      ctx,
      { caseDir: tmpDir }
    )
    assert.ok(result.manifest, 'should recover manifest from disk')
    assert.strictEqual(result.recovered, true, 'should mark as recovered')
    assert.strictEqual(result.manifest.flag_count, 1)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---- em-score descriptor ---------------------------------------------------

test('emScore.gates returns skip when enableEmScore is false', () => {
  const ctx = { config: { get: () => ({ enableEmScore: false }) } }
  const skips = emScore.gates(ctx, {})
  assert.strictEqual(skips.length, 1)
  assert.match(skips[0].reason, /disabled/)
})

test('emScore.gates returns [] when enableEmScore is true (no specialty gate)', () => {
  const ctx = { config: { get: () => ({ enableEmScore: true }) } }
  assert.deepStrictEqual(emScore.gates(ctx, { doctor: { specialty: '' } }), [])
})

test('emScore.interpret parses a valid em-score manifest', () => {
  const manifest = JSON.stringify({
    schema_version: 1, skill: 'em-score', status: 'ok',
    json_path: '/x/y_em.json', predicted_em_level: '99214',
    predicted_complexity: 'moderate', downcode_risk: 'low',
  })
  const ctx = { log: () => {} }
  const result = emScore.interpret({ text: manifest, code: 0, errText: '' }, ctx, {})
  assert.ok(result.manifest, 'should have manifest')
  assert.strictEqual(result.manifest.predicted_em_level, '99214')
  assert.strictEqual(result.recovered, false)
})

test('emScore.interpret returns skippedReason on status=skipped manifest', () => {
  const manifest = JSON.stringify({
    schema_version: 1, skill: 'em-score', status: 'skipped',
    skipped_reason: 'not an office E/M encounter',
  })
  const ctx = { log: () => {} }
  const result = emScore.interpret({ text: manifest, code: 0, errText: '' }, ctx, {})
  assert.strictEqual(result.manifest, null)
  assert.strictEqual(result.skippedReason, 'not an office E/M encounter')
})

test('synthesizeEmFromDisk returns null when json file absent', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-test-'))
  try {
    assert.strictEqual(synthesizeEmFromDisk(tmpDir, () => {}), null)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('synthesizeEmFromDisk recovers from a valid _em.json (rate-limit scenario)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-test-'))
  try {
    fs.writeFileSync(path.join(tmpDir, 'patient_2026-06-11_soap_note.md'), '# note')
    fs.writeFileSync(path.join(tmpDir, 'patient_2026-06-11_em.json'), JSON.stringify({
      predicted_em_level: '99213', predicted_complexity: 'low', downcode_risk: 'none',
    }))
    const m = synthesizeEmFromDisk(tmpDir, () => {})
    assert.ok(m, 'should recover a manifest')
    assert.strictEqual(m.skill, 'em-score')
    assert.strictEqual(m.status, 'ok')
    assert.strictEqual(m.predicted_em_level, '99213')
    assert.ok(m.json_path.endsWith('_em.json'))
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---- patient-summary descriptor --------------------------------------------

test('patientSummary.gates returns skip when enablePatientSummary is false', () => {
  const ctx = { config: { get: () => ({ enablePatientSummary: false }) } }
  const skips = patientSummary.gates(ctx, {})
  assert.strictEqual(skips.length, 1)
  assert.match(skips[0].reason, /disabled/)
})

test('patientSummary.gates returns [] when enablePatientSummary is true', () => {
  const ctx = { config: { get: () => ({ enablePatientSummary: true }) } }
  assert.deepStrictEqual(patientSummary.gates(ctx, {}), [])
})

test('patientSummary.interpret parses a valid manifest', () => {
  const manifest = JSON.stringify({
    schema_version: 1, skill: 'patient-summary', status: 'ok',
    json_path: '/x/y_patient_summary.json', reading_level: 'grade 6',
  })
  const ctx = { log: () => {} }
  const result = patientSummary.interpret({ text: manifest, code: 0, errText: '' }, ctx, {})
  assert.ok(result.manifest, 'should have manifest')
  assert.strictEqual(result.manifest.reading_level, 'grade 6')
})

test('synthesizePatientSummaryFromDisk recovers from a valid _patient_summary.json', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-test-'))
  try {
    fs.writeFileSync(path.join(tmpDir, 'patient_2026-06-11_soap_note.md'), '# note')
    fs.writeFileSync(path.join(tmpDir, 'patient_2026-06-11_patient_summary.json'), JSON.stringify({
      reading_level: 'grade 6', sections: { whats_going_on: 'x' },
    }))
    const m = synthesizePatientSummaryFromDisk(tmpDir, () => {})
    assert.ok(m, 'should recover a manifest')
    assert.strictEqual(m.skill, 'patient-summary')
    assert.strictEqual(m.status, 'ok')
    assert.strictEqual(m.reading_level, 'grade 6')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ---- em-score / patient-summary runLlm (API-only path) ---------------------

const CLAUDE_DIR    = path.join(__dirname, '../../notes-claude')
const STANDARDS_DIR = path.join(__dirname, '../../notes-claude/standards')

function apiCtx() {
  return { log: () => {}, paths: { claudeDir: CLAUDE_DIR } }
}
function fakeProvider(result) {
  return { runSingleCall: async () => result }
}
function caseWithNote() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-api-'))
  fs.writeFileSync(path.join(dir, `${path.basename(dir)}_soap_note.md`), '# SOAP\nKnee pain, started lisinopril.')
  return dir
}

test('emScore.runLlm writes _em.json and returns an ok manifest', async () => {
  const dir = caseWithNote()
  try {
    const emObj = { meta: {}, predicted_em_level: '99214', predicted_complexity: 'moderate', downcode_risk: 'low' }
    const provider = fakeProvider({ ok: true, text: JSON.stringify(emObj), rawUsage: { input_tokens: 10, output_tokens: 20 }, durationMs: 5 })
    const r = await emScore.runLlm(
      { caseDir: dir, specialty: 'orthopedics', standardsDir: STANDARDS_DIR },
      apiCtx(), { caseTag: path.basename(dir), doctor: { name: 'Dr. Smith' } }, { model: 'claude-sonnet-4-6', provider })

    assert.strictEqual(r.code, 0)
    assert.ok(fs.existsSync(path.join(dir, `${path.basename(dir)}_em.json`)), 'wrote _em.json')
    const manifest = JSON.parse(r.text)
    assert.strictEqual(manifest.skill, 'em-score')
    assert.strictEqual(manifest.status, 'ok')
    assert.strictEqual(manifest.predicted_em_level, '99214')
    assert.strictEqual(r.usage.inputTokens, 10)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('emScore.runLlm maps skipped_reason JSON to a skipped manifest', async () => {
  const dir = caseWithNote()
  try {
    const emObj = { meta: {}, predicted_em_level: null, skipped_reason: 'procedure op-note, not an office E/M' }
    const provider = fakeProvider({ ok: true, text: JSON.stringify(emObj), rawUsage: {}, durationMs: 1 })
    const r = await emScore.runLlm(
      { caseDir: dir, specialty: '', standardsDir: STANDARDS_DIR },
      apiCtx(), { caseTag: path.basename(dir) }, { model: 'm', provider })
    const manifest = JSON.parse(r.text)
    assert.strictEqual(manifest.status, 'skipped')
    assert.strictEqual(manifest.skipped_reason, 'procedure op-note, not an office E/M')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('emScore.runLlm returns note_not_found when no SOAP note present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-api-'))
  try {
    const r = await emScore.runLlm(
      { caseDir: dir, specialty: '', standardsDir: STANDARDS_DIR },
      apiCtx(), {}, { model: 'm', provider: fakeProvider({ ok: true, text: '{}' }) })
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.errText, 'note_not_found')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('emScore.runLlm writes _em.raw.txt and fails on unparseable JSON', async () => {
  const dir = caseWithNote()
  try {
    const provider = fakeProvider({ ok: true, text: 'sorry, no JSON here', rawUsage: {}, durationMs: 1 })
    const r = await emScore.runLlm(
      { caseDir: dir, specialty: '', standardsDir: STANDARDS_DIR },
      apiCtx(), { caseTag: path.basename(dir) }, { model: 'm', provider })
    assert.strictEqual(r.code, 1)
    assert.match(r.errText, /json parse failed/)
    assert.ok(fs.existsSync(path.join(dir, `${path.basename(dir)}_em.raw.txt`)), 'wrote raw debug file')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('emScore.runLlm surfaces an API rate limit (429) as isRateLimit', async () => {
  const dir = caseWithNote()
  try {
    const provider = fakeProvider({ ok: false, statusCode: 429, errText: 'HTTP 429', rawUsage: {}, durationMs: 1 })
    const r = await emScore.runLlm(
      { caseDir: dir, specialty: '', standardsDir: STANDARDS_DIR },
      apiCtx(), { caseTag: path.basename(dir) }, { model: 'm', provider })
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.isRateLimit, true)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('patientSummary.runLlm writes _patient_summary.json and returns an ok manifest', async () => {
  const dir = caseWithNote()
  try {
    const psObj = { meta: {}, reading_level: 'grade 6', sections: { whats_going_on: 'Your knee hurts.' } }
    const provider = fakeProvider({ ok: true, text: JSON.stringify(psObj), rawUsage: { input_tokens: 8, output_tokens: 12 }, durationMs: 3 })
    const r = await patientSummary.runLlm(
      { caseDir: dir }, apiCtx(), { caseTag: path.basename(dir), doctor: { name: 'Dr. Smith' } },
      { model: 'claude-sonnet-4-6', provider })
    assert.strictEqual(r.code, 0)
    assert.ok(fs.existsSync(path.join(dir, `${path.basename(dir)}_patient_summary.json`)))
    const manifest = JSON.parse(r.text)
    assert.strictEqual(manifest.skill, 'patient-summary')
    assert.strictEqual(manifest.status, 'ok')
    assert.strictEqual(manifest.reading_level, 'grade 6')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---- icd runLlm (API Phase A + local-codeset Phase B/C) --------------------

const icdLookup = require('../../src/icd/lookup')
const ICD_DB_OK = icdLookup.isAvailable()
const icdOpts   = { skip: ICD_DB_OK ? false : 'local ICD codeset not available' }

test('icd.runLlm validates candidates against the local codeset and appends the table', icdOpts, async () => {
  const dir = caseWithNote()
  try {
    const notePath = path.join(dir, `${path.basename(dir)}_soap_note.md`)
    const candidates = { candidates: [
      { diagnosis: 'Low back pain', code: 'M54.50', description: 'Low back pain, unspecified', search_terms: 'low back pain unspecified' },
    ], first_listed: 'M54.50' }
    const provider = fakeProvider({ ok: true, text: JSON.stringify(candidates), rawUsage: { input_tokens: 12, output_tokens: 8 }, durationMs: 4 })
    const r = await icd.runLlm({ soapNoteMdPath: notePath, caseDir: dir }, apiCtx(), { caseTag: path.basename(dir) }, { model: 'claude-sonnet-4-6', provider })

    assert.strictEqual(r.code, 0)
    const manifest = JSON.parse(r.text)
    assert.strictEqual(manifest.skill, 'add-icd-codes')
    assert.strictEqual(manifest.status, 'ok')
    assert.strictEqual(manifest.codes_added, 1)
    const note = fs.readFileSync(notePath, 'utf8')
    assert.match(note, /## ICD-10-CM Codes/)
    assert.match(note, /M54\.50/)
    assert.ok(fs.existsSync(path.join(dir, `${path.basename(dir)}_icd.json`)), 'wrote _icd.json')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('icd.runLlm reports skipped + leaves the note unchanged when no codeable diagnosis', icdOpts, async () => {
  const dir = caseWithNote()
  try {
    const notePath = path.join(dir, `${path.basename(dir)}_soap_note.md`)
    const before   = fs.readFileSync(notePath, 'utf8')
    const provider = fakeProvider({ ok: true, text: JSON.stringify({ candidates: [], first_listed: null }), rawUsage: {}, durationMs: 1 })
    const r = await icd.runLlm({ soapNoteMdPath: notePath, caseDir: dir }, apiCtx(), { caseTag: path.basename(dir) }, { model: 'm', provider })
    assert.strictEqual(JSON.parse(r.text).status, 'skipped')
    assert.strictEqual(fs.readFileSync(notePath, 'utf8'), before, 'note unchanged when nothing to code')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('icd.runLlm returns note_not_found when no SOAP note present', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'icd-api-'))
  try {
    const r = await icd.runLlm({ soapNoteMdPath: null, caseDir: dir }, apiCtx(), {}, { model: 'm', provider: fakeProvider({ ok: true, text: '{}' }) })
    assert.strictEqual(r.code, 1)
    assert.strictEqual(r.errText, 'note_not_found')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// ---- registry --------------------------------------------------------------

test('registry exports [soap, icd, cdi, em-score, patient-summary] in order', () => {
  assert.strictEqual(registry.length, 5)
  assert.strictEqual(registry[0].id, 'soap')
  assert.strictEqual(registry[1].id, 'icd')
  assert.strictEqual(registry[2].id, 'cdi')
  assert.strictEqual(registry[3].id, 'em-score')
  assert.strictEqual(registry[4].id, 'patient-summary')
})
