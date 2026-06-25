'use strict'

const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { setupDom, teardownDom, flush } = require('./helpers')

// app.js is the ES-module ENTRY: importing it runs init() as a side effect.
// We must install a complete-enough window.api BEFORE importing, and we capture
// the registered push callbacks so the test can simulate main → renderer pushes.
//
// Because a module is imported once per process, we set up the DOM + api, import
// app.js a single time in before(), and let init() wire everything.

let pushState  // the onStateChange callback app.js registered
let pushService

function makeApi() {
  return {
    getState: () => 'IDLE',
    getBuildInfo: () => ({ isStaging: false }),
    getConfigStatus: () => ({ notesDirMissing: false, elevenLabsKeyMissing: false, elevenLabsKeyInvalid: false, noDoctors: false }),
    getDoctors: () => [],
    getTemplateJobStatus: () => ({ status: 'idle' }),
    // Push-channel registrars — capture the callbacks.
    onStateChange: (cb) => { pushState = cb },
    onShowPatientForm: () => {},
    onSetupWarning: () => {},
    onServiceWarning: (cb) => { pushService = cb },
    onPickDoctor: () => {},
    onAutoStartRecording: () => {},
    onRecordingStatusUpdate: () => {},
    onTemplateJobStatus: () => {},
    // Misc no-ops init/handlers may touch.
    getSettings: () => ({}),
    getNotesDir: () => 'C:\\Notes',
    getElevenLabsKey: () => '',
    saveSettings: () => {},
    listAudioDevices: () => ({ devices: [] }),
    openStatusWindow: () => {},
    hideWindow: () => {},
  }
}

before(async () => {
  setupDom(makeApi())
  await import('../../../renderer/app.js')
  await flush()  // let init()'s awaits resolve
})
after(teardownDom)

function statusLabel() { return global.document.getElementById('status-label').textContent }
function actionLabels() {
  return [...global.document.querySelectorAll('#action-buttons button')].map(b => b.textContent)
}

test('init rendered the initial IDLE state', () => {
  assert.strictEqual(statusLabel(), 'No active session')
  assert.deepStrictEqual(actionLabels(), ['Start Session'])
})

test('a state push updates the record view', () => {
  pushState('SESSION_ACTIVE')
  assert.strictEqual(statusLabel(), 'Session active')
  assert.deepStrictEqual(actionLabels(), ['Start Recording', 'Upload Audio File', 'Stop Session'])
})

test('settingsOpen does NOT drop a state push (the Phase 4 fix)', async () => {
  // Open settings overlay.
  global.document.getElementById('btn-settings').click()
  await flush()
  assert.ok(!global.document.getElementById('settings-view').classList.contains('hidden'), 'settings overlay open')
  // While the overlay is up, main pushes RECORDING. The OLD renderer dropped this.
  pushState('RECORDING')
  // The record view (behind the overlay) must already reflect RECORDING.
  assert.strictEqual(statusLabel(), 'Recording...')
  // Close settings: the record view stays current (no stale state).
  global.document.getElementById('btn-settings-close').click()
  await flush()
  assert.ok(global.document.getElementById('settings-view').classList.contains('hidden'), 'settings overlay closed')
  assert.strictEqual(statusLabel(), 'Recording...')
  assert.deepStrictEqual(actionLabels(), ['Pause', 'Save Case', 'Discard', 'Pre-chart'])
})
