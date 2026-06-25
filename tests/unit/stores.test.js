'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { createStateMachine } = require('../../context/stateMachine')
const { createSessionStore }  = require('../../context/sessionStore')
const { createRecordingsStore } = require('../../context/recordingsStore')
const { createRecorderController } = require('../../context/recorderController')
const { STATE } = require('../../src/shared/state')

// ---- stateMachine ----------------------------------------------------------

test('stateMachine initial state is IDLE', () => {
  const sm = createStateMachine()
  assert.strictEqual(sm.getState(), STATE.IDLE)
})

test('stateMachine setState changes state', () => {
  const sm = createStateMachine()
  sm.setState(STATE.RECORDING)
  assert.strictEqual(sm.getState(), STATE.RECORDING)
})

test('stateMachine onChange fires on transition', () => {
  const seen = []
  const sm = createStateMachine({ onChange: s => seen.push(s) })
  sm.setState(STATE.SESSION_ACTIVE)
  sm.setState(STATE.RECORDING)
  assert.deepStrictEqual(seen, [STATE.SESSION_ACTIVE, STATE.RECORDING])
})

test('stateMachine ignores unknown states', () => {
  const sm = createStateMachine()
  sm.setState('UNKNOWN')
  assert.strictEqual(sm.getState(), STATE.IDLE)
})

test('stateMachine isQuitting starts false, setQuitting flips it', () => {
  const sm = createStateMachine()
  assert.strictEqual(sm.isQuitting(), false)
  sm.setQuitting()
  assert.strictEqual(sm.isQuitting(), true)
})

// ---- sessionStore ----------------------------------------------------------

test('sessionStore get() returns nulls initially', () => {
  const s = createSessionStore()
  const { doctorId, sessionId, dir } = s.get()
  assert.strictEqual(doctorId, null)
  assert.strictEqual(sessionId, null)
  assert.strictEqual(dir, null)
})

test('sessionStore setDoctor / setSession / get', () => {
  const s = createSessionStore()
  s.setDoctor('doc-1')
  s.setSession('sess-1', '/notes/Cases/2026-06-04')
  const { doctorId, sessionId, dir } = s.get()
  assert.strictEqual(doctorId, 'doc-1')
  assert.strictEqual(sessionId, 'sess-1')
  assert.ok(dir.endsWith('2026-06-04'))
})

test('sessionStore clear() resets to nulls', () => {
  const s = createSessionStore()
  s.setDoctor('doc-1')
  s.setSession('sess-1', '/tmp')
  s.clear()
  const { doctorId, sessionId } = s.get()
  assert.strictEqual(doctorId, null)
  assert.strictEqual(sessionId, null)
})

test('sessionStore awaitDoctorPick resolves via resolveDoctorPick', async () => {
  const s = createSessionStore()
  const p = s.awaitDoctorPick()
  s.resolveDoctorPick('doc-99')
  const id = await p
  assert.strictEqual(id, 'doc-99')
})

test('sessionStore cancelDoctorPick resolves with null', async () => {
  const s = createSessionStore()
  const p = s.awaitDoctorPick()
  s.cancelDoctorPick()
  const id = await p
  assert.strictEqual(id, null)
})

test('sessionStore clear() cancels a pending pick', async () => {
  const s = createSessionStore()
  const p = s.awaitDoctorPick()
  s.clear()
  const id = await p
  assert.strictEqual(id, null)
})

// ---- recordingsStore -------------------------------------------------------

test('recordingsStore add() creates entry with status transcribing', () => {
  const store = createRecordingsStore()
  store.add({ caseTag: 'case1', displayName: 'Jane Doe' })
  const all = store.getAll()
  assert.strictEqual(all.length, 1)
  assert.strictEqual(all[0].caseTag, 'case1')
  assert.strictEqual(all[0].status, 'transcribing')
})

test('recordingsStore updateStatus changes status', () => {
  const store = createRecordingsStore()
  store.add({ caseTag: 'c1' })
  store.updateStatus('c1', 'completed')
  assert.strictEqual(store.getAll()[0].status, 'completed')
})

test('recordingsStore serialize() adds statusLabel', () => {
  const store = createRecordingsStore()
  store.add({ caseTag: 'c1' })
  store.updateStatus('c1', 'converting')
  const serialized = store.serialize()
  assert.strictEqual(serialized[0].statusLabel, 'Converting...')
})

test('recordingsStore multi-patient roll-up: all done → parent completed', () => {
  const store = createRecordingsStore()
  store.add({ caseTag: 'rec1' })
  store.setPatients('rec1', [
    { folderName: 'jane', name: 'Jane', status: 'converting' },
    { folderName: 'john', name: 'John', status: 'converting' },
  ])
  store.updatePatientStatus('rec1', 'jane', 'completed')
  assert.strictEqual(store.getAll()[0].status, 'transcribing', 'parent still in progress')
  store.updatePatientStatus('rec1', 'john', 'completed')
  assert.strictEqual(store.getAll()[0].status, 'completed', 'parent should roll up to completed')
})

test('recordingsStore multi-patient roll-up: all failed → parent failed', () => {
  const store = createRecordingsStore()
  store.add({ caseTag: 'rec2' })
  store.setPatients('rec2', [
    { folderName: 'a', name: 'A', status: 'converting' },
  ])
  store.updatePatientStatus('rec2', 'a', 'failed')
  assert.strictEqual(store.getAll()[0].status, 'failed')
})

test('recordingsStore setCdi merges CDI fields', () => {
  const store = createRecordingsStore()
  store.add({ caseTag: 'c1' })
  store.setCdi('c1', { cdiStatus: 'completed', cdiFlagCount: 3, cdiQualityScore: 85 })
  const entry = store.getAll()[0]
  assert.strictEqual(entry.cdiStatus, 'completed')
  assert.strictEqual(entry.cdiFlagCount, 3)
})

test('recordingsStore onChange fires on each mutation', () => {
  let calls = 0
  const store = createRecordingsStore({ onChange: () => calls++ })
  store.add({ caseTag: 'c1' })
  store.updateStatus('c1', 'completed')
  assert.ok(calls >= 2, `expected ≥2 onChange calls, got ${calls}`)
})

test('recordingsStore clear() resets entries', () => {
  const store = createRecordingsStore()
  store.add({ caseTag: 'c1' })
  store.clear()
  assert.strictEqual(store.getAll().length, 0)
})

// ---- recorderController pre-chart context ----------------------------------

test('recorderController prechart defaults to empty', () => {
  const r = createRecorderController()
  assert.deepStrictEqual(r.getPrechart(), { text: '', files: [] })
})

test('recorderController setPrechart / getPrechart round-trips and sanitizes', () => {
  const r = createRecorderController()
  r.setPrechart({ text: 'referral note', files: ['/a.pdf', '', null, '/b.docx'] })
  const p = r.getPrechart()
  assert.strictEqual(p.text, 'referral note')
  assert.deepStrictEqual(p.files, ['/a.pdf', '/b.docx'])
})

test('recorderController getPrechart returns a copy (no aliasing)', () => {
  const r = createRecorderController()
  r.setPrechart({ text: 't', files: ['/a.pdf'] })
  r.getPrechart().files.push('/mutated.pdf')
  assert.deepStrictEqual(r.getPrechart().files, ['/a.pdf'])
})

test('recorderController consumePrechart returns then clears', () => {
  const r = createRecorderController()
  r.setPrechart({ text: 'ctx', files: ['/a.pdf'] })
  const p = r.consumePrechart()
  assert.strictEqual(p.text, 'ctx')
  assert.deepStrictEqual(p.files, ['/a.pdf'])
  assert.deepStrictEqual(r.getPrechart(), { text: '', files: [] })
})

test('recorderController clearProcess resets prechart', () => {
  const r = createRecorderController()
  r.setPrechart({ text: 'ctx', files: ['/a.pdf'] })
  r.clearProcess()
  assert.deepStrictEqual(r.getPrechart(), { text: '', files: [] })
})

test('recorderController setPrechart tolerates missing fields', () => {
  const r = createRecorderController()
  r.setPrechart({})
  assert.deepStrictEqual(r.getPrechart(), { text: '', files: [] })
  r.setPrechart()
  assert.deepStrictEqual(r.getPrechart(), { text: '', files: [] })
})
