'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { setupDom, teardownDom, flush } = require('./helpers')

let createJobBanner

before(async () => {
  setupDom({})
  ;({ createJobBanner } = await import('../../../renderer/views/jobBanner.js'))
})
after(teardownDom)

function mountBanner(api = {}, ctx = {}) {
  const dom = setupDom(api)
  const view = createJobBanner()
  view.mount(dom.document, ctx)
  return { view, ...dom }
}

test('idle/no job hides the banner', () => {
  const { view, document } = mountBanner()
  const banner = document.getElementById('template-job-banner')
  view.handleTemplateJobStatus({ status: 'idle' })
  assert.ok(banner.classList.contains('hidden'))
  view.handleTemplateJobStatus(null)
  assert.ok(banner.classList.contains('hidden'))
  view.unmount()
})

test('running (create) shows "Creating template for <doctor>"', () => {
  const { view, document } = mountBanner({ getTemplateJobStatus: () => ({ status: 'running', type: 'create', doctorName: 'Chen', startedAt: Date.now() }) })
  const banner = document.getElementById('template-job-banner')
  view.handleTemplateJobStatus({ status: 'running', type: 'create', doctorName: 'Chen', startedAt: Date.now() })
  assert.ok(!banner.classList.contains('hidden'))
  assert.match(document.getElementById('template-job-banner-text').innerHTML, /Creating template for <strong>Chen<\/strong>/)
  view.unmount()
})

test('running (update) says "Updating"; running (prechart) says "Pre-charting"', () => {
  const { view, document } = mountBanner({ getTemplateJobStatus: () => ({ status: 'running', type: 'update', doctorName: 'Lee', startedAt: Date.now() }) })
  const text = document.getElementById('template-job-banner-text')
  view.handleTemplateJobStatus({ status: 'running', type: 'update', doctorName: 'Lee', startedAt: Date.now() })
  assert.match(text.innerHTML, /Updating template for <strong>Lee<\/strong>/)
  view.handleTemplateJobStatus({ status: 'running', type: 'prechart', doctorName: 'Patel', startedAt: Date.now() })
  assert.match(text.innerHTML, /Pre-charting <strong>Patel<\/strong>/)
  view.unmount()
})

test('failed adds banner-failed + shows the error', () => {
  const { view, document } = mountBanner()
  const banner = document.getElementById('template-job-banner')
  view.handleTemplateJobStatus({ status: 'failed', type: 'create', error: 'boom' })
  assert.ok(banner.classList.contains('banner-failed'))
  assert.match(document.getElementById('template-job-banner-text').innerHTML, /Template creation failed<\/strong> — boom/)
  view.unmount()
})

test('success (create) adds banner-success + fires onTemplateUpdated', () => {
  let updated = 0
  const { view, document } = mountBanner({}, { onTemplateUpdated: () => { updated++ } })
  const banner = document.getElementById('template-job-banner')
  view.handleTemplateJobStatus({ status: 'success', type: 'create', doctorName: 'Wu', changesReport: 'diff text' })
  assert.ok(banner.classList.contains('banner-success'))
  assert.strictEqual(updated, 1)
  assert.match(document.getElementById('template-job-banner-text').innerHTML, /Template ready for <strong>Wu<\/strong>/)
  view.unmount()
})

// NOTE: #btn-template-view-changes is referenced by the code but does NOT exist
// in renderer/index.html — so all its handlers are no-ops (the original guarded
// every access with `if (btnTemplateViewChanges)`). This is faithfully
// preserved: querySelector returns null and the changes-panel open path is
// unreachable via the UI. We assert the element's absence to document the gap.
test('the "View changes" button is absent from the markup (dead path preserved)', () => {
  const { document } = mountBanner()
  assert.strictEqual(document.getElementById('btn-template-view-changes'), null)
})

test('success (prechart) shows the applied message + does NOT fire onTemplateUpdated', () => {
  let updated = 0
  const { view, document } = mountBanner({}, { onTemplateUpdated: () => { updated++ } })
  view.handleTemplateJobStatus({ status: 'success', type: 'prechart', doctorName: 'Patel' })
  assert.match(document.getElementById('template-job-banner-text').innerHTML, /Pre-chart applied to <strong>Patel<\/strong>/)
  assert.strictEqual(updated, 0)
  view.unmount()
})
