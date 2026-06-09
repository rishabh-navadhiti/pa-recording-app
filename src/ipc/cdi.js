'use strict'

const fs   = require('fs')
const path = require('path')
const { dialog } = require('electron')
const { CHANNELS } = require('../shared/ipc-channels')

/**
 * Manual CDI tab IPC handlers.
 *
 * @param {Electron.IpcMain} ipcMain
 * @param {AppContext}       appCtx
 * @param {object}           deps
 * @param {Function}         deps.getAllDoctors
 * @param {Function}         deps.runManualCdiJob
 */
function registerCdiIpc(ipcMain, appCtx, deps) {
  const { getAllDoctors, runManualCdiJob } = deps

  // Held result from the last successful run — lives until save or discard.
  let _heldResult = null // { tempDir, docxPath, suggestedName }

  // ---- get-cdi-doctors -------------------------------------------------------
  // Doctors eligible for manual CDI: specialty set AND a standards pack exists.
  ipcMain.handle(CHANNELS.GET_CDI_DOCTORS, () => {
    const standardsBase = path.join(appCtx.paths.notesDir, '.claude', 'standards', 'specialties')
    return getAllDoctors().filter(d => {
      if (!d.specialty) return false
      const file = path.join(standardsBase, `${d.specialty.toLowerCase()}.md`)
      return fs.existsSync(file)
    })
  })

  // ---- browse-cdi-soap-file --------------------------------------------------
  // Single-file picker (.md / .docx) for the SOAP note.
  ipcMain.handle(CHANNELS.BROWSE_CDI_SOAP_FILE, async () => {
    const result = await dialog.showOpenDialog(appCtx.win, {
      title: 'Select SOAP note file',
      properties: ['openFile'],
      filters: [
        { name: 'SOAP note', extensions: ['md', 'docx'] },
        { name: 'All Files',  extensions: ['*'] },
      ],
    })
    if (result.canceled || !result.filePaths.length) return null
    return result.filePaths[0]
  })

  // ---- start-cdi-review ------------------------------------------------------
  ipcMain.handle(CHANNELS.START_CDI_REVIEW, async (_, doctorId, mode, pastedText, filePath) => {
    if (appCtx.stores.jobs.isRunning()) {
      return { ok: false, error: 'Another job is already running.' }
    }

    // Resolve doctor details.
    const doctor = getAllDoctors().find(d => d.id === doctorId)
    if (!doctor) return { ok: false, error: 'Doctor not found.' }
    const specialty = (doctor.specialty || '').toLowerCase()
    if (!specialty) return { ok: false, error: 'Selected doctor has no specialty set.' }

    const standardsDir = path.join(appCtx.paths.notesDir, '.claude', 'standards')

    // Validate input: must have paste OR file, not neither.
    const hasPaste = pastedText && pastedText.trim().length > 0
    const hasFile  = filePath && fs.existsSync(filePath)
    if (!hasPaste && !hasFile) {
      return { ok: false, error: 'Provide a pasted SOAP note or upload a file.' }
    }

    // Stub .docx path until docx_to_md.py is available — checked at runtime in
    // cdiManual.js so the error surfaces only if the script is actually missing.

    const ts = Date.now().toString()
    const jobCtx = {
      ...appCtx,
      python: deps.python,
      setCdiResult: (result) => { _heldResult = result },
    }

    // Fire-and-forget; lock acquired synchronously inside runManualCdiJob.
    runManualCdiJob(
      { pastedText: pastedText || '', filePath: filePath || '', doctorId, doctorName: doctor.name, specialty, mode: mode || 'balanced', standardsDir, notesDir: appCtx.paths.notesDir, ts },
      jobCtx
    )

    return { ok: true }
  })

  // ---- save-cdi-report -------------------------------------------------------
  // Opens OS save dialog, copies the held .docx out, deletes temp folder.
  ipcMain.handle(CHANNELS.SAVE_CDI_REPORT, async () => {
    if (!_heldResult) return { ok: false, error: 'No CDI report is available to save.' }
    const { tempDir, docxPath, suggestedName } = _heldResult

    const result = await dialog.showSaveDialog(appCtx.win, {
      title: 'Save CDI report',
      defaultPath: suggestedName,
      filters: [{ name: 'Word Document', extensions: ['docx'] }],
    })

    if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }

    try {
      fs.copyFileSync(docxPath, result.filePath)
    } catch (e) {
      return { ok: false, error: `Save failed: ${e.message}` }
    } finally {
      _cleanup(tempDir, appCtx.log)
      _heldResult = null
    }

    return { ok: true, savedPath: result.filePath }
  })

  // ---- discard-cdi-report ----------------------------------------------------
  ipcMain.handle(CHANNELS.DISCARD_CDI_REPORT, () => {
    if (_heldResult) {
      _cleanup(_heldResult.tempDir, appCtx.log)
      _heldResult = null
    }
    return { ok: true }
  })
}

function _cleanup(tempDir, log) {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
    log?.(`[cdi-manual] cleaned up temp dir: ${tempDir}`)
  } catch (e) {
    log?.(`[cdi-manual] WARNING: temp dir cleanup failed: ${e.message}`)
  }
}

module.exports = { registerCdiIpc }
