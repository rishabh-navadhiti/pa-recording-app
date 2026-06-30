'use strict'

const fs   = require('fs')
const path = require('path')

const { ELEVENLABS_AUTH_ERROR, ELEVENLABS_RATE_LIMITED } = require('../llm/skill-io/markers')
const { transcribeToFile, ELEVENLABS_MODEL, SCRIBE_V2_COST_PER_HOUR_USD, SCRIBE_V2_REALTIME_COST_PER_HOUR_USD, readRealtimeTranscript, formatTranscriptPlain } = require('./elevenLabs')

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
// Parse cases.audio_duration ('HH:MM:SS' string) back to seconds for cost calculation.
function parseHHMMSS(raw) {
  if (raw == null) return null
  if (typeof raw === 'number') return raw
  const parts = String(raw).split(':').map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) return null
  return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

function spawnTranscription({ mp3Path, transcriptDest, soapNotePath, caseTag, templatePath, caseId, ctx, onSuccess, spawnDocx }) {
  const { log } = ctx
  const tag = caseTag ? `[${caseTag}] ` : ''
  const wallStart = Date.now()
  const startedAt = new Date().toISOString()

  let eventId = null
  try {
    const { dbEvents } = requireDb()
    eventId = dbEvents.startEvent({ caseId, jobKind: 'transcribe', modelUsed: ELEVENLABS_MODEL, startedAt })
  } catch (e) { log(`[db] startEvent(transcribe) failed: ${e.message}`) }

  log(`${tag}Transcription started for: ${mp3Path}`)

  const apiKey = ctx.secrets.getElevenLabsKey()

  Promise.resolve()
    .then(() => {
      // Check for a realtime transcript written by Python alongside the MP3.
      // If present and non-empty, use it immediately (no API call needed).
      const realtimeJsonPath = mp3Path.replace(/\.mp3$/, '_realtime.json')
      const realtimeData = readRealtimeTranscript(realtimeJsonPath)
      if (realtimeData) {
        log(`${tag}[transcribe] Using realtime transcript from ${realtimeJsonPath}`)
        // Realtime → plain transcript (no Speaker N labels). The only "speakers"
        // here are mic-vs-call, which aren't clinically meaningful.
        const markdown = formatTranscriptPlain(realtimeData)
        fs.mkdirSync(path.dirname(transcriptDest), { recursive: true })
        fs.writeFileSync(transcriptDest, markdown, 'utf8')
        return { markdown, isRealtime: true }
      }
      // No realtime JSON — fall back to batch API (scribe_v2, $0.22/hr).
      log(`${tag}[transcribe] No realtime transcript — using batch API`)
      return transcribeToFile({ mp3Path, transcriptDest, apiKey })
        .then(result => ({ ...result, isRealtime: false }))
    })
    .then(({ languageCode, speakerCount, audioDurationSeconds, isRealtime }) => {
      // Transcription itself succeeded — record it. The post-success callbacks
      // (SOAP gen + transcript docx) run in the FINAL .then below, OUTSIDE the
      // .catch — so a synchronous throw in their setup is a SOAP/docx defect, not
      // a transcription failure, and must not flip the case to failed or warn.
      log(`${tag}[transcribe] completed`)
      const durationMs = Date.now() - wallStart
      const { dbEvents, dbCases } = requireDb()
      // ElevenLabs doesn't return audio_duration; read cases.audio_duration instead.
      // That column stores a formatted 'HH:MM:SS' string (see db/cases.js formatDuration).
      const rawDuration = audioDurationSeconds
        ?? (caseId ? (dbCases.getCaseRow(caseId) || {}).audio_duration : null)
      const resolvedDuration = parseHHMMSS(rawDuration)
      // Realtime (scribe_v2_realtime) is billed at $0.39/hr; batch at $0.22/hr.
      const ratePerHour = isRealtime ? SCRIBE_V2_REALTIME_COST_PER_HOUR_USD : SCRIBE_V2_COST_PER_HOUR_USD
      const costUsd = resolvedDuration != null
        ? (resolvedDuration / 3600) * ratePerHour
        : null
      try {
        dbEvents.finishEvent(eventId, {
          status: 'success', durationMs, finishedAt: new Date().toISOString(),
          costUsd,
          transcriptLanguage:     languageCode,
          transcriptSpeakerCount: speakerCount,
        })
        dbCases.updateCasePaths(caseId, { status: 'generating_note', transcript_path: transcriptDest })
      } catch (e) { log(`[db] transcribe success update failed: ${e.message}`) }
      return true
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
      return false
    })
    .then(ok => {
      if (!ok) return
      // Post-success chain. Wrapped so a throw here is logged, not re-attributed
      // to transcription (the transcript is already written + the case is already
      // 'generating_note'). spawn()'s own failures surface via proc.on('error').
      try { if (onSuccess) onSuccess(transcriptDest, soapNotePath, caseTag, templatePath, caseId, ctx) }
      catch (e) { log(`${tag}[transcribe] onSuccess threw (post-success): ${e.message}`) }
      try { if (spawnDocx) spawnDocx(transcriptDest, caseTag, null, caseId) }
      catch (e) { log(`${tag}[transcribe] spawnDocx threw (post-success): ${e.message}`) }
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
