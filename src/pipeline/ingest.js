'use strict'

const fs   = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const { DURATION_SECONDS: DURATION_RE } = require('../llm/skill-io/markers')
const { buildCaseFolder } = require('./artifacts')

/**
 * Shared ingest core used by both stop-recording and process-audio-file.
 *
 * Handles: case folder creation → audio copy → DB row → audio metadata →
 * recordings store entry → transcription chain.
 *
 * @param {object}   opts
 * @param {string}   opts.audioSrc        Source audio file (temp MP3 or uploaded file).
 * @param {string}   opts.audioDestName   Filename for the destination (e.g. 'jane_doe.mp3').
 * @param {string}   opts.patientName     Sanitized patient slug (null for unnamed recordings).
 * @param {string}   opts.source          'recording' | 'upload'
 * @param {string}   opts.doctorId        DB doctor ID.
 * @param {string}   [opts.templatePath]  Doctor template path.
 * @param {number}   [opts.capturedDuration]  Duration in seconds from recorder (null = probe).
 * @param {boolean}  [opts.moveAudio]     True → move (copy+unlink) instead of copy.
 * @param {boolean}  [opts.probeDuration] True → probe duration via probe_duration.py.
 * @param {AppContext} opts.ctx
 * @param {Function} opts.spawnTranscription  The _callSpawnTranscription shim from main.js.
 * @returns {{ ok: boolean, caseId: string|null, caseDir: string|null }}
 */
function ingestAudio(opts) {
  const {
    audioSrc, audioDestName, patientName, source,
    doctorId, templatePath, capturedDuration,
    moveAudio = false, probeDuration = false,
    ctx, spawnTranscription,
    realtimeTranscriptSrc = null,
    prechartSrc = null,
  } = opts

  const { log } = ctx

  // ---- 1. Case folder -------------------------------------------------------
  const { caseDir, folderName } = buildCaseFolder(patientName, ctx)
  const audioDest    = path.join(caseDir, audioDestName)
  const transcriptDest = path.join(caseDir, 'transcript.md')
  const soapNotePath = path.join(caseDir, `${folderName}_soap_note.md`)

  // ---- 2. Copy (or move) audio file ----------------------------------------
  try {
    fs.copyFileSync(audioSrc, audioDest)
    if (moveAudio) {
      try { fs.unlinkSync(audioSrc) } catch (e) { log(`[ingest] unlink temp MP3 failed: ${e.message}`) }
    }
    log(`[ingest] Audio → ${audioDest}`)
  } catch (e) {
    log(`[ingest] ERROR copying audio: ${e.message}`)
    return { ok: false, caseId: null, caseDir }
  }

  // ---- 2a. Copy realtime transcript JSON (if present) ----------------------
  if (realtimeTranscriptSrc && fs.existsSync(realtimeTranscriptSrc)) {
    const realtimeJsonDest = audioDest.replace(/\.mp3$/, '_realtime.json')
    try {
      fs.copyFileSync(realtimeTranscriptSrc, realtimeJsonDest)
      try { fs.unlinkSync(realtimeTranscriptSrc) } catch (_) {}
      log(`[ingest] Realtime transcript → ${realtimeJsonDest}`)
    } catch (e) {
      log(`[ingest] realtime JSON copy failed: ${e.message}`)
    }
  }

  // ---- 2b. Copy in-recording pre-chart context (if present) ----------------
  // Written before transcription/SOAP generation so generateSoapViaApi finds it.
  // Hidden on Windows like the other internal .md files in the case folder.
  if (prechartSrc && fs.existsSync(prechartSrc)) {
    const prechartDest = path.join(caseDir, 'prechart.md')
    try {
      fs.copyFileSync(prechartSrc, prechartDest)
      ctx.platform.hideInternal(prechartDest)
      log(`[ingest] Pre-chart context → ${prechartDest}`)
    } catch (e) {
      log(`[ingest] pre-chart copy failed: ${e.message}`)
    }
  }

  // ---- 3. Create DB case row ------------------------------------------------
  const { sessionId } = ctx.stores.session.get()
  let caseId = null
  const audioSizeBytes = fs.existsSync(audioDest) ? fs.statSync(audioDest).size : null
  try {
    const { dbCases } = requireDb()
    caseId = dbCases.createCase({
      // Unnamed recording/upload → fall back to the auto-generated folder name
      // (e.g. recording_2026-06-05_11-56-07) instead of storing NULL, so the case
      // is identifiable in the DB + status popup and matches the folder on disk.
      patientName:  patientName || folderName,
      doctorId:     doctorId || null,
      sessionId:    sessionId || null,
      caseDir,
      source,
      mp3Path:      audioDest,
      recordedAt:   new Date().toISOString(),
    })
    if (caseId) {
      dbCases.updateCaseAudio(caseId, {
        durationSeconds: capturedDuration ?? null,
        sizeBytes: audioSizeBytes,
      })
    }
  } catch (e) {
    log(`[db] createCase(${source}) failed: ${e.message}`)
  }

  // ---- 4. Async duration probe (upload path only) --------------------------
  if (probeDuration && caseId && fs.existsSync(audioDest)) {
    const appRoot = path.join(__dirname, '..', '..')
    const probeProc = spawn(ctx.python, [path.join(appRoot, 'python', 'probe_duration.py'), audioDest], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let probeBuf = ''
    probeProc.stdout.on('data', d => { probeBuf += d.toString() })
    probeProc.on('close', code => {
      if (code === 0) {
        const m = probeBuf.match(DURATION_RE)
        if (m) {
          try {
            requireDb().dbCases.updateCaseAudio(caseId, {
              durationSeconds: parseFloat(m[1]),
              sizeBytes: audioSizeBytes,
            })
          } catch (_) {}
          log(`[ingest] Duration probed: ${m[1]}s`)
        }
      }
    })
    probeProc.on('error', () => {})  // non-fatal
  }

  // ---- 5. Recordings store entry -------------------------------------------
  ctx.stores.recordings.add({
    caseTag:     folderName,
    // Unnamed → show the folder default (recording_<date>_<time>) in the status
    // popup rather than a blank name. Named → prettify the slug for display.
    displayName: patientName ? patientName.replace(/_/g, ' ') : folderName,
  })

  // ---- 6. Start transcription chain ----------------------------------------
  spawnTranscription(audioDest, transcriptDest, soapNotePath, folderName, templatePath, caseId)

  return { ok: true, caseId, caseDir }
}

let _db = null
function requireDb() {
  if (!_db) _db = { dbCases: require('../../db/cases') }
  return _db
}

module.exports = { ingestAudio }
