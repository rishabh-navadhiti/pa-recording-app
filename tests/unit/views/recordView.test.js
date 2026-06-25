'use strict'

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { setupDom, teardownDom, flush } = require('./helpers')

// ipc reads window.api lazily per call, so window.api must exist before import.
let createRecordView, STATE

before(async () => {
  setupDom({})
  ;({ createRecordView } = await import('../../../renderer/views/recordView.js'))
  ;({ STATE } = await import('../../../renderer/constants.js'))
})
after(teardownDom)

function mountView(api = {}) {
  const ctx = setupDom(api)
  const view = createRecordView()
  view.mount(ctx.document, {})
  return { view, ...ctx }
}

function buttonLabels(document) {
  return [...document.querySelectorAll('#action-buttons button')].map(b => b.textContent)
}

test('IDLE renders Start Session + "No active session"', () => {
  const { document } = mountView()
  // mount renders the initial state (IDLE).
  assert.deepStrictEqual(buttonLabels(document), ['Start Session'])
  assert.strictEqual(document.getElementById('status-label').textContent, 'No active session')
  assert.strictEqual(document.getElementById('indicator').className, '')
})

test('SESSION_ACTIVE renders Start Recording / Upload / Stop Session', () => {
  const { view, document } = mountView()
  view.update(STATE.SESSION_ACTIVE)
  assert.deepStrictEqual(buttonLabels(document),
    ['Start Recording', 'Upload Audio File', 'Stop Session'])
  assert.strictEqual(document.getElementById('status-label').textContent, 'Session active')
  assert.strictEqual(document.getElementById('indicator').className, 'active')
  // View-status bar is shown.
  assert.ok(!document.getElementById('view-status-bar').classList.contains('hidden'))
})

test('RECORDING renders Pause / Save Case / Discard / Pre-chart + pulsing indicator', () => {
  const { view, document } = mountView()
  view.update(STATE.RECORDING)
  assert.deepStrictEqual(buttonLabels(document), ['Pause', 'Save Case', 'Discard', 'Pre-chart'])
  assert.strictEqual(document.getElementById('status-label').textContent, 'Recording...')
  assert.strictEqual(document.getElementById('indicator').className, 'pulsing')
  // Timer shown while recording.
  assert.ok(!document.getElementById('timer').classList.contains('hidden'))
})

test('PAUSED renders Resume / Save Case / Discard / Pre-chart + paused indicator', () => {
  const { view, document } = mountView()
  view.update(STATE.RECORDING)
  view.update(STATE.PAUSED)
  assert.deepStrictEqual(buttonLabels(document), ['Resume', 'Save Case', 'Discard', 'Pre-chart'])
  assert.strictEqual(document.getElementById('status-label').textContent, 'Paused')
  assert.strictEqual(document.getElementById('indicator').className, 'paused')
})

test('PROCESSING renders a disabled "Please wait..." button', () => {
  const { view, document } = mountView()
  view.update(STATE.PROCESSING)
  const btns = [...document.querySelectorAll('#action-buttons button')]
  assert.strictEqual(btns.length, 1)
  assert.strictEqual(btns[0].textContent, 'Please wait...')
  assert.strictEqual(btns[0].disabled, true)
  assert.strictEqual(document.getElementById('status-label').textContent, 'Processing...')
})

test('Start Recording button calls ipc.startRecording', async () => {
  let called = 0
  const { view, document } = mountView({ startRecording: () => { called++ } })
  view.update(STATE.SESSION_ACTIVE)
  document.querySelectorAll('#action-buttons button')[0].click()
  await flush()
  assert.strictEqual(called, 1)
})

test('Save Case (RECORDING) calls ipc.stopRecording', async () => {
  let called = 0
  const { view, document } = mountView({ stopRecording: () => { called++ } })
  view.update(STATE.RECORDING)
  // Save Case is the 2nd button.
  document.querySelectorAll('#action-buttons button')[1].click()
  await flush()
  assert.strictEqual(called, 1)
})

test('Start Session no-doctors result triggers onNoDoctors (settings open)', async () => {
  setupDom({ startSession: () => ({ ok: false, error: 'no-doctors' }) })
  const view = createRecordView()
  let opened = 0
  view.mount(global.document, { onNoDoctors: () => { opened++ } })
  // IDLE → Start Session button.
  global.document.querySelectorAll('#action-buttons button')[0].click()
  await flush()
  assert.strictEqual(opened, 1)
})

test('Discard (RECORDING) confirms then calls ipc.discardRecording', async () => {
  let discarded = 0
  setupDom({ discardRecording: () => { discarded++ } })
  // confirm() returns true by default in the harness.
  const view = createRecordView()
  view.mount(global.document, {})
  view.update(STATE.RECORDING)
  // Discard is the 3rd button.
  global.document.querySelectorAll('#action-buttons button')[2].click()
  await flush()
  assert.strictEqual(discarded, 1)
})
