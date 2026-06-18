'use strict'

/**
 * Resilient DB-write helpers for the recording pipeline.
 * Each function absorbs failures silently (logs, never throws) so a DB hiccup
 * never blocks the pipeline — matching the inline try/catch behavior throughout
 * main.js. Collapses ~20 identical try/catch blocks into named, testable calls.
 *
 * All functions follow the same pattern:
 *   - Return true on success, false on failure
 *   - Log failures via ctx.log (never console.log)
 *   - Never rethrow
 */

const { getDb } = require('../../db/init')

function getModules() {
  // Lazy-require so this module can be loaded without a live DB
  return {
    dbCases:    require('../../db/cases'),
    dbSessions: require('../../db/sessions'),
    dbEvents:   require('../../db/events'),
  }
}

/**
 * Mark a case as failed and bump the session's failed counter.
 * The two calls are paired — if you mark a case failed, the session count must
 * reflect it so the status window roll-up stays accurate.
 */
function markCaseFailed(caseId, ctx) {
  if (!caseId || !getDb()) return false
  const { dbCases, dbSessions } = getModules()
  try {
    dbCases.setCaseStatus(caseId, 'failed')
    const sessionId = ctx?.stores?.session?.get()?.sessionId
    if (sessionId) dbSessions.bumpSessionCounters(sessionId, { failed: true })
    return true
  } catch (e) {
    ctx?.log?.(`[db] markCaseFailed(${caseId}) failed: ${e.message}`)
    return false
  }
}

/**
 * Update the soap_note_path + set status='converting'.
 * Called just before the docx conversion step so the case row reflects
 * "we know the soap note exists and are converting it."
 */
function markCaseConverting(caseId, soapNotePath, ctx) {
  if (!caseId || !getDb()) return false
  const { dbCases } = getModules()
  try {
    dbCases.updateCasePaths(caseId, { status: 'converting', soap_note_path: soapNotePath })
    return true
  } catch (e) {
    ctx?.log?.(`[db] markCaseConverting(${caseId}) failed: ${e.message}`)
    return false
  }
}

/**
 * Mark a case completed after SOAP docx conversion succeeds.
 * Also bumps the session's success counter.
 */
function markCaseCompleted(caseId, soapDocxPath, ctx) {
  if (!caseId || !getDb()) return false
  const { dbCases, dbSessions } = getModules()
  try {
    dbCases.updateCasePaths(caseId, {
      status:        'completed',
      soap_docx_path: soapDocxPath,
      completed_at:  new Date().toISOString(),
    })
    const sessionId = ctx?.stores?.session?.get()?.sessionId
    if (sessionId) dbSessions.bumpSessionCounters(sessionId, { failed: false })
    return true
  } catch (e) {
    ctx?.log?.(`[db] markCaseCompleted(${caseId}) failed: ${e.message}`)
    return false
  }
}

/**
 * Update the case row to reflect the post-transcription state:
 * status='generating_note', transcript_path set.
 */
function markCaseTranscribed(caseId, transcriptPath, ctx) {
  if (!caseId || !getDb()) return false
  const { dbCases } = getModules()
  try {
    dbCases.updateCasePaths(caseId, { status: 'generating_note', transcript_path: transcriptPath })
    return true
  } catch (e) {
    ctx?.log?.(`[db] markCaseTranscribed(${caseId}) failed: ${e.message}`)
    return false
  }
}

/**
 * Finish a processing_events row. Absorbs failures — a failed event record
 * never blocks the pipeline (the artifact still exists on disk).
 */
function finishEvent(eventId, fields, ctx) {
  if (eventId == null || !getDb()) return false
  const { dbEvents } = getModules()
  try {
    dbEvents.finishEvent(eventId, { ...fields, finishedAt: new Date().toISOString() })
    return true
  } catch (e) {
    ctx?.log?.(`[db] finishEvent(${eventId}) failed: ${e.message}`)
    return false
  }
}

/**
 * Start a processing_events row. Returns the event ID or null on failure.
 */
function startEvent(fields, ctx) {
  if (!getDb()) return null
  const { dbEvents } = getModules()
  try {
    return dbEvents.startEvent({ ...fields, startedAt: new Date().toISOString() })
  } catch (e) {
    ctx?.log?.(`[db] startEvent failed: ${e.message}`)
    return null
  }
}

module.exports = {
  markCaseFailed,
  markCaseConverting,
  markCaseCompleted,
  markCaseTranscribed,
  finishEvent,
  startEvent,
}
