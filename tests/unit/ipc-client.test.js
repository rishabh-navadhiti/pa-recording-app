'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

// renderer/ipc/client.js is an ES module — load it via dynamic import.
async function loadIpc() {
  const mod = await import('../../renderer/ipc/client.js')
  return mod
}

test('ipc forwards a call to window.api', async () => {
  const calls = []
  globalThis.window = { api: { getDoctors: (...a) => { calls.push(['getDoctors', a]); return ['Dr A'] } } }
  const { ipc } = await loadIpc()
  const result = ipc.getDoctors()
  assert.deepStrictEqual(result, ['Dr A'])
  assert.strictEqual(calls.length, 1)
  delete globalThis.window
})

test('ipc forwards arguments', async () => {
  const seen = []
  globalThis.window = { api: { addDoctor: (name) => { seen.push(name); return { ok: true } } } }
  const { ipc } = await loadIpc()
  const r = ipc.addDoctor('Dr. Smith')
  assert.deepStrictEqual(r, { ok: true })
  assert.deepStrictEqual(seen, ['Dr. Smith'])
  delete globalThis.window
})

test('ipc returns no-op (undefined) for a missing method, does not throw', async () => {
  globalThis.window = { api: {} }
  const { ipc } = await loadIpc()
  let result
  assert.doesNotThrow(() => { result = ipc.someRemovedMethod('x') })
  assert.strictEqual(result, undefined)
  delete globalThis.window
})

test('ipc reads window.api lazily (per call)', async () => {
  globalThis.window = { api: { getState: () => 'IDLE' } }
  const { ipc } = await loadIpc()
  assert.strictEqual(ipc.getState(), 'IDLE')
  // Swap the api after import — lazy read should pick up the new impl.
  globalThis.window.api = { getState: () => 'RECORDING' }
  assert.strictEqual(ipc.getState(), 'RECORDING')
  delete globalThis.window
})

test('hasMethod reflects window.api', async () => {
  globalThis.window = { api: { getDoctors: () => [] } }
  const { hasMethod } = await loadIpc()
  assert.strictEqual(hasMethod('getDoctors'), true)
  assert.strictEqual(hasMethod('nope'), false)
  delete globalThis.window
})
