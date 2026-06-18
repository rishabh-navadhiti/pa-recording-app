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

test('icd.interpret detects ICD_SKIPPED', () => {
  const result = icd.interpret({ code: 0, text: 'ICD_SKIPPED: no diagnoses found', errText: '' })
  assert.strictEqual(result.skipped, true)
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

// ---- registry --------------------------------------------------------------

test('registry exports [soap, icd, cdi] in order', () => {
  assert.strictEqual(registry.length, 3)
  assert.strictEqual(registry[0].id, 'soap')
  assert.strictEqual(registry[1].id, 'icd')
  assert.strictEqual(registry[2].id, 'cdi')
})
