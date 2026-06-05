'use strict'

const { ELEVENLABS_AUTH_ERROR, ELEVENLABS_RATE_LIMITED } = require('../llm/skill-io/markers')
const { transcribeToFile } = require('./elevenLabs')

/**
 * Transcribe an MP3 via ElevenLabs (in-process, Node — see elevenLabs.js) and
 * drive the post-transcription chain. Kept the name `spawnTranscription` so the
 * call sites are unchanged; as of Phase 5 it no longer spawns a Python child —
 * the work is an awaited fetch, fired-and-forgotten here (callers don't await).
 *
 * @param {object}   opts
 * @param {string}   opts.mp3Path          Absolute path to the source MP3.
 * @param {string}   opts.transcriptDest   Where to write transcript.md.
 * @param {string}   opts.soapNotePath     Expected SOAP note output path (passed down chain).
 * @param {string}   opts.caseTag          Recording folder name for log tagging.
 * @param {string}   [opts.templatePath]   Doctor template absolute path.
 * @param {string}   [opts.caseId]         DB cases row ID.
 * @param {AppContext} opts.ctx
 * @param {Function} opts.onSuccess        Called on transcription success:
 *                                         (transcriptDest, soapNotePath, caseTag, templatePath, caseId, ctx) => void
 *                                         Typically triggers SOAP generation.
 * @param {Function} opts.spawnDocx        spawnDocxConversion(mdPath, caseTag, null, caseId) — for transcript.docx.
 */
function spawnTranscription({ mp3Path, transcriptDest, soapNotePath, caseTag, templatePath, caseId, ctx, onSuccess, spawnDocx }) {
  const { log } = ctx
  const tag = caseTag ? `[${caseTag}] ` : ''
  const wallStart = Date.now()
  const startedAt = new Date().toISOString()

  let eventId = null
  try {
    const { dbEvents } = requireDb()
    eventId = dbEvents.startEvent({ caseId, jobKind: 'transcribe', startedAt })
  } catch (e) { log(`[db] startEvent(transcribe) failed: ${e.message}`) }

  log(`${tag}Transcription started for: ${mp3Path}`)

  const apiKey = ctx.secrets.getElevenLabsKey()

  Promise.resolve()
    .then(() => {
      if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured')
      return transcribeToFile({ mp3Path, transcriptDest, apiKey })
    })
    .then(() => {
      log(`${tag}[transcribe] completed`)
      const durationMs = Date.now() - wallStart
      const { dbEvents, dbCases } = requireDb()
      try {
        dbEvents.finishEvent(eventId, { status: 'success', durationMs, finishedAt: new Date().toISOString() })
        dbCases.updateCasePaths(caseId, { status: 'generating_note', transcript_path: transcriptDest })
      } catch (e) { log(`[db] transcribe success update failed: ${e.message}`) }

      if (onSuccess) onSuccess(transcriptDest, soapNotePath, caseTag, templatePath, caseId, ctx)
      if (spawnDocx) spawnDocx(transcriptDest, caseTag, null, caseId)
    })
    .catch(err => {
      const errText = (err && err.message) ? err.message : String(err)
      log(`${tag}[transcribe ERR] ${errText}`)
      const durationMs = Date.now() - wallStart
      const { dbEvents, dbCases, dbSessions } = requireDb()
      try {
        dbEvents.finishEvent(eventId, { status: 'failed', durationMs, errorMessage: errText.slice(0, 1024), finishedAt: new Date().toISOString() })
        dbCases.setCaseStatus(caseId, 'failed')
        const sessionId = ctx.stores.session.get().sessionId
        if (caseId && sessionId) dbSessions.bumpSessionCounters(sessionId, { failed: true })
      } catch (e) { log(`[db] transcribe failure update failed: ${e.message}`) }

      if (caseTag) ctx.stores.recordings.updateStatus(caseTag, 'failed')

      // Classify via the shared markers (errText carries the HTTP status code).
      if (ELEVENLABS_AUTH_ERROR.test(errText)) {
        ctx.renderer.send('service-warning', {
          title:   'ElevenLabs API key invalid',
          message: 'Your API key was rejected. Update it in Settings to resume transcription.'
        })
      } else if (ELEVENLABS_RATE_LIMITED.test(errText)) {
        ctx.renderer.send('service-warning', {
          title:   'ElevenLabs quota exceeded',
          message: 'Your ElevenLabs usage limit has been reached. Transcription could not complete.'
        })
      } else {
        ctx.platform.notify('Transcription failed', `Case: ${caseTag || 'unknown'} — check app.log for details`)
      }
    })
}

let _db = null
function requireDb() {
  if (!_db) _db = {
    dbEvents:   require('../../db/events'),
    dbCases:    require('../../db/cases'),
    dbSessions: require('../../db/sessions'),
  }
  return _db
}

module.exports = { spawnTranscription }
