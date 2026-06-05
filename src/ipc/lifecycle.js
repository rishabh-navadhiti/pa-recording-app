'use strict'

const fs = require('fs')

// Session/state lifecycle IPC handlers, moved verbatim from main.js's
// registerIpcHandlers(). Handler bodies are byte-identical; the helpers they
// close over are destructured from the shared `deps` object built in main.js.
function registerLifecycleIpc(ipcMain, appCtx, deps) {
  const { log, setState, STATE, getAllDoctors, createSessionFolder, dbSessions, waitForExit } = deps

  // ---- get-state ----
  ipcMain.handle('get-state', () => appCtx.stores.state.getState())

  // ---- get-build-info ----
  ipcMain.handle('get-build-info', () => ({
    isStaging: appCtx.platform.isStaging()
  }))

  // ---- start-session ----
  ipcMain.handle('start-session', async () => {
    log('start-session')
    const doctors = getAllDoctors()

    if (doctors.length === 0) {
      log('start-session blocked: no doctors configured')
      return { ok: false, error: 'no-doctors' }
    }

    let selectedId
    if (doctors.length === 1) {
      selectedId = doctors[0].id
      log(`Auto-selected doctor: ${doctors[0].name}`)
    } else {
      // Multiple doctors — ask renderer to pick
      appCtx.renderer.send('pick-doctor', doctors)
      selectedId = await appCtx.stores.session.awaitDoctorPick()

      if (!selectedId) {
        log('start-session cancelled: no doctor selected')
        return { ok: false, error: 'cancelled' }
      }
      log(`Selected doctor ID: ${selectedId}`)
    }

    appCtx.stores.session.setDoctor(selectedId)
    const sessionDir = createSessionFolder()
    appCtx.stores.recordings.clear()

    let sessionId = null
    try {
      sessionId = dbSessions.startSession({ sessionFolder: sessionDir, doctorId: selectedId })
    } catch (e) {
      log(`[db] startSession insert failed: ${e.message}`)
    }
    appCtx.stores.session.setSession(sessionId, sessionDir)

    setState(STATE.SESSION_ACTIVE)
    return { ok: true }
  })

  // ---- stop-session ----
  ipcMain.handle('stop-session', async () => {
    log('stop-session')
    appCtx.stores.session.cancelDoctorPick()

    try {
      const { sessionId } = appCtx.stores.session.get()
      if (sessionId) dbSessions.endSession(sessionId)
    } catch (e) {
      log(`[db] endSession failed: ${e.message}`)
    }

    // If somehow recording when session is stopped, kill the process
    if (appCtx.stores.recorder.isRecording()) {
      const proc = appCtx.stores.recorder.getProcess()
      const tmpMp3 = appCtx.stores.recorder.getTempMp3Path()
      appCtx.stores.recorder.clearProcess()
      if (proc) {
        proc.kill()
        await waitForExit(proc)
      }
      if (tmpMp3 && fs.existsSync(tmpMp3)) {
        try { fs.unlinkSync(tmpMp3) } catch {}
      }
    }
    appCtx.stores.recorder.cancelPatientName()
    if (appCtx.statusWin && !appCtx.statusWin.isDestroyed()) {
      appCtx.statusWin.close()
    }
    appCtx.stores.session.clear()
    appCtx.stores.recordings.clear()
    setState(STATE.IDLE)
    return true
  })
}

module.exports = { registerLifecycleIpc }
