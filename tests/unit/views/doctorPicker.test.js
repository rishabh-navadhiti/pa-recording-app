'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { setupDom, teardownDom, flush } = require('./helpers')

let createDoctorPicker

before(async () => {
  setupDom({})
  ;({ createDoctorPicker } = await import('../../../renderer/views/doctorPicker.js'))
})
after(teardownDom)

function mountPicker(api = {}) {
  const dom = setupDom(api)
  const view = createDoctorPicker()
  view.mount(dom.document, {})
  return { view, ...dom }
}

test('show() renders a button per doctor and hides action buttons', () => {
  const { view, document } = mountPicker()
  view.show([{ id: 1, name: 'Dr. A' }, { id: 2, name: 'Dr. B' }])
  const picker = document.getElementById('doctor-picker')
  assert.ok(!picker.classList.contains('hidden'))
  const labels = [...document.getElementById('doctor-picker-list').querySelectorAll('button')].map(b => b.textContent)
  assert.deepStrictEqual(labels, ['Dr. A', 'Dr. B'])
  assert.ok(document.getElementById('action-buttons').classList.contains('hidden'))
  view.unmount()
})

test('picking a doctor calls ipc.selectDoctor(id) and restores action buttons', async () => {
  const picked = []
  const { view, document } = mountPicker({ selectDoctor: (id) => picked.push(id) })
  view.show([{ id: 42, name: 'Dr. X' }])
  document.getElementById('doctor-picker-list').querySelector('button').click()
  await flush()
  assert.deepStrictEqual(picked, [42])
  assert.ok(document.getElementById('doctor-picker').classList.contains('hidden'))
  assert.ok(!document.getElementById('action-buttons').classList.contains('hidden'))
  view.unmount()
})

test('Cancel calls ipc.selectDoctor(null)', async () => {
  const picked = []
  const { view, document } = mountPicker({ selectDoctor: (id) => picked.push(id) })
  view.show([{ id: 1, name: 'Dr. A' }])
  document.getElementById('btn-doctor-picker-cancel').click()
  await flush()
  assert.deepStrictEqual(picked, [null])
  view.unmount()
})
