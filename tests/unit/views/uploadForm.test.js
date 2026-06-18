'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { setupDom, teardownDom, flush } = require('./helpers')

let createUploadForm

before(async () => {
  setupDom({})
  ;({ createUploadForm } = await import('../../../renderer/views/uploadForm.js'))
})
after(teardownDom)

function mountForm(api = {}) {
  const dom = setupDom(api)
  const view = createUploadForm()
  view.mount(dom.document, {})
  return { view, ...dom }
}

test('show() reveals the form and runs clearActionButtons', () => {
  const { view, document } = mountForm()
  let cleared = 0
  view.show('C:\\a.mp3', { clearActionButtons: () => { cleared++ } })
  assert.strictEqual(cleared, 1)
  assert.ok(!document.getElementById('upload-form').classList.contains('hidden'))
  view.unmount()
})

test('Process submits the file path + name via ipc.processAudioFile', async () => {
  const calls = []
  const { view, document } = mountForm({ processAudioFile: (...a) => calls.push(a) })
  view.show('C:\\rec.mp3', {})
  document.getElementById('upload-patient-input').value = 'Sam'
  document.getElementById('btn-upload-save-name').click()
  await flush()
  assert.deepStrictEqual(calls, [['C:\\rec.mp3', 'Sam']])
  view.unmount()
})

test('Skip submits null name', async () => {
  const calls = []
  const { view, document } = mountForm({ processAudioFile: (...a) => calls.push(a) })
  view.show('C:\\rec.mp3', {})
  document.getElementById('btn-upload-skip-name').click()
  await flush()
  assert.deepStrictEqual(calls, [['C:\\rec.mp3', null]])
  view.unmount()
})

test('Close fires onClose and hides the form (no submit)', async () => {
  const calls = []
  let closed = 0
  const { view, document } = mountForm({ processAudioFile: (...a) => calls.push(a) })
  view.show('C:\\rec.mp3', { onClose: () => { closed++ } })
  document.getElementById('btn-upload-close').click()
  await flush()
  assert.strictEqual(closed, 1)
  assert.strictEqual(calls.length, 0)
  assert.ok(document.getElementById('upload-form').classList.contains('hidden'))
  view.unmount()
})
