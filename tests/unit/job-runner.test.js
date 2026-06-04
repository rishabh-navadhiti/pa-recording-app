'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const { createJobRunner } = require('../../jobs/jobRunner')
const { createJobStateStore } = require('../../config/jobState')

function tmpJobPath() {
  return path.join(os.tmpdir(), `job-runner-test-${Date.now()}.json`)
}
function noopWrite(f, d) { fs.writeFileSync(f, d, 'utf8') }

function fakeProc() {
  let killed = false
  return { kill() { killed = true }, wasKilled: () => killed }
}

test('isRunning() is false initially', () => {
  const runner = createJobRunner()
  assert.strictEqual(runner.isRunning(), false)
})

test('start() returns ok when idle', () => {
  const runner = createJobRunner()
  const result = runner.start('create', fakeProc(), null)
  assert.strictEqual(result.ok, true)
  assert.strictEqual(runner.isRunning(), true)
  assert.strictEqual(runner.currentType(), 'create')
})

test('start() returns error when already running', () => {
  const runner = createJobRunner()
  runner.start('create', fakeProc(), null)
  const result = runner.start('update', fakeProc(), null)
  assert.strictEqual(result.ok, false)
  assert.ok(result.error)
})

test('clear() stops isRunning', () => {
  const runner = createJobRunner()
  runner.start('create', fakeProc(), 'ev-1')
  runner.clear()
  assert.strictEqual(runner.isRunning(), false)
  assert.strictEqual(runner.currentType(), null)
  assert.strictEqual(runner.getEventId(), null)
})

test('cancel() kills the process and clears state', () => {
  const runner = createJobRunner()
  const proc = fakeProc()
  runner.start('prechart', proc, null)
  const result = runner.cancel()
  assert.strictEqual(result, true)
  assert.strictEqual(proc.wasKilled(), true)
  assert.strictEqual(runner.isRunning(), false)
})

test('cancel() returns false when idle', () => {
  const runner = createJobRunner()
  assert.strictEqual(runner.cancel(), false)
})

test('clearStale() flips running→failed in jobState', () => {
  const f = tmpJobPath()
  fs.writeFileSync(f, JSON.stringify({ status: 'running', type: 'create' }))
  const jobState = createJobStateStore(f, noopWrite)
  const runner = createJobRunner({ jobState })
  runner.clearStale()
  assert.strictEqual(jobState.load().status, 'failed')
  fs.unlinkSync(f)
})

test('eventId getters and setters', () => {
  const runner = createJobRunner()
  runner.start('update', fakeProc(), 'ev-42')
  assert.strictEqual(runner.getEventId(), 'ev-42')
  runner.setEventId('ev-99')
  assert.strictEqual(runner.getEventId(), 'ev-99')
})
