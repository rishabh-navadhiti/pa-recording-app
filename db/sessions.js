'use strict'

const { getDb } = require('./init')
const { randomUUID } = require('crypto')

function startSession({ sessionFolder, doctorId }) {
  const db = getDb()
  if (!db) return null
  try {
    const id  = randomUUID()
    const ts  = new Date().toISOString()
    db.prepare(`
      INSERT INTO sessions (id, session_folder, doctor_id, started_at, case_count, failed_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    `).run(id, sessionFolder, doctorId || null, ts, ts, ts)
    return id
  } catch (e) {
    console.error('[db] startSession failed:', e.message)
    return null
  }
}

function endSession(id) {
  const db = getDb()
  if (!db) return
  try {
    const ts = new Date().toISOString()
    db.prepare('UPDATE sessions SET ended_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id)
  } catch (e) {
    console.error('[db] endSession failed:', e.message)
  }
}

// Increment case_count (and optionally failed_count) when a case reaches terminal state.
function bumpSessionCounters(id, { failed = false } = {}) {
  const db = getDb()
  if (!db || !id) return
  try {
    const ts = new Date().toISOString()
    db.prepare(`
      UPDATE sessions
      SET case_count   = case_count + 1,
          failed_count = failed_count + ?,
          updated_at   = ?
      WHERE id = ?
    `).run(failed ? 1 : 0, ts, id)
  } catch (e) {
    console.error('[db] bumpSessionCounters failed:', e.message)
  }
}

module.exports = { startSession, endSession, bumpSessionCounters }
