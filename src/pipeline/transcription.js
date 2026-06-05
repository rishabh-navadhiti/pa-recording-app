'use strict'

const path = require('path')
const { spawn } = require('child_process')

const { ELEVENLABS_AUTH_ERROR, ELEVENLABS_RATE_LIMITED } = require('../llm/skill-io/markers')

/**
 * Spawn transcribe.py against an MP3 and drive the post-transcription chain.
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
  const { log, python } = ctx
  const tag = caseTag ? `[${caseTag}] ` : ''
  const stderrChunks = []
  const wallStart = Date.now()
  const startedAt = new Date().toISOString()

  let eventId = null
  try {
    const { dbEvents } = requireDb()
    eventId = dbEvents.startEvent({ caseId, jobKind: 'transcribe', startedAt })
  } catch (e) { log(`[db] startEvent(transcribe) failed: ${e.message}`) }

  const appRoot = path.join(__dirname, '..', '..')
  const transcribeProc = spawn(python, [
    path.join(appRoot, 'python', 'transcribe.py'),
    '--input',  mp3Path,
    '--output', transcriptDest,
  ], { cwd: appRoot, stdio: 'pipe' })

  transcribeProc.stdout.on('data', d => log(`${tag}[transcribe] ${d.toString().trim()}`))
  transcribeProc.stderr.on('data', d => {
    const msg = d.toString()
    stderrChunks.push(msg)
    log(`${tag}[transcribe ERR] ${msg.trim()}`)
  })

  transcribeProc.on('close', code => {
    log(`${tag}[transcribe] exited ${code}`)
    const durationMs = Date.now() - wallStart
    const { dbEvents, dbCases, dbSessions } = requireDb()

    if (code === 0) {
      try {
        dbEvents.finishEvent(eventId, { status: 'success', durationMs, finishedAt: new Date().toISOString() })
        dbCases.updateCasePaths(caseId, { status: 'generating_note', transcript_path: transcriptDest })
      } catch (e) { log(`[db] transcribe success update failed: ${e.message}`) }

      if (onSuccess) onSuccess(transcriptDest, soapNotePath, caseTag, templatePath, caseId, ctx)
      if (spawnDocx) spawnDocx(transcriptDest, caseTag, null, caseId)
    } else {
      const stderr = stderrChunks.join('')
      try {
        dbEvents.finishEvent(eventId, { status: 'failed', durationMs, errorMessage: stderr.slice(0, 1024), finishedAt: new Date().toISOString() })
        dbCases.setCaseStatus(caseId, 'failed')
        const sessionId = ctx.stores.session.get().sessionId
        if (caseId && sessionId) dbSessions.bumpSessionCounters(sessionId, { failed: true })
      } catch (e) { log(`[db] transcribe failure update failed: ${e.message}`) }

      if (caseTag) ctx.stores.recordings.updateStatus(caseTag, 'failed')

      if (ELEVENLABS_AUTH_ERROR.test(stderr)) {
        ctx.renderer.send('service-warning', {
          title:   'ElevenLabs API key invalid',
          message: 'Your API key was rejected. Update it in Settings to resume transcription.'
        })
      } else if (ELEVENLABS_RATE_LIMITED.test(stderr)) {
        ctx.renderer.send('service-warning', {
          title:   'ElevenLabs quota exceeded',
          message: 'Your ElevenLabs usage limit has been reached. Transcription could not complete.'
        })
      } else {
        ctx.platform.notify('Transcription failed', `Case: ${caseTag || 'unknown'} — check app.log for details`)
      }
    }
  })

  log(`${tag}Transcription started for: ${mp3Path}`)
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
