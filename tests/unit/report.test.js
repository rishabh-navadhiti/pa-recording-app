'use strict'

// Unit tests for src/pipeline/report.js — the pure, Electron-free parts:
//   resolveFileStem · assemblePaData · buildReportHtml
// The printToPDF path needs a live Chromium and is exercised manually (npm start),
// not here. These cover the data-assembly + injection contract the template relies on.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { resolveFileStem, assemblePaData, buildReportHtml } = require('../../src/pipeline/report')

const REF_DIR = path.join(__dirname, '../../docs/notes/cdi-ui-reference')
const TEMPLATE = path.join(__dirname, '../../templates/engine-report/cockpit.html')

function mkTmpCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'))
  return dir
}

// Pull the injected JSON back out of the #pa-data script block and parse it.
function extractInjected(html) {
  const open = '<script id="pa-data" type="application/json">'
  const i = html.indexOf(open)
  assert.ok(i !== -1, 'pa-data script seam present')
  const start = i + open.length
  const end = html.indexOf('</script>', start)
  assert.ok(end !== -1, 'pa-data script closes')
  return JSON.parse(html.slice(start, end))
}

test('resolveFileStem prefers the *_soap_note.md stem over the folder name', () => {
  const dir = mkTmpCase()
  try {
    // Folder is jessica_*, but the soap note stem is the date — stem must follow the note.
    const caseDir = path.join(dir, 'jessica_2026-06-19')
    fs.mkdirSync(caseDir)
    fs.writeFileSync(path.join(caseDir, '2026-06-19_soap_note.md'), '# note')
    assert.equal(resolveFileStem(caseDir), '2026-06-19')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveFileStem falls back to the folder basename when no soap note', () => {
  const dir = mkTmpCase()
  try {
    const caseDir = path.join(dir, 'amy_2026-06-12')
    fs.mkdirSync(caseDir)
    assert.equal(resolveFileStem(caseDir), 'amy_2026-06-12')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('assemblePaData returns null paData when no engine JSON exists', () => {
  const dir = mkTmpCase()
  try {
    const caseDir = path.join(dir, 'empty_2026-06-12')
    fs.mkdirSync(caseDir)
    fs.writeFileSync(path.join(caseDir, 'empty_2026-06-12_soap_note.md'), '# note')
    const { paData, present } = assemblePaData(caseDir, () => {})
    assert.equal(paData, null)
    assert.deepEqual(present, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('assemblePaData assembles {meta,cdi,em,patient_summary} from present engine JSONs', () => {
  const dir = mkTmpCase()
  try {
    const caseDir = path.join(dir, 'amy_2026-06-12')
    fs.mkdirSync(caseDir)
    fs.writeFileSync(path.join(caseDir, 'amy_2026-06-12_soap_note.md'), '# note')
    // Copy the three real-run sample JSONs in under the stem.
    for (const [src, dst] of [
      ['amy_2026-06-12_cdi.json', 'amy_2026-06-12_cdi.json'],
      ['amy_2026-06-12_em.json', 'amy_2026-06-12_em.json'],
      ['amy_2026-06-12_patient_summary.json', 'amy_2026-06-12_patient_summary.json'],
    ]) {
      fs.copyFileSync(path.join(REF_DIR, src), path.join(caseDir, dst))
    }
    const { paData, present, stem } = assemblePaData(caseDir, () => {})
    assert.equal(stem, 'amy_2026-06-12')
    assert.deepEqual(present.sort(), ['cdi', 'em', 'patient_summary'])
    assert.equal(paData.meta.patient, 'Amy Berger')
    assert.equal(paData.meta.specialty, 'orthopedics') // meta sourced from CDI (richest)
    assert.ok(Array.isArray(paData.cdi.flags) && paData.cdi.flags.length > 0)
    assert.equal(paData.em.predicted_em_level, '99214')
    assert.ok(paData.patient_summary.sections)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('assemblePaData works with only one engine present (em-only)', () => {
  const dir = mkTmpCase()
  try {
    const caseDir = path.join(dir, 'amy_2026-06-12')
    fs.mkdirSync(caseDir)
    fs.writeFileSync(path.join(caseDir, 'amy_2026-06-12_soap_note.md'), '# note')
    fs.copyFileSync(path.join(REF_DIR, 'amy_2026-06-12_em.json'), path.join(caseDir, 'amy_2026-06-12_em.json'))
    const { paData, present } = assemblePaData(caseDir, () => {})
    assert.deepEqual(present, ['em'])
    assert.deepEqual(paData.cdi, {})
    assert.deepEqual(paData.patient_summary, {})
    assert.equal(paData.meta.patient, 'Amy Berger') // meta falls back to em.meta
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('buildReportHtml injects PA_DATA into the seam and removes the placeholder', () => {
  const template = fs.readFileSync(TEMPLATE, 'utf8')
  const cdi = JSON.parse(fs.readFileSync(path.join(REF_DIR, 'amy_2026-06-12_cdi.json'), 'utf8'))
  const em  = JSON.parse(fs.readFileSync(path.join(REF_DIR, 'amy_2026-06-12_em.json'), 'utf8'))
  const ps  = JSON.parse(fs.readFileSync(path.join(REF_DIR, 'amy_2026-06-12_patient_summary.json'), 'utf8'))
  const paData = { meta: cdi.meta, cdi, em, patient_summary: ps }

  const html = buildReportHtml(template, paData)

  assert.equal(html.indexOf('__PA_DATA_JSON__'), -1, 'placeholder fully replaced')
  // Round-trips: the escaped JSON decodes back to the exact object.
  assert.deepEqual(extractInjected(html), paData)
  // The render layer + section anchors survived the copy from the scroller.
  assert.ok(html.includes('id="section-cdi"'))
  assert.ok(html.includes('id="section-em"'))
  assert.ok(html.includes('id="section-patient"'))
  assert.ok(html.includes('function renderCDI'))
})

test('buildReportHtml keeps the template free of hardcoded case values; the 99215 lives only in injected data', () => {
  const template = fs.readFileSync(TEMPLATE, 'utf8')
  // The template alone must not hardcode the Amy-Berger billing story.
  assert.equal(template.indexOf('.KS15'), -1, 'no .KS15 placeholder baked into the template')
  assert.equal(template.indexOf('99215'), -1, 'no hardcoded 99215 in the template')
  assert.equal(template.indexOf('Amy'), -1, 'no hardcoded patient name in the template')

  // With em data that has no billed code, the injected JSON simply omits it —
  // the template's data-driven logic shows the predicted level alone.
  const paData = { meta: { patient: 'Test Pt' }, cdi: {}, em: { predicted_em_level: '99213', billed_em_code: null }, patient_summary: {} }
  const html = buildReportHtml(template, paData)
  assert.equal(html.indexOf('__PA_DATA_JSON__'), -1)
  assert.deepEqual(extractInjected(html), paData)
})

test('buildReportHtml escapes </script> and angle brackets in note text so the seam cannot break out', () => {
  const template = fs.readFileSync(TEMPLATE, 'utf8')
  const paData = {
    meta: { patient: 'Evil </script><script>alert(1)</script>' },
    cdi: { flags: [{ id: 'f1', type: 'critical', title: 'x', body: 'has <b>bold</b> and </script> inside' }] },
    em: {},
    patient_summary: {},
  }
  const html = buildReportHtml(template, paData)
  // The injected region must contain no literal "</script" — only the real closing tag.
  const open = '<script id="pa-data" type="application/json">'
  const start = html.indexOf(open) + open.length
  const end = html.indexOf('</script>', start)
  const injected = html.slice(start, end)
  assert.equal(injected.toLowerCase().indexOf('</script'), -1, 'no raw </script in injected JSON')
  assert.equal(injected.indexOf('<'), -1, 'all < escaped in injected JSON')
  // And it still round-trips to the original object.
  assert.deepEqual(extractInjected(html), paData)
})
