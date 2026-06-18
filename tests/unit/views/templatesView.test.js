'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { setupDom, teardownDom, flush } = require('./helpers')

let createTemplatesView

before(async () => {
  setupDom({})
  ;({ createTemplatesView } = await import('../../../renderer/views/templatesView.js'))
})
after(teardownDom)

function mountView(api = {}, ctx = {}) {
  const dom = setupDom(api)
  const view = createTemplatesView()
  view.mount(dom.document, ctx)
  return { view, ...dom }
}

test('onEnter renders the doctor list + refreshes the job banner', async () => {
  let refreshed = 0
  const { view, document } = mountView({
    getDoctors: () => [{ id: 1, name: 'Dr. A', templatePath: 'a.md', specialty: null }],
  }, { refreshJobBanner: () => { refreshed++ } })
  view.onEnter()
  await flush()
  assert.strictEqual(document.querySelectorAll('#template-doctor-list .doctor-row').length, 1)
  assert.strictEqual(refreshed, 1)
  view.unmount()
})

test('Add doctor calls ipc.addDoctor + clears the doctor warning', async () => {
  const added = []
  let cleared = 0
  const { view, document } = mountView({
    getDoctors: () => [],
    addDoctor: (n) => { added.push(n); return { ok: true } },
  }, { clearDoctorWarning: () => { cleared++ } })
  const input = document.getElementById('new-template-doctor-input')
  input.value = 'Dr. Newman'
  document.getElementById('btn-add-template-doctor').click()
  await flush()
  assert.deepStrictEqual(added, ['Dr. Newman'])
  assert.strictEqual(cleared, 1)
  assert.strictEqual(input.value, '')
  view.unmount()
})

test('Create-with-AI opens the create sub-view; Back returns to the list', () => {
  const { view, document } = mountView({ getDoctors: () => [] })
  document.getElementById('btn-template-create-ai').click()
  assert.ok(!document.getElementById('create-template-view').classList.contains('hidden'))
  assert.ok(document.getElementById('template-list-view').classList.contains('hidden'))
  document.getElementById('btn-create-template-back').click()
  assert.ok(document.getElementById('create-template-view').classList.contains('hidden'))
  assert.ok(!document.getElementById('template-list-view').classList.contains('hidden'))
  view.unmount()
})

test('Create Start calls ipc.startTemplateCreation then refreshes the banner', async () => {
  const calls = []
  let refreshed = 0
  const { view, document } = mountView({
    getDoctors: () => [],
    browseNotesFiles: () => ['C:\\n\\a.md'],
    startTemplateCreation: (...a) => { calls.push(a); return { ok: true } },
  }, { refreshJobBanner: () => { refreshed++ } })
  document.getElementById('btn-template-create-ai').click()
  document.getElementById('create-template-doctor-input').value = 'Dr. Z'
  document.getElementById('btn-create-template-add-files').click()
  await flush()
  document.getElementById('btn-create-template-start').click()
  await flush()
  assert.deepStrictEqual(calls, [['Dr. Z', ['C:\\n\\a.md']]])
  assert.strictEqual(refreshed, 1)
  view.unmount()
})

test('Update Start passes corrections; an error STRING surfaces in the error box', async () => {
  const { view, document } = mountView({
    getDoctors: () => [],
    getDoctorsWithTemplates: () => ['Dr. A'],
    startTemplateUpdate: () => 'no template found',
  })
  document.getElementById('btn-template-update-ai').click()
  await flush()
  const sel = document.getElementById('update-template-doctor-select')
  sel.value = 'Dr. A'; sel.dispatchEvent(new global.window.Event('change'))
  const corr = document.getElementById('update-template-corrections')
  corr.value = 'change verb'; corr.dispatchEvent(new global.window.Event('input'))
  document.getElementById('btn-update-template-start').click()
  await flush()
  const err = document.getElementById('update-template-error')
  assert.ok(!err.classList.contains('hidden'))
  assert.strictEqual(err.textContent, 'no template found')
  view.unmount()
})
