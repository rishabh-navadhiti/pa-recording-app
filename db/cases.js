'use strict'

const { getDb } = require('./init')
const { randomUUID } = require('crypto')

// Insert a new case row right after the case folder + mp3 are in place.
function createCase({ patientName, doctorId, sessionId, caseDir, source, mp3Path, recordedAt }) {
  const db = getDb()
  if (!db) return null
  try {
    const id = randomUUID()
    const ts = new Date().toISOString()
    db.prepare(`
      INSERT INTO cases
        (id, patient_name, doctor_id, session_id, case_dir, source, mp3_path,
         status, revision, recorded_at, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, 'transcribing', 1, ?, ?, ?)
    `).run(id, patientName || null, doctorId || null, sessionId || null,
           caseDir, source, mp3Path || null, recordedAt || ts, ts, ts)
    return id
  } catch (e) {
    console.error('[db] createCase failed:', e.message)
    return null
  }
}

function formatDuration(seconds) {
  if (seconds == null) return null
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

// Update audio metadata fields (populated after record.py exits).
function updateCaseAudio(id, { durationSeconds, sizeBytes }) {
  const db = getDb()
  if (!db || !id) return
  try {
    db.prepare(`
      UPDATE cases SET audio_duration = ?, audio_size_bytes = ?, updated_at = ? WHERE id = ?
    `).run(formatDuration(durationSeconds), sizeBytes ?? null, new Date().toISOString(), id)
  } catch (e) {
    console.error('[db] updateCaseAudio failed:', e.message)
  }
}

// Update file paths and/or status in one call.
function updateCasePaths(id, fields) {
  const db = getDb()
  if (!db || !id) return
  try {
    const allowed = ['status', 'transcript_path', 'transcript_docx_path', 'soap_note_path', 'soap_docx_path', 'completed_at']
    const sets = []
    const vals = []
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v) }
    }
    if (sets.length === 0) return
    sets.push('updated_at = ?')
    vals.push(new Date().toISOString(), id)
    db.prepare(`UPDATE cases SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  } catch (e) {
    console.error('[db] updateCasePaths failed:', e.message)
  }
}

function setCaseStatus(id, status) {
  const db = getDb()
  if (!db || !id) return
  try {
    db.prepare('UPDATE cases SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id)
  } catch (e) {
    console.error('[db] setCaseStatus failed:', e.message)
  }
}

function bumpCaseRevision(id) {
  const db = getDb()
  if (!db || !id) return
  try {
    const ts = new Date().toISOString()
    db.prepare('UPDATE cases SET revision = revision + 1, last_edited_at = ?, updated_at = ? WHERE id = ?')
      .run(ts, ts, id)
  } catch (e) {
    console.error('[db] bumpCaseRevision failed:', e.message)
  }
}

function updateCaseIcd(id, { icdStatus }) {
  const db = getDb()
  if (!db || !id) return
  try {
    db.prepare('UPDATE cases SET icd_status = ?, updated_at = ? WHERE id = ?')
      .run(icdStatus ?? null, new Date().toISOString(), id)
  } catch (e) {
    process.stderr.write(`[db] updateCaseIcd failed: ${e.message}\n`)
  }
}

// Look up a case id by its absolute folder path.
function getCaseIdByDir(caseDir) {
  const db = getDb()
  if (!db) return null
  try {
    const row = db.prepare('SELECT id FROM cases WHERE case_dir = ?').get(caseDir)
    return row ? row.id : null
  } catch (e) {
    console.error('[db] getCaseIdByDir failed:', e.message)
    return null
  }
}

// Return up to `limit` recent cases that have a soap note, ordered by recorded_at desc.
function listRecentCases(limit = 30) {
  const db = getDb()
  if (!db) return null  // null = DB unavailable, caller falls back to filesystem walk
  try {
    return db.prepare(`
      SELECT id, patient_name AS patient, case_dir AS caseDir,
             recorded_at AS date, soap_note_path AS soapNotePath
      FROM cases
      WHERE soap_note_path IS NOT NULL
      ORDER BY recorded_at DESC
      LIMIT ?
    `).all(limit)
  } catch (e) {
    console.error('[db] listRecentCases failed:', e.message)
    return null
  }
}

module.exports = { createCase, updateCaseAudio, updateCasePaths, setCaseStatus, bumpCaseRevision, getCaseIdByDir, listRecentCases, updateCaseIcd }
