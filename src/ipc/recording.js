'use strict'

const { CHANNELS } = require('../shared/ipc-channels')

const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const { DURATION_SECONDS: DURATION_RE } = require('../llm/skill-io/markers')
const { buildPrechartTempFile } = require('../pipeline/attachments')

// Recording-lifecycle IPC handlers, moved verbatim from main.js's
// registerIpcHandlers(). Handler bodies are byte-identical except __dirname
// (which in the original resolved to the repo root) is replaced by the
// appRoot value passed through deps -- necessary because these files live in
// src/ipc/, where the literal __dirname would point at the wrong directory.
function registerRecordingIpc(ipcMain, appCtx, deps) {
  const {
    log, setState, STATE, appRoot, readSettings, waitForExit, notifyUser,
    sanitizeName, dbDoctors, getAllDoctors, ingestAudio, _callSpawnTranscription,
  } = deps

  // ---- start-recording ----
  ipcMain.handle(CHANNELS.START_RECORDING, () => {
    log('start-recording')
    const tmpMp3 = path.join(os.tmpdir(), `rec_${Date.now()}.mp3`)
    log(`Temp MP3: ${tmpMp3}`)

    const settings = readSettings()
    const recordArgs = [
      path.join(appRoot, 'python', 'record.py'),
      '--output', tmpMp3
    ]
    if (settings.manualDeviceSelection && settings.selectedDeviceIndex != null) {
      recordArgs.push('--device', String(settings.selectedDeviceIndex))
      log(`Using manual device index: ${settings.selectedDeviceIndex}`)
    }
    if (settings.realtimeTranscription) {
      const apiKey = appCtx.secrets.getElevenLabsKey() || ''
      const realtimeJsonPath = tmpMp3.replace('.mp3', '_realtime.json')
      recordArgs.push('--realtime', '--api-key', apiKey, '--realtime-output', realtimeJsonPath)
      log(`Realtime transcription enabled → ${realtimeJsonPath}`)
    }
    if (settings.enableMic) {
      recordArgs.push('--mic')
      log('Microphone capture enabled — mixing mic + loopback audio')
    }

    const recProc = spawn(appCtx.python, recordArgs, { cwd: appRoot })
    appCtx.stores.recorder.setProcess(recProc, tmpMp3)

    recProc.stdout.on('data', d => {
      const msg = d.toString().trim()
      log(`[record.py] ${msg}`)
      const m = msg.match(DURATION_RE)
      if (m) appCtx.stores.recorder.setPendingDuration(parseFloat(m[1]))
    })
    recProc.stderr.on('data', d => {
      const msg = d.toString().trim()
      if (!msg) return
      log(`[record.py ERR] ${msg}`)
      // Mic-open failure is non-fatal: recording continues loopback-only.
      // Surface a gentle notice rather than the hard setup-warning path.
      if (msg.includes('MIC_WARNING:')) {
        appCtx.renderer.send('service-warning', {
          title:   'Microphone unavailable',
          message: 'Your microphone could not be opened — this recording captures the call audio only.'
        })
        return
      }
      // Surface BlackHole / setup errors to renderer
      if (msg.includes('ERROR')) {
        appCtx.renderer.send('setup-warning', msg.replace(/^ERROR:\s*/, ''))
      }
    })
    recProc.on('exit', code => {
      log(`record.py exited ${code}`)
      // isRecording() returns false if stop-recording already cleared the process —
      // so a true here means Python died on its own — recover to SESSION_ACTIVE.
      const curState = appCtx.stores.state.getState()
      if ((curState === STATE.RECORDING || curState === STATE.PAUSED) && appCtx.stores.recorder.isRecording()) {
        log('record.py exited unexpectedly — returning to SESSION_ACTIVE')
        appCtx.stores.recorder.clearProcess()
        setState(STATE.SESSION_ACTIVE)
      }
    })

    setState(STATE.RECORDING)
    return true
  })

  // ---- stop-recording ----
  ipcMain.handle(CHANNELS.STOP_RECORDING, async () => {
    log('stop-recording')

    let exitPromise = Promise.resolve()
    const tempMp3Path = appCtx.stores.recorder.getTempMp3Path()
    if (appCtx.stores.recorder.isRecording()) {
      // stop() nulls _proc internally so the exit handler sees isRecording()=false
      // and skips the "exited unexpectedly" recovery path. Returns the proc ref.
      const procToStop = appCtx.stores.recorder.stop()
      if (procToStop) exitPromise = waitForExit(procToStop)
    } else {
      log('WARNING: stop-recording called but recordingProcess already gone')
    }

    // Update UI immediately — don't wait for Python's WAV→MP3 conversion first.
    // This stops the timer and shows PROCESSING state right when Save is clicked.
    setState(STATE.PROCESSING)
    appCtx.renderer.send('show-patient-form')

    // Wait for patient name entry and Python's WAV→MP3 conversion concurrently.
    // The scribe can name the case while the conversion runs in the background.
    const [name] = await Promise.all([
      appCtx.stores.recorder.awaitPatientName(),
      exitPromise
    ])

    log(`Patient name: ${name || '(none)'}`)

    const { doctorId: _stopDoctorId } = appCtx.stores.session.get()
    const _stopDoctor = dbDoctors.getDoctor(_stopDoctorId) || getAllDoctors().find(d => d.id === _stopDoctorId)
    const _stopTemplatePath = _stopDoctor?.templatePath || null
    const capturedDuration = appCtx.stores.recorder.consumePendingDuration()

    if (!fs.existsSync(tempMp3Path)) {
      log(`WARNING: temp MP3 not found at ${tempMp3Path} — recording may have failed`)
    }

    const mp3Filename = name ? `${name}.mp3` : 'recording.mp3'
    // If realtime transcription was enabled, Python wrote a JSON file alongside
    // the temp MP3.  Pass it to ingestAudio so it's moved into the case folder.
    const realtimeTranscriptSrc = readSettings().realtimeTranscription && tempMp3Path
      ? tempMp3Path.replace('.mp3', '_realtime.json')
      : null

    // In-recording pre-chart: combine the captured text + attachments into a temp
    // .md (consumed → cleared from the recorder store). ingestAudio copies it into
    // the case folder as prechart.md, which SOAP generation later reads.
    let prechartSrc = ''
    try {
      prechartSrc = await buildPrechartTempFile(appCtx.stores.recorder.consumePrechart(), log)
    } catch (e) {
      log(`[prechart][capture] WARNING: could not build pre-chart file: ${e.message}`)
      prechartSrc = ''
    }

    const { ok: ingestOk } = ingestAudio({
      audioSrc:          tempMp3Path,
      audioDestName:     mp3Filename,
      patientName:       name,
      source:            'recording',
      doctorId:          _stopDoctorId,
      templatePath:      _stopTemplatePath,
      capturedDuration,
      moveAudio:         true,
      probeDuration:     false,
      ctx:               appCtx,
      spawnTranscription: _callSpawnTranscription,
      realtimeTranscriptSrc,
      prechartSrc,
    })

    // Temp pre-chart file has been copied into the case folder by ingestAudio.
    if (prechartSrc && fs.existsSync(prechartSrc)) {
      try { fs.unlinkSync(prechartSrc) } catch (e) { log(`[prechart][capture] temp cleanup failed: ${e.message}`) }
    }

    if (!ingestOk) {
      setState(STATE.SESSION_ACTIVE)
      notifyUser('Recording failed', 'Could not save the recording. Check the log.')
      return false
    }

    // Return to SESSION_ACTIVE so scribe can immediately start the next recording
    setState(STATE.SESSION_ACTIVE)

    // If auto-record is enabled, tell the renderer to trigger a new recording
    if (readSettings().autoRecord) {
      appCtx.renderer.send('auto-start-recording')
    }

    return true
  })

  // ---- pause-recording ----
  ipcMain.handle(CHANNELS.PAUSE_RECORDING, () => {
    log('pause-recording')
    appCtx.stores.recorder.pause()
    setState(STATE.PAUSED)
    return true
  })

  // ---- resume-recording ----
  ipcMain.handle(CHANNELS.RESUME_RECORDING, () => {
    log('resume-recording')
    appCtx.stores.recorder.resume()
    setState(STATE.RECORDING)
    return true
  })

  // ---- discard-recording ----
  ipcMain.handle(CHANNELS.DISCARD_RECORDING, async () => {
    log('discard-recording')

    if (appCtx.stores.recorder.isRecording()) {
      const mp3ToDelete = appCtx.stores.recorder.getTempMp3Path()
      // discard() nulls _proc + _tempMp3Path internally then sends stop\n
      const procToStop = appCtx.stores.recorder.discard()
      // Update UI immediately — stop the timer without waiting for Python's conversion.
      setState(STATE.SESSION_ACTIVE)
      // Clean up temp files in background after Python exits.
      // Also delete the WAV in case Python hadn't converted it yet.
      if (procToStop) {
        waitForExit(procToStop).then(() => {
          const wavPath = mp3ToDelete ? mp3ToDelete.replace('.mp3', '_tmp.wav') : null
          const micWav = mp3ToDelete ? mp3ToDelete.replace('.mp3', '_mic.wav') : null
          const realtimeJson = mp3ToDelete ? mp3ToDelete.replace('.mp3', '_realtime.json') : null
          for (const p of [mp3ToDelete, wavPath, micWav, realtimeJson]) {
            if (p && fs.existsSync(p)) {
              try { fs.unlinkSync(p) } catch (e) { log(`Failed to delete temp file: ${e.message}`) }
            }
          }
        }).catch(() => {})
      }
      return true
    }

    const tmpMp3 = appCtx.stores.recorder.getTempMp3Path()
    if (tmpMp3 && fs.existsSync(tmpMp3)) {
      try {
        fs.unlinkSync(tmpMp3)
        log(`Discarded temp MP3: ${tmpMp3}`)
      } catch (e) {
        log(`Failed to delete temp MP3: ${e.message}`)
      }
    }
    appCtx.stores.recorder.clearProcess()

    setState(STATE.SESSION_ACTIVE)
    return true
  })

  // ---- submit-patient-name (registered once at startup) ----
  ipcMain.handle(CHANNELS.SUBMIT_PATIENT_NAME, (_, name) => {
    appCtx.stores.recorder.resolvePatientName(sanitizeName(name))
    return true
  })

  // ---- save-prechart-context (in-recording Pre-chart screen) ----
  // Persist the captured context on the in-flight recording. Consumed at
  // stop-recording, then written into the case folder as prechart.md.
  ipcMain.handle(CHANNELS.SAVE_PRECHART_CONTEXT, (_, text, files) => {
    appCtx.stores.recorder.setPrechart({ text, files })
    return true
  })

  // ---- get-prechart-context ----
  // Returns the current captured context so the Pre-chart screen can repopulate
  // (survives window hide/show).
  ipcMain.handle(CHANNELS.GET_PRECHART_CONTEXT, () => appCtx.stores.recorder.getPrechart())
}

module.exports = { registerRecordingIpc }