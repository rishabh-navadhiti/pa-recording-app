'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { setupDom, teardownDom, flush } = require('./helpers')

let createSettingsView

before(async () => {
  setupDom({})
  ;({ createSettingsView } = await import('../../../renderer/views/settingsView.js'))
})
after(teardownDom)

function mountView(api = {}, ctx = {}) {
  const dom = setupDom(api)
  const view = createSettingsView()
  view.mount(dom.document, ctx)
  return { view, ...dom }
}

const BASE_API = {
  getSettings: () => ({ autoRecord: true, enableIcd: true, enableCdi: false, cdiMode: 'balanced' }),
  getNotesDir: () => 'C:\\Notes',
  getElevenLabsKey: () => 'sk_abcdefghij',
  saveSettings: () => {},
}

test('open() loads settings into the controls', async () => {
  const { view, document } = mountView(BASE_API)
  view.open()
  await flush()
  assert.ok(!document.getElementById('settings-view').classList.contains('hidden'))
  assert.strictEqual(document.getElementById('chk-auto-record').checked, true)
  assert.strictEqual(document.getElementById('chk-enable-icd').checked, true)
  assert.strictEqual(document.getElementById('chk-enable-cdi').checked, false)
  // CDI mode row hidden while CDI off.
  assert.ok(document.getElementById('cdi-mode-row').classList.contains('hidden'))
  // API key masked.
  assert.strictEqual(document.getElementById('api-key-masked').textContent, 'sk_•••••ghij')
  view.unmount()
})

test('enabling CDI persists {enableCdi:true,enableIcd:true}, shows mode row, locks ICD', async () => {
  const saved = []
  const { view, document } = mountView({ ...BASE_API, saveSettings: (s) => saved.push(s) })
  view.open()
  await flush()
  const cdi = document.getElementById('chk-enable-cdi')
  cdi.checked = true
  cdi.dispatchEvent(new global.window.Event('change'))
  assert.deepStrictEqual(saved.at(-1), { enableCdi: true, enableIcd: true })
  assert.ok(!document.getElementById('cdi-mode-row').classList.contains('hidden'))
  const icd = document.getElementById('chk-enable-icd')
  assert.strictEqual(icd.checked, true)
  assert.strictEqual(icd.disabled, true)
  view.unmount()
})

test('close() hides the panel and fires onSettingsClose', () => {
  let closed = 0
  const { view, document } = mountView(BASE_API, { onSettingsClose: () => { closed++ } })
  view.open()
  document.getElementById('btn-settings-close').click()
  assert.ok(document.getElementById('settings-view').classList.contains('hidden'))
  assert.strictEqual(closed, 1)
  view.unmount()
})
