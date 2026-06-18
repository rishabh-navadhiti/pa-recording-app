'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

// caseStatus uses getDb() — inject an in-memory DB via initDbWith before importing.
const Database = require('better-sqlite3')
const { initDbWith, runMigrations } = require('../../db/init')

let db
function setupDb() {
  db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  initDbWith(db)
  runMigrations(db)
}

// Build a minimal fake ctx with a session store
function fakeCtx(sessionId = 'sess-1') {
  const logs = []
  return {
    log: (msg) => logs.push(msg),
    stores: { session: { get: () => ({ sessionId }) } },
    _logs: logs,
  }
}

// We need to re-require caseStatus after the DB is set up
// (module is cached, but getDb() is called lazily per invocation)

test('markCaseFailed sets status=failed and bumps session counter', () => {
  setupDb()
  const { markCaseFailed } = require('../../src/pipeline/caseStatus')
  const { dbDoctors: _d, ..._ } = {}  // just ensure modules resolve

  // Insert a minimal session + case to work with
  const dbCases = require('../../db/cases')
  const dbSessions = require('../../db/sessions')
  const sessId = dbSessions.startSession({ sessionFolder: '/tmp/sess', doctorId: null })
  const caseId = dbCases.createCase({ patientName: 'Jane', doctorId: null, sessionId: sessId, caseDir: '/tmp/case1', source: 'recording', recordedAt: new Date().toISOString() })

  const ctx = fakeCtx(sessId)
  const result = markCaseFailed(caseId, ctx)
  assert.strictEqual(result, true)

  const row = dbCases.getCaseRow(caseId)
  assert.strictEqual(row.status, 'failed')
  const sess = db.prepare('SELECT failed_count FROM sessions WHERE id = ?').get(sessId)
  assert.strictEqual(sess.failed_count, 1)
})

test('markCaseFailed returns false and does not throw when db is null', () => {
  // Temporarily null out the db
  const origDb = db
  initDbWith(null)
  const { markCaseFailed } = require('../../src/pipeline/caseStatus')
  const result = markCaseFailed('nonexistent', fakeCtx())
  assert.strictEqual(result, false)
  initDbWith(origDb)  // restore
})

test('markCaseCompleted sets status=completed and bumps session success', () => {
  setupDb()
  const { markCaseCompleted } = require('../../src/pipeline/caseStatus')
  const dbCases = require('../../db/cases')
  const dbSessions = require('../../db/sessions')
  const sessId = dbSessions.startSession({ sessionFolder: '/tmp/sess2', doctorId: null })
  const caseId = dbCases.createCase({ patientName: 'John', doctorId: null, sessionId: sessId, caseDir: '/tmp/case2', source: 'recording', recordedAt: new Date().toISOString() })

  const ctx = fakeCtx(sessId)
  markCaseCompleted(caseId, '/tmp/case2/john.docx', ctx)

  const row = dbCases.getCaseRow(caseId)
  assert.strictEqual(row.status, 'completed')
  assert.ok(row.soap_docx_path.endsWith('.docx'))
  const sess = db.prepare('SELECT case_count FROM sessions WHERE id = ?').get(sessId)
  assert.strictEqual(sess.case_count, 1)
})

test('startEvent returns null when db is null', () => {
  initDbWith(null)
  const { startEvent } = require('../../src/pipeline/caseStatus')
  const result = startEvent({ jobKind: 'soap', caseId: 'x' }, fakeCtx())
  assert.strictEqual(result, null)
  initDbWith(db)
})

test('finishEvent returns false and logs when eventId is null', () => {
  const { finishEvent } = require('../../src/pipeline/caseStatus')
  const ctx = fakeCtx()
  const result = finishEvent(null, { status: 'success' }, ctx)
  assert.strictEqual(result, false)
})
