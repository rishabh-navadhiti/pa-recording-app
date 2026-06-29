'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { renderCostiganMd } = require('../../src/render/costiganMd')

const sample = {
  meta: { patient: 'Emilia Martinez', doctor: 'William Costigan', date_of_service: '06/18/2026', generated_at: '2026-06-26T00:00:00Z', standards_versions: { esi: 'procedures/esi v1 (2026-06-05)' } },
  summary: { procedures_in_play: 1, overall_status: 'needs_edits', audit_ready_count: 0, needs_edits_count: 1, likely_denied_count: 0, headline: 'Lumbar ESI requested; add prior-injection relief %.' },
  procedures_detected: [{
    id: 'proc-001', procedure: 'ESI', subtype: 'caudal ILESI lumbar', intent: 'requested', rung: 'repeat', site: 'L5 right',
    verdict: 'needs_edits', denial_reason: null,
    checklist: [
      { id: 'ESI-R1', criterion: '>=50% relief >=3mo on same scale', status: 'not_met', evidence_found: ['prior injection ... relief'], fix: 'Document the % relief and dates on the same scale.' },
      { id: 'ESI-1', criterion: 'Concordant diagnosis + imaging', status: 'met', evidence_found: ['stenosis at L4-L5'], fix: null },
    ],
    coding: { cpt_observed: [], icd_observed: [], icd_suggested: [{ code: 'M48.062', description: 'Lumbar stenosis with claudication', why: 'matches documented stenosis' }], coding_issues: [] },
    frequency: { cap: '4 ESI / region / 12mo', prior_dates: ['03/2026'], within_cap: true, note: null },
  }],
}

test('renders headline, verdict, checklist item status, and fix', () => {
  const md = renderCostiganMd(sample)
  assert.ok(md.includes('# Procedure Checklist — Emilia Martinez'))
  assert.ok(md.includes('Needs edits'))
  assert.ok(md.includes('ESI-R1'))
  assert.ok(md.includes('→ fix:'))
  assert.ok(md.includes('M48.062'))
})

test('no_procedure renders a clean skip message', () => {
  const md = renderCostiganMd({ meta: { patient: 'Balian' }, summary: { procedures_in_play: 0, overall_status: 'no_procedure' }, procedures_detected: [] })
  assert.ok(/No interventional procedure/i.test(md))
})

test('parse_error renders a stub', () => {
  const md = renderCostiganMd({ meta: { patient: 'X' }, parse_error: true, raw_output_path: '/tmp/x.raw.txt' })
  assert.ok(/could not be produced/i.test(md))
})

test('renders Frequency section when within_cap=false even with empty cap and prior_dates', () => {
  const data = {
    meta: { patient: 'Test Patient', generated_at: '2026-06-29T00:00:00Z' },
    summary: { procedures_in_play: 1, overall_status: 'likely_denied', likely_denied_count: 1 },
    procedures_detected: [{
      procedure: 'TPI', verdict: 'likely_denied',
      checklist: [],
      coding: {},
      frequency: { cap: '', prior_dates: [], within_cap: false },
    }],
  }
  const md = renderCostiganMd(data)
  assert.ok(/### Frequency/.test(md), 'Frequency section should be rendered')
  assert.ok(/\*\*Within cap:\*\* no/.test(md), 'within_cap=false should render as "no"')
})
