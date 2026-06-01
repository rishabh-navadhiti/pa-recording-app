'use strict'

const { getDb } = require('./init')

// Insert a "started" event row. Returns the row id (integer) or null on failure.
function startEvent({ caseId, jobKind, relatedDoctorId, modelUsed, effort, startedAt }) {
  const db = getDb()
  if (!db) return null
  try {
    const info = db.prepare(`
      INSERT INTO processing_events (case_id, job_kind, related_doctor_id, status, model_used, effort, started_at)
      VALUES (?, ?, ?, 'started', ?, ?, ?)
    `).run(caseId || null, jobKind, relatedDoctorId || null, modelUsed || null, effort || null, startedAt || new Date().toISOString())
    return info.lastInsertRowid
  } catch (e) {
    console.error(`[db] startEvent(${jobKind}) failed:`, e.message)
    return null
  }
}

// Update the event row when the job finishes.
function finishEvent(eventId, {
  status,
  inputTokens, outputTokens, cacheReadTokens, cacheCreatedTokens,
  costUsd, numTurns, durationMs,
  errorMessage, backupPath, finishedAt
}) {
  const db = getDb()
  if (!db || eventId == null) return
  try {
    const info = db.prepare(`
      UPDATE processing_events SET
        status               = ?,
        input_tokens         = ?,
        output_tokens        = ?,
        cache_read_tokens    = ?,
        cache_created_tokens = ?,
        cost_usd             = ?,
        num_turns            = ?,
        duration_ms          = ?,
        error_message        = ?,
        backup_path          = ?,
        finished_at          = ?
      WHERE id = ?
    `).run(
      status,
      inputTokens         ?? null,
      outputTokens        ?? null,
      cacheReadTokens     ?? null,
      cacheCreatedTokens  ?? null,
      costUsd             ?? null,
      numTurns            ?? null,
      durationMs          ?? null,
      errorMessage        ? errorMessage.slice(0, 1024) : null,
      backupPath          ?? null,
      finishedAt          || new Date().toISOString(),
      eventId
    )
    if (info.changes === 0) {
      process.stderr.write(`[db] finishEvent(${eventId}): UPDATE matched 0 rows — event ID may be stale\n`)
    }
  } catch (e) {
    process.stderr.write(`[db] finishEvent(${eventId}) failed: ${e.message}\n`)
  }
}

module.exports = { startEvent, finishEvent }
