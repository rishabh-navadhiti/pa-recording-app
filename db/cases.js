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

// Update the CDI columns on a case row. Used by spawnCdiReview at three points:
//   1. on start  → { cdi_status: 'running', cdi_mode }
//   2. on success → { cdi_status: 'completed', cdi_*_path, cdi_quality_score, ... }
//   3. on failure → { cdi_status: 'failed' | 'skipped', plus any partial paths }
// Allowed columns are the cdi_* columns added in migration 003. Pass any
// combination — only provided fields are updated. Multi-patient parent (audit)
// rows should never get CDI updates; only single-patient parents and
// multi-patient children own real CDI data.
function updateCaseCdi(id, fields) {
  const db = getDb()
  if (!db || !id) return
  try {
    const allowed = [
      'cdi_status',
      'cdi_mode',
      'cdi_json_path',
      'cdi_md_path',
      'cdi_docx_path',
      'cdi_quality_score',
      'cdi_medical_necessity',
      'cdi_claim_defense_readiness',
      'cdi_clinician_approval_required'
    ]
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
    console.error('[db] updateCaseCdi failed:', e.message)
  }
}

// Look up the full case row by id. Used by the multi-patient split to read
// the parent's recorded_at + doctor_id when inserting child rows.
function getCaseRow(id) {
  const db = getDb()
  if (!db || !id) return null
  try {
    return db.prepare('SELECT * FROM cases WHERE id = ?').get(id) || null
  } catch (e) {
    console.error('[db] getCaseRow failed:', e.message)
    return null
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

// Insert a child case row for a multi-patient split. Used when the app's multi-patient
// branch creates a per-patient folder from the parent recording folder: transcript + MP3
// are already copied in, the SOAP .md is already copied in, and docx is about to be
// generated. The child row is inserted with status='converting' so the existing
// spawnDocxConversion success path flips it to 'completed' + soap_docx_path + completed_at
// just like a single-patient case.
function createChildCase({
  patientName,
  doctorId,
  sessionId,
  caseDir,
  source,
  mp3Path,
  transcriptPath,
  transcriptDocxPath,
  soapNotePath,
  recordedAt
}) {
  const db = getDb()
  if (!db) return null
  try {
    const id = randomUUID()
    const ts = new Date().toISOString()
    db.prepare(`
      INSERT INTO cases
        (id, patient_name, doctor_id, session_id, case_dir, source, mp3_path,
         transcript_path, transcript_docx_path, soap_note_path,
         status, revision, recorded_at, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'converting', 1, ?, ?, ?)
    `).run(
      id,
      patientName || null,
      doctorId || null,
      sessionId || null,
      caseDir,
      source,
      mp3Path || null,
      transcriptPath || null,
      transcriptDocxPath || null,
      soapNotePath || null,
      recordedAt || ts,
      ts,
      ts
    )
    return id
  } catch (e) {
    console.error('[db] createChildCase failed:', e.message)
    return null
  }
}

module.exports = { createCase, createChildCase, updateCaseAudio, updateCasePaths, setCaseStatus, bumpCaseRevision, updateCaseCdi, getCaseRow, getCaseIdByDir, listRecentCases }
