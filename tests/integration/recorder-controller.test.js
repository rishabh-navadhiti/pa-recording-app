'use strict'

// Integration test for recorderController.
// Spawns a real child process that reads stdin commands and exits on 'stop',
// then verifies the controller writes the correct bytes to stdin per Decision #1.
//
// The stub process (stdin-echo.js) prints each received command to stdout
// and exits with code 0 when it receives 'stop'.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const { createRecorderController } = require('../../context/recorderController')

// A minimal stdin-reader script used as a stand-in for record.py.
const STUB_SCRIPT = path.join(os.tmpdir(), `stdin-echo-${Date.now()}.js`)
fs.writeFileSync(STUB_SCRIPT, `
process.stdin.setEncoding('utf8')
let buf = ''
process.stdin.on('data', chunk => {
  buf += chunk
  const lines = buf.split('\\n')
  buf = lines.pop()
  for (const line of lines) {
    if (line) process.stdout.write('CMD:' + line + '\\n')
    if (line === 'stop') process.exit(0)
  }
})
process.stdin.on('end', () => process.exit(0))
`)

function spawnStub() {
  return spawn(process.execPath, [STUB_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

function waitForExit(proc) {
  return new Promise((resolve, reject) => {
    proc.on('close', code => resolve(code))
    proc.on('error', reject)
  })
}

function collectStdout(proc) {
  const lines = []
  proc.stdout.on('data', d => lines.push(...d.toString().split('\n').filter(Boolean)))
  return lines
}

// ---- Decision #1: stop writes 'stop\n' + ends stdin ---------------------

test('stop() writes stop\\n to stdin and process exits', async () => {
  const ctrl = createRecorderController()
  const proc = spawnStub()
  const lines = collectStdout(proc)
  ctrl.setProcess(proc, '/tmp/rec.mp3')
  assert.strictEqual(ctrl.isRecording(), true)

  const stopped = ctrl.stop()
  assert.strictEqual(ctrl.isRecording(), false, 'isRecording should be false after stop()')
  assert.ok(stopped === proc, 'stop() returns the proc for the caller to await')

  const code = await waitForExit(proc)
  assert.strictEqual(code, 0, 'process should exit 0')
  assert.ok(lines.some(l => l === 'CMD:stop'), `expected CMD:stop in stdout, got: ${lines.join(', ')}`)
})

// ---- pause / resume write correct strings --------------------------------

test('pause() writes pause\\n to stdin', async () => {
  const ctrl = createRecorderController()
  const proc = spawnStub()
  const lines = collectStdout(proc)
  ctrl.setProcess(proc, '/tmp/rec.mp3')

  ctrl.pause()
  // Give the process a moment to receive the data, then stop it.
  await new Promise(r => setTimeout(r, 30))
  ctrl.stop()
  await waitForExit(proc)

  assert.ok(lines.some(l => l === 'CMD:pause'), `expected CMD:pause, got: ${lines.join(', ')}`)
})

test('resume() writes resume\\n to stdin', async () => {
  const ctrl = createRecorderController()
  const proc = spawnStub()
  const lines = collectStdout(proc)
  ctrl.setProcess(proc, '/tmp/rec.mp3')

  ctrl.resume()
  await new Promise(r => setTimeout(r, 30))
  ctrl.stop()
  await waitForExit(proc)

  assert.ok(lines.some(l => l === 'CMD:resume'), `expected CMD:resume, got: ${lines.join(', ')}`)
})

// ---- patientName cross-handler promise -----------------------------------

test('awaitPatientName resolves via resolvePatientName', async () => {
  const ctrl = createRecorderController()
  const p = ctrl.awaitPatientName()
  ctrl.resolvePatientName('jane_doe')
  const name = await p
  assert.strictEqual(name, 'jane_doe')
})

test('cancelPatientName resolves promise with null', async () => {
  const ctrl = createRecorderController()
  const p = ctrl.awaitPatientName()
  ctrl.cancelPatientName()
  const name = await p
  assert.strictEqual(name, null)
})

// ---- duration side-channel -----------------------------------------------

test('pendingDuration set/consume roundtrip', () => {
  const ctrl = createRecorderController()
  ctrl.setPendingDuration(42.5)
  assert.strictEqual(ctrl.consumePendingDuration(), 42.5)
  assert.strictEqual(ctrl.consumePendingDuration(), null, 'second consume returns null')
})

// ---- discard uses same protocol as stop ----------------------------------

test('discard() writes stop\\n and ends stdin (same as stop)', async () => {
  const ctrl = createRecorderController()
  const proc = spawnStub()
  const lines = collectStdout(proc)
  ctrl.setProcess(proc, '/tmp/rec.mp3')

  const discarded = ctrl.discard()
  assert.ok(discarded === proc)
  assert.strictEqual(ctrl.isRecording(), false)

  const code = await waitForExit(proc)
  assert.strictEqual(code, 0)
  assert.ok(lines.some(l => l === 'CMD:stop'))
})
