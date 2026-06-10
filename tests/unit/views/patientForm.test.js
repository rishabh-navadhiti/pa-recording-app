'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { setupDom, teardownDom, flush } = require('./helpers')

let createPatientForm

before(async () => {
  setupDom({})
  ;({ createPatientForm } = await import('../../../renderer/views/patientForm.js'))
})
after(teardownDom)

function mountForm(api = {}) {
  const ctx = setupDom(api)
  const view = createPatientForm()
  view.mount(ctx.document, {})
  return { view, ...ctx }
}

test('show() reveals the form and starts the 30s countdown', () => {
  const { view, document } = mountForm()
  view.show()
  const form = document.getElementById('patient-form')
  assert.ok(!form.classList.contains('hidden'))
  assert.strictEqual(document.getElementById('form-countdown').textContent, 'Auto-saving in 30s...')
  view.unmount()
})

test('Save submits the typed name via ipc.submitPatientName', async () => {
  const seen = []
  const { view, document } = mountForm({ submitPatientName: (n) => seen.push(n) })
  view.show()
  document.getElementById('patient-input').value = 'Jane Doe'
  document.getElementById('btn-save-name').click()
  await flush()
  assert.deepStrictEqual(seen, ['Jane Doe'])
  // Form hidden after submit.
  assert.ok(document.getElementById('patient-form').classList.contains('hidden'))
  view.unmount()
})

test('Skip submits null', async () => {
  const seen = []
  const { view, document } = mountForm({ submitPatientName: (n) => seen.push(n) })
  view.show()
  document.getElementById('btn-skip-name').click()
  await flush()
  assert.deepStrictEqual(seen, [null])
  view.unmount()
})

test('empty name submits null (|| null)', async () => {
  const seen = []
  const { view, document } = mountForm({ submitPatientName: (n) => seen.push(n) })
  view.show()
  document.getElementById('patient-input').value = ''
  document.getElementById('btn-save-name').click()
  await flush()
  assert.deepStrictEqual(seen, [null])
  view.unmount()
})

test('second click is ignored once submitted', async () => {
  const seen = []
  const { view, document } = mountForm({ submitPatientName: (n) => seen.push(n) })
  view.show()
  const save = document.getElementById('btn-save-name')
  save.click()
  save.click()
  await flush()
  assert.strictEqual(seen.length, 1)
  view.unmount()
})
