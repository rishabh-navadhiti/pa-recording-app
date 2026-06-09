'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

// Test the platform implementations directly (injectable deps — no Electron, no shell).
const win = require('../../platform/windows')
const mac = require('../../platform/macos')

// ---- isStaging -------------------------------------------------------------

test('isStaging returns true when marker file exists', () => {
  const f = path.join(os.tmpdir(), `.staging-marker-test-${Date.now()}`)
  fs.writeFileSync(f, '')
  assert.strictEqual(win.isStaging(f), true)
  assert.strictEqual(mac.isStaging(f), true)
  fs.unlinkSync(f)
})

test('isStaging returns false when marker file is absent', () => {
  const f = path.join(os.tmpdir(), `.staging-marker-absent-${Date.now()}`)
  assert.strictEqual(win.isStaging(f), false)
  assert.strictEqual(mac.isStaging(f), false)
})

// ---- resolvePython ---------------------------------------------------------

test('win.resolvePython returns first matching Python 3 candidate', () => {
  const fakeExec = (cmd) => {
    if (cmd.startsWith('py ')) return Buffer.from('Python 3.12.0')
    throw new Error('not found')
  }
  const result = win.resolvePython(fakeExec)
  assert.ok(result, 'should find python')
  assert.strictEqual(result.cmd, 'py')
  assert.match(result.version, /Python 3/)
})

test('win.resolvePython falls back through candidates', () => {
  const fakeExec = (cmd) => {
    if (cmd.startsWith('python ')) return Buffer.from('Python 3.11.0')
    throw new Error('not found')
  }
  const result = win.resolvePython(fakeExec)
  assert.strictEqual(result.cmd, 'python')
})

test('resolvePython returns null when no Python 3 found', () => {
  const fakeExec = () => { throw new Error('not found') }
  assert.strictEqual(win.resolvePython(fakeExec), null)
  assert.strictEqual(mac.resolvePython(fakeExec), null)
})

test('mac.resolvePython tries python3 before python', () => {
  const tried = []
  const fakeExec = (cmd) => {
    const key = cmd.split(' ')[0]
    tried.push(key)
    if (key === 'python3') return Buffer.from('Python 3.12.0')
    throw new Error('not found')
  }
  mac.resolvePython(fakeExec)
  assert.strictEqual(tried[0], 'python3')
})

// ---- hideInternal (Windows) ------------------------------------------------

test('win.hideInternal calls exec with attrib +h', () => {
  let called = null
  const fakeExec = (cmd) => { called = cmd }
  win.hideInternal('/tmp/note.md', fakeExec, null)
  assert.ok(called && called.includes('attrib +h'), `expected attrib +h, got: ${called}`)
})

// ---- mac stubs are no-ops --------------------------------------------------

test('mac.hideInternal is a no-op (returns undefined)', () => {
  assert.doesNotThrow(() => mac.hideInternal('/tmp/note.md', () => {}, null))
})
