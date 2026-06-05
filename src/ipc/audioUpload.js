'use strict'

const { CHANNELS } = require('../shared/ipc-channels')

const path = require('path')
const { dialog } = require('electron')

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
  ipcMain.handle(CHANNELS.PROCESS_AUDIO_FILE, (_, filePath, patientName) => {
    log(`process-audio-file: ${filePath}`)
    const name = sanitizeName(patientName)
    log(`Patient name: ${name || '(none)'}`)

    const { doctorId: _uploadDoctorId } = appCtx.stores.session.get()
    const _uploadDoctor = dbDoctors.getDoctor(_uploadDoctorId) || getAllDoctors().find(d => d.id === _uploadDoctorId)
    const _uploadTemplatePath = _uploadDoctor?.templatePath || null
    const ext = path.extname(filePath)
    const audioFilename = name ? `${name}${ext}` : `recording${ext}`

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
      ctx:               appCtx,
      spawnTranscription: _callSpawnTranscription,
    })
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