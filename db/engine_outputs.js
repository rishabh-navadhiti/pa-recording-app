'use strict'

const { getDb } = require('./init')

// Record one engine run in the generic engine_outputs index. Called from a v0.2
// engine descriptor's persist() (em-score, patient-summary) after the engine's
// on-disk JSON has been written. Unlike CDI, these engines don't get per-engine
// columns on `cases` — each run is one row keyed by (case_id, engine).
//
//   caseId      — the case row this output belongs to (single-patient: the case
//                 row; multi-patient: the child row).
//   engine      — engine id, e.g. 'em-score' | 'patient-summary'.
//   status      — terminal run status: 'ok' | 'skipped' | 'failed'.
//   jsonPath    — abs path to the on-disk JSON the engine wrote (nullable).
//   summaryJson — an object of compact headline fields for list views; it is
//                 JSON-stringified on the way in (null-safe). Callers reading
//                 back can JSON.parse to restore.
//   eventId     — id of the processing_events row for this run (nullable).
//
// Returns the inserted row id, or 0 on any failure (best-effort — DB write
// failures must not break the pipeline).
function insertOutput({ caseId, engine, status, jsonPath, summaryJson, eventId }) {
  const db = getDb()
  if (!db || !caseId || !engine) return 0
  try {
    const ts = new Date().toISOString()
    const info = db.prepare(`
      INSERT INTO engine_outputs (
        case_id, engine, status, json_path, summary_json, event_id, created_at
      ) VALUES (
        @case_id, @engine, @status, @json_path, @summary_json, @event_id, @created_at
      )
    `).run({
      case_id:      caseId,
      engine:       String(engine),
      status:       String(status || ''),
      json_path:    jsonPath || null,
      summary_json: summaryJson != null ? JSON.stringify(summaryJson) : null,
      event_id:     eventId ?? null,
      created_at:   ts
    })
    return Number(info.lastInsertRowid) || 0
  } catch (e) {
    console.error('[db] insertOutput failed:', e.message)
    return 0
  }
}

// List the engine outputs attached to a case, newest first. Used by list/detail
// views that render the v0.2 engine results from JSON. Returns [] on failure.
function listOutputsForCase(caseId) {
  const db = getDb()
  if (!db || !caseId) return []
  try {
    return db.prepare(`
      SELECT id, case_id, engine, status, json_path, summary_json, event_id, created_at
      FROM engine_outputs
      WHERE case_id = ?
      ORDER BY created_at DESC
    `).all(caseId)
  } catch (e) {
    console.error('[db] listOutputsForCase failed:', e.message)
    return []
  }
}

module.exports = { insertOutput, listOutputsForCase }
