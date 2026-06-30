'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { setupDom, teardownDom, flush } = require('./helpers')

let createPrechartView

before(async () => {
  setupDom({})
  ;({ createPrechartView } = await import('../../../renderer/views/prechartView.js'))
})
after(teardownDom)

function mountView(api = {}, ctx = {}) {
  const dom = setupDom(api)
  const view = createPrechartView()
  view.mount(dom.document, ctx)
  return { view, ...dom }
}

test('refreshPrechartTab populates doctor + case dropdowns (template doctors only)', async () => {
  const { view, document } = mountView({
    getDoctors: () => [
      { id: 1, name: 'Dr. A', templatePath: 'a.md' },
      { id: 2, name: 'Dr. B', templatePath: null },   // filtered out (no template)
    ],
    listRecentPatientCases: () => [{ patient: 'Jane', date: '2026-06-01', caseDir: 'C:\\cases\\jane' }],
  })
  await view.refreshPrechartTab()
  await flush()
  const docOpts = [...document.getElementById('prechart-doctor-select').options].map(o => o.textContent)
  assert.deepStrictEqual(docOpts, ['Select doctor…', 'Dr. A'])
  const caseOpts = [...document.getElementById('prechart-case-select').options].map(o => o.textContent)
  assert.deepStrictEqual(caseOpts, ['Select patient…', 'Jane  ·  2026-06-01'])
  view.unmount()
})

test('adding files via ipc.browsePrechartFiles renders rows; remove splices', async () => {
  const { view, document } = mountView({
    getDoctors: () => [],
    listRecentPatientCases: () => [],
    browsePrechartFiles: () => ['C:\\f\\one.pdf', 'C:\\f\\two.docx'],
  })
  await view.refreshPrechartTab()
  await flush()
  document.getElementById('btn-prechart-add-files').click()
  await flush()
  const filesEl = document.getElementById('prechart-files')
  let names = [...filesEl.querySelectorAll('.create-template-file-name')].map(n => n.textContent)
  assert.deepStrictEqual(names, ['one.pdf', 'two.docx'])
  // Remove the first.
  filesEl.querySelector('.create-template-file-remove').click()
  names = [...filesEl.querySelectorAll('.create-template-file-name')].map(n => n.textContent)
  assert.deepStrictEqual(names, ['two.docx'])
  view.unmount()
})

test('Start is gated until doctor+case and (instructions or files) are present', async () => {
  const { view, document } = mountView({
    getDoctors: () => [{ id: 1, name: 'Dr. A', templatePath: 'a.md' }],
    listRecentPatientCases: () => [{ patient: 'Jane', date: '', caseDir: 'C:\\cases\\jane' }],
  })
  await view.refreshPrechartTab()
  await flush()
  const start = document.getElementById('btn-prechart-start')
  assert.strictEqual(start.disabled, true)

  const doc = document.getElementById('prechart-doctor-select')
  doc.value = '1'; doc.dispatchEvent(new global.window.Event('change'))
  const cas = document.getElementById('prechart-case-select')
  cas.value = 'C:\\cases\\jane'; cas.dispatchEvent(new global.window.Event('change'))
  // doctor + case set but no instructions/files yet → still disabled.
  assert.strictEqual(start.disabled, true)
  const instr = document.getElementById('prechart-instructions')
  instr.value = 'add details'; instr.dispatchEvent(new global.window.Event('input'))
  assert.strictEqual(start.disabled, false)
  view.unmount()
})

test('Start calls ipc.startPrechartJob with the form values + fires onJobStarted', async () => {
  const calls = []
  let started = 0
  const { view, document } = mountView({
    getDoctors: () => [{ id: 7, name: 'Dr. A', templatePath: 'a.md' }],
    listRecentPatientCases: () => [{ patient: 'Jane', date: '', caseDir: 'C:\\cases\\jane' }],
    startPrechartJob: (...a) => { calls.push(a); return { ok: true } },
  }, { onJobStarted: () => { started++ } })
  await view.refreshPrechartTab()
  await flush()
  const doc = document.getElementById('prechart-doctor-select')
  doc.value = '7'; doc.dispatchEvent(new global.window.Event('change'))
  const cas = document.getElementById('prechart-case-select')
  cas.value = 'C:\\cases\\jane'; cas.dispatchEvent(new global.window.Event('change'))
  const instr = document.getElementById('prechart-instructions')
  instr.value = 'note this'; instr.dispatchEvent(new global.window.Event('input'))
  document.getElementById('btn-prechart-start').click()
  await flush()
  assert.strictEqual(calls.length, 1)
  assert.deepStrictEqual(calls[0], ['7', 'C:\\cases\\jane', 'note this', [], ''])
  assert.strictEqual(started, 1)
  view.unmount()
})
