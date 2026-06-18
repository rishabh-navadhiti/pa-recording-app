'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createPaths } = require('../../config/paths')
const { createSettingsStore, DEFAULT_SETTINGS } = require('../../config/settings')
const { createSecretStore } = require('../../config/secrets')
const { createJobStateStore } = require('../../config/jobState')

// ---- paths -----------------------------------------------------------------

test('createPaths derives all paths from notesDir', () => {
  const base = path.join(os.tmpdir(), 'notes')
  const p = createPaths(base)
  assert.strictEqual(p.notesDir,             base)
  assert.strictEqual(p.casesDir,             path.join(base, 'Cases'))
  assert.strictEqual(p.templatesDir,         path.join(base, 'Templates'))
  assert.strictEqual(p.logFile,              path.join(base, 'app.log'))
  assert.strictEqual(p.claudeDir,            path.join(base, '.claude'))
  assert.strictEqual(p.mcpJsonPath,          path.join(base, '.mcp.json'))
  assert.strictEqual(p.templateJobStatePath, path.join(base, '.template_job.json'))
  assert.strictEqual(p.settingsPath,         path.join(base, 'settings.json'))
})

test('createPaths result is frozen', () => {
  const p = createPaths('/tmp/notes')
  assert.throws(() => { p.notesDir = '/other' }, TypeError)
})

// ---- settings --------------------------------------------------------------

function tmpSettingsPath() {
  return path.join(os.tmpdir(), `settings-test-${Date.now()}.json`)
}

test('settings get() returns merged defaults when file missing', () => {
  const store = createSettingsStore('/nonexistent/path/settings.json')
  const s = store.get()
  assert.strictEqual(s.autoRecord, false)
  assert.strictEqual(s.soapModel, 'sonnet-4-6-api')
})

test('settings get() caches (reads disk once)', () => {
  const f = tmpSettingsPath()
  fs.writeFileSync(f, JSON.stringify({ autoRecord: true }))
  const store = createSettingsStore(f)
  const s1 = store.get()
  assert.strictEqual(s1.autoRecord, true)
  // Mutate disk after first read
  fs.writeFileSync(f, JSON.stringify({ autoRecord: false }))
  const s2 = store.get()
  assert.strictEqual(s2.autoRecord, true, 'should return cached value')
  fs.unlinkSync(f)
})

test('settings save() writes and invalidates cache', () => {
  const f = tmpSettingsPath()
  const store = createSettingsStore(f)
  store.save({ autoRecord: true })
  assert.strictEqual(store.get().autoRecord, true)
  const persisted = JSON.parse(fs.readFileSync(f, 'utf8'))
  assert.strictEqual(persisted.autoRecord, true)
  fs.unlinkSync(f)
})

test('settings CDI→ICD invariant enforced on get()', () => {
  const f = tmpSettingsPath()
  fs.writeFileSync(f, JSON.stringify({ enableCdi: true, enableIcd: false }))
  const store = createSettingsStore(f)
  const s = store.get()
  assert.strictEqual(s.enableIcd, true, 'enableCdi=true must force enableIcd=true')
  fs.unlinkSync(f)
})

test('settings CDI→ICD invariant enforced on save()', () => {
  const f = tmpSettingsPath()
  const store = createSettingsStore(f)
  store.save({ enableCdi: true, enableIcd: false })
  assert.strictEqual(store.get().enableIcd, true)
  fs.unlinkSync(f)
})

test('settings reload() re-reads from disk', () => {
  const f = tmpSettingsPath()
  fs.writeFileSync(f, JSON.stringify({ autoRecord: true }))
  const store = createSettingsStore(f)
  store.get()  // prime cache
  fs.writeFileSync(f, JSON.stringify({ autoRecord: false }))
  store.reload()
  assert.strictEqual(store.get().autoRecord, false)
  fs.unlinkSync(f)
})

// ---- secrets ---------------------------------------------------------------

test('secrets getElevenLabsKey() reads from .env file', () => {
  const f = path.join(os.tmpdir(), `.env-test-${Date.now()}`)
  fs.writeFileSync(f, 'ELEVENLABS_API_KEY=sk-abc123\nNOTES_DIR_PATH=/tmp/notes\n')
  const store = createSecretStore(f)
  assert.strictEqual(store.getElevenLabsKey(), 'sk-abc123')
  assert.strictEqual(store.getNotesDirPath(), '/tmp/notes')
  fs.unlinkSync(f)
})

test('secrets setElevenLabsKey() updates existing key in .env', () => {
  const f = path.join(os.tmpdir(), `.env-test-${Date.now()}`)
  fs.writeFileSync(f, 'ELEVENLABS_API_KEY=old\n')
  const store = createSecretStore(f)
  store.setElevenLabsKey('new-key')
  assert.strictEqual(store.getElevenLabsKey(), 'new-key')
  fs.unlinkSync(f)
})

test('secrets returns null when key absent', () => {
  const store = createSecretStore('/nonexistent/.env')
  assert.strictEqual(store.getElevenLabsKey(), null)
})

// ---- jobState --------------------------------------------------------------

function tmpJobPath() {
  return path.join(os.tmpdir(), `job-state-test-${Date.now()}.json`)
}

function noopWrite(f, data) { fs.writeFileSync(f, data, 'utf8') }

test('jobState load() returns idle when file missing', () => {
  const store = createJobStateStore('/nonexistent/.template_job.json', noopWrite)
  assert.strictEqual(store.load().status, 'idle')
})

test('jobState save() + load() roundtrip', () => {
  const f = tmpJobPath()
  const store = createJobStateStore(f, noopWrite)
  store.save({ status: 'running', type: 'create', startedAt: '2026-06-04T12:00:00Z' })
  const loaded = store.load()
  assert.strictEqual(loaded.status, 'running')
  assert.strictEqual(loaded.type, 'create')
  fs.unlinkSync(f)
})

test('jobState clearStaleRunning() flips running→failed', () => {
  const f = tmpJobPath()
  fs.writeFileSync(f, JSON.stringify({ status: 'running', type: 'create' }))
  const store = createJobStateStore(f, noopWrite)
  store.clearStaleRunning()
  assert.strictEqual(store.load().status, 'failed')
  fs.unlinkSync(f)
})

test('jobState clearStaleRunning() leaves non-running status alone', () => {
  const f = tmpJobPath()
  fs.writeFileSync(f, JSON.stringify({ status: 'completed', type: 'create' }))
  const store = createJobStateStore(f, noopWrite)
  store.clearStaleRunning()
  assert.strictEqual(store.load().status, 'completed')
  fs.unlinkSync(f)
})
