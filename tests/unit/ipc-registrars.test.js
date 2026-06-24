'use strict'

// Drift test for the Group 8 IPC split: every channel the renderer can call
// (preload.js) must have a registered handler somewhere, and every domain
// registrar must register without throwing. Mocks ipcMain — no Electron.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const registrars = [
  require('../../src/ipc/lifecycle').registerLifecycleIpc,
  require('../../src/ipc/recording').registerRecordingIpc,
  require('../../src/ipc/doctors').registerDoctorsIpc,
  require('../../src/ipc/templates').registerTemplatesIpc,
  require('../../src/ipc/prechart').registerPrechartIpc,
  require('../../src/ipc/config').registerConfigIpc,
  require('../../src/ipc/audioUpload').registerAudioUploadIpc,
  require('../../src/ipc/status').registerStatusIpc,
]

// hide-window is registered in windows/mainWindow.js, not a domain registrar.
const NON_DOMAIN_CHANNELS = new Set(['hide-window'])

function collectRegisteredChannels() {
  const channels = []
  const mockIpcMain = { handle: (ch) => channels.push(ch) }
  // The registrars only call ipcMain.handle(channel, fn) at registration time;
  // they do not invoke the handler bodies, so stub deps/appCtx suffice.
  const fakeDeps = new Proxy({}, { get: () => (() => {}) })
  const fakeCtx = new Proxy({}, { get: () => (() => {}) })
  for (const reg of registrars) reg(mockIpcMain, fakeCtx, fakeDeps)
  return channels
}

function preloadChannels() {
  const src = fs.readFileSync(path.join(__dirname, '../../preload.js'), 'utf8')
  // preload uses literal channel strings (sandbox-safe — see preload.js header).
  const out = new Set()
  for (const m of src.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)) out.add(m[1])
  return out
}

test('all 8 registrars register without throwing', () => {
  assert.doesNotThrow(() => collectRegisteredChannels())
})

test('registrars register exactly 47 handlers', () => {
  const channels = collectRegisteredChannels()
  assert.strictEqual(channels.length, 47, `expected 47 handlers, got ${channels.length}: ${channels.join(',')}`)
})

test('no duplicate channel registrations', () => {
  const channels = collectRegisteredChannels()
  const seen = new Set()
  const dupes = []
  for (const c of channels) { if (seen.has(c)) dupes.push(c); seen.add(c) }
  assert.deepStrictEqual(dupes, [], `duplicate channels: ${dupes.join(',')}`)
})

test('every preload invoke channel has a registered handler', () => {
  const registered = new Set(collectRegisteredChannels())
  const missing = [...preloadChannels()].filter(ch => !registered.has(ch) && !NON_DOMAIN_CHANNELS.has(ch))
  assert.deepStrictEqual(missing, [], `preload channels with no handler: ${missing.join(',')}`)
})
