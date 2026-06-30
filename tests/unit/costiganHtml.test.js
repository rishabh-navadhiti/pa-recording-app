'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { renderCostiganHtml } = require('../../src/render/costiganHtml')

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

test('renders a self-contained HTML document', () => {
  const html = renderCostiganHtml(sample)
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(/<\/html>\s*$/.test(html))
  assert.ok(html.includes('<style>'))
})

test('renders header, headline, verdict, checklist id, fix, suggested code', () => {
  const html = renderCostiganHtml(sample)
  assert.ok(html.includes('Emilia Martinez'))
  assert.ok(html.includes('Needs edits'))
  assert.ok(html.includes('add prior-injection relief'))
  assert.ok(html.includes('ESI-R1'))
  assert.ok(html.includes('Not met'))
  assert.ok(html.includes('Fix'))
  assert.ok(html.includes('M48.062'))
})

test('no_procedure renders a clean skip message', () => {
  const html = renderCostiganHtml({ meta: { patient: 'Balian' }, summary: { procedures_in_play: 0, overall_status: 'no_procedure' }, procedures_detected: [] })
  assert.ok(/No interventional procedure/i.test(html))
})

test('parse_error renders a readable stub pointing at the raw output', () => {
  const html = renderCostiganHtml({ meta: { patient: 'X' }, parse_error: true, raw_output_path: '/tmp/x.raw.txt' })
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(/could not be produced/i.test(html))
  assert.ok(html.includes('x.raw.txt'))
})

test('within_cap tri-state: true -> Within cap, false -> Over cap, "unclear" -> Unclear', () => {
  const mk = (within) => renderCostiganHtml({
    meta: { patient: 'P' },
    summary: { procedures_in_play: 1, overall_status: 'likely_denied', likely_denied_count: 1 },
    procedures_detected: [{ procedure: 'TPI', verdict: 'likely_denied', checklist: [], coding: {}, frequency: { cap: '', prior_dates: [], within_cap: within } }],
  })
  // booleans (defensive) …
  assert.ok(mk(true).includes('Within cap'))
  assert.ok(mk(false).includes('Over cap'))
  assert.ok(mk('unclear').includes('Unclear'))
  // … and the string forms the skill schema actually emits ("true|false|unclear")
  assert.ok(mk('true').includes('Within cap'), 'string "true" -> Within cap')
  assert.ok(!mk('true').includes('>TRUE<'), 'string "true" not shown as raw TRUE')
  assert.ok(mk('false').includes('Over cap'), 'string "false" -> Over cap')
})

test('renders denial-risk callout for likely_denied procedures', () => {
  const html = renderCostiganHtml({
    meta: { patient: 'P' },
    summary: { procedures_in_play: 1, overall_status: 'likely_denied', likely_denied_count: 1 },
    procedures_detected: [{ procedure: 'Facet', verdict: 'likely_denied', denial_reason: 'No image guidance documented.', checklist: [], coding: {}, frequency: {} }],
  })
  assert.ok(html.includes('Denial risk'))
  assert.ok(html.includes('No image guidance documented.'))
})

test('escapes clinical free text containing < & " so markup cannot break', () => {
  const html = renderCostiganHtml({
    meta: { patient: 'Smith & <Co> "quoted"' },
    summary: { procedures_in_play: 1, overall_status: 'needs_edits', needs_edits_count: 1, headline: 'a < b && c "x"' },
    procedures_detected: [{
      procedure: 'ESI', verdict: 'needs_edits',
      checklist: [{ id: 'X', criterion: 'pain <50% & "stable"', status: 'unclear', evidence_found: ['note: a<b & c'], fix: 'fix <this> & "that"' }],
      coding: {}, frequency: {},
    }],
  })
  // Raw, unescaped angle brackets from data must NOT appear; the escaped entity must.
  assert.ok(!html.includes('<Co>'))
  assert.ok(html.includes('&lt;Co&gt;'))
  assert.ok(html.includes('pain &lt;50% &amp; &quot;stable&quot;'))
  assert.ok(html.includes('fix &lt;this&gt; &amp; &quot;that&quot;'))
})

test('coerces objectified array fields to text (no [object Object])', () => {
  // The model sometimes returns coding_issues / evidence_found as objects rather
  // than strings (e.g. a coding issue as {issue, linked_proc_id}). The renderer
  // must show the readable text, never the literal "[object Object]".
  const html = renderCostiganHtml({
    meta: { patient: 'P' },
    summary: { procedures_in_play: 1, overall_status: 'needs_edits', needs_edits_count: 1 },
    procedures_detected: [{
      procedure: 'ESI', verdict: 'needs_edits',
      checklist: [{ id: 'ESI-1', criterion: 'c', status: 'unclear',
        evidence_found: [{ text: 'MRI shows stenosis' }], fix: 'do x' }],
      coding: {
        cpt_observed: [{ code: '64483' }],
        icd_suggested: [{ code: 'M54.17', description: 'Radiculopathy' }],
        coding_issues: [
          { issue: 'No codes were stated in the note', linked_proc_id: 'proc-001' },
          { code: 'M51.36', issue: 'non-billable header' },
        ],
      },
      frequency: {},
    }],
  })
  assert.ok(!html.includes('[object Object]'), 'no [object Object] anywhere')
  assert.ok(html.includes('No codes were stated in the note'), 'object issue text rendered')
  assert.ok(html.includes('M51.36 — non-billable header'), 'code-prefixed issue rendered')
  assert.ok(html.includes('MRI shows stenosis'), 'object evidence text rendered')
  assert.ok(html.includes('64483'), 'object cpt code rendered')
})

test('output is offline / has no external resource references', () => {
  const html = renderCostiganHtml(sample)
  assert.ok(!/https?:\/\//.test(html), 'no http(s) URLs')
  assert.ok(!/\bsrc\s*=/.test(html), 'no external src= references')
  assert.ok(!/<link\b/i.test(html), 'no <link> stylesheets')
})
