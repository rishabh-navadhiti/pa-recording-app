'use strict'

const { CHANNELS } = require('../shared/ipc-channels')

const fs = require('fs')
const path = require('path')
const { dialog } = require('electron')
const { buildPrechartTempFile } = require('../pipeline/attachments')

// Audio-file upload IPC handlers, moved verbatim from main.js's
// registerIpcHandlers(). Handler bodies are byte-identical; helpers come from deps.
function registerAudioUploadIpc(ipcMain, appCtx, deps) {
  const {
    log, setState, STATE, sanitizeName, dbDoctors, getAllDoctors,
    ingestAudio, _callSpawnTranscription,
  } = deps

  // ---- browse-audio-file ----
  ipcMain.handle(CHANNELS.BROWSE_AUDIO_FILE, async () => {
    const result = await dialog.showOpenDialog(appCtx.win, {
      title: 'Select Audio File',
      properties: ['openFile'],
      filters: [
        { name: 'Audio Files', extensions: ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'mp4'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ---- process-audio-file ----
  ipcMain.handle(CHANNELS.PROCESS_AUDIO_FILE, async (_, filePath, patientName, multiPatient) => {
    log(`process-audio-file: ${filePath}`)
    const name = sanitizeName(patientName)
    log(`Patient name: ${name || '(none)'}  multi-patient: ${!!multiPatient}`)

    const { doctorId: _uploadDoctorId } = appCtx.stores.session.get()
    const _uploadDoctor = dbDoctors.getDoctor(_uploadDoctorId) || getAllDoctors().find(d => d.id === _uploadDoctorId)
    const _uploadTemplatePath = _uploadDoctor?.templatePath || null
    const ext = path.extname(filePath)
    const audioFilename = name ? `${name}${ext}` : `recording${ext}`

    // Pre-chart context the scribe may have added on the upload name screen
    // (held in the recorder store). Combine → temp .md → written into the case
    // folder by ingestAudio, then fed into note generation.
    let prechartSrc = ''
    try {
      prechartSrc = await buildPrechartTempFile(appCtx.stores.recorder.consumePrechart(), log)
    } catch (e) {
      log(`[prechart][capture] WARNING: could not build pre-chart file (upload): ${e.message}`)
      prechartSrc = ''
    }

    setState(STATE.PROCESSING)
    const { ok: ingestOk } = ingestAudio({
      audioSrc:          filePath,
      audioDestName:     audioFilename,
      patientName:       name,
      source:            'upload',
      doctorId:          _uploadDoctorId,
      templatePath:      _uploadTemplatePath,
      capturedDuration:  null,
      moveAudio:         false,
      probeDuration:     true,
      multiPatient:      !!multiPatient,
      ctx:               appCtx,
      spawnTranscription: _callSpawnTranscription,
      prechartSrc,
    })

    if (prechartSrc && fs.existsSync(prechartSrc)) {
      try { fs.unlinkSync(prechartSrc) } catch (e) { log(`[prechart][capture] temp cleanup failed (upload): ${e.message}`) }
    }

    if (!ingestOk) {
      setState(STATE.SESSION_ACTIVE)
      return false
    }

    // Return to SESSION_ACTIVE immediately — pipeline runs in background
    setState(STATE.SESSION_ACTIVE)
    return true
  })
}

module.exports = { registerAudioUploadIpc }