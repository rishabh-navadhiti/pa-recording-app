'use strict'

const { getDb } = require('./init')

// Bulk-insert the flags from a CDI run, attached to the case row that owns
// the SOAP they flagged. Called from main.js's spawnCdiReview success path
// after the <stem>_cdi.json file has been read and parsed.
//
//   caseId       — the row to attach flags to (single-patient: the case row;
//                  multi-patient: the child row). Parent (audit) rows in
//                  multi-patient runs must never receive cdi_flags entries.
//   cdiRunId     — id of the processing_events row for this CDI run (nullable;
//                  set when the event was recorded successfully).
//   flags        — array of flag objects from the cdi JSON's `flags[]`. Each
//                  flag's `evidence_found`, `evidence_missing`, and
//                  `suggested_codes` arrays are JSON-stringified on the way in;
//                  callers reading back can JSON.parse to restore.
//
// Returns the number of rows inserted, or 0 on any failure (best-effort —
// DB write failures must not break the pipeline).
function insertFlags(caseId, cdiRunId, flags) {
  const db = getDb()
  if (!db || !caseId || !Array.isArray(flags) || flags.length === 0) return 0
  try {
    const ts = new Date().toISOString()
    const insert = db.prepare(`
      INSERT INTO cdi_flags (
        case_id, cdi_run_id, flag_index, type, category, title, body,
        guideline_reference, current_code, suggested_codes, confidence,
        evidence_found, evidence_missing, created_at
      ) VALUES (
        @case_id, @cdi_run_id, @flag_index, @type, @category, @title, @body,
        @guideline_reference, @current_code, @suggested_codes, @confidence,
        @evidence_found, @evidence_missing, @ts
      )
    `)
    const txn = db.transaction(rows => {
      for (const r of rows) insert.run(r)
    })
    const rows = flags.map((f, i) => ({
      case_id:             caseId,
      cdi_run_id:          cdiRunId ?? null,
      flag_index:          i + 1,
      type:                String(f.type || ''),
      category:            String(f.category || ''),
      title:               String(f.title || '').slice(0, 1024),
      body:                String(f.body || ''),
      guideline_reference: f.guideline_reference || null,
      current_code:        f.current_code || null,
      suggested_codes:     f.suggested_codes ? JSON.stringify(f.suggested_codes) : null,
      confidence:          Number.isInteger(f.confidence) ? f.confidence : Math.round(Number(f.confidence) || 0),
      evidence_found:      f.evidence_found   ? JSON.stringify(f.evidence_found)   : null,
      evidence_missing:    f.evidence_missing ? JSON.stringify(f.evidence_missing) : null,
      ts
    }))
    txn(rows)
    return rows.length
  } catch (e) {
    console.error('[db] insertFlags failed:', e.message)
    return 0
  }
}

// Delete all flags attached to a case. Used when CDI re-runs on the same case
// (future v1.1 feature — pre-chart auto re-run). Safe no-op if the row has no
// flags yet.
function deleteFlagsForCase(caseId) {
  const db = getDb()
  if (!db || !caseId) return
  try {
    db.prepare('DELETE FROM cdi_flags WHERE case_id = ?').run(caseId)
  } catch (e) {
    console.error('[db] deleteFlagsForCase failed:', e.message)
  }
}

module.exports = { insertFlags, deleteFlagsForCase }
