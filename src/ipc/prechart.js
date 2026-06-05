'use strict'

const fs = require('fs')
const { dialog } = require('electron')

// Pre-chart (edit-note) IPC handlers (Record tab Pre-chart sub-view), moved
// verbatim from main.js's registerIpcHandlers(). Handler bodies are
// byte-identical; helpers come from deps.
function registerPrechartIpc(ipcMain, appCtx, deps) {
  const {
    log, getAllDoctors, findRecentPatientCases, findExistingSoapNote,
    buildCombinedAttachment, spawnPrechartJob,
  } = deps

  // -------------------------------------------------------------------------
  // Pre-chart (edit-note) — Record tab "Pre-chart" sub-view
  // -------------------------------------------------------------------------

  // ---- browse-prechart-files ----
  // Multi-select picker for attachment files (prechart docs, prior visit notes, etc.).
  // Same formats the edit-note skill knows how to read.
  ipcMain.handle('browse-prechart-files', async () => {
    const result = await dialog.showOpenDialog(appCtx.win, {
      title: 'Select attachment files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Attachments', extensions: ['md', 'txt', 'docx', 'pdf'] },
        { name: 'All Files',   extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  // ---- list-recent-patient-cases ----
  ipcMain.handle('list-recent-patient-cases', () => findRecentPatientCases(appCtx.paths.notesDir, 30))

  // ---- browse-patient-case-folder ----
  // Folder picker scoped to <NOTES_DIR>/Cases/. Validates the picked folder
  // contains a *_soap_note.md (excluding backup files).
  ipcMain.handle('browse-patient-case-folder', async () => {
    const result = await dialog.showOpenDialog(appCtx.win, {
      title: 'Select patient case folder',
      defaultPath: appCtx.paths.casesDir,
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths.length) return { ok: false, error: 'cancelled' }
    const caseDir = result.filePaths[0]
    if (!findExistingSoapNote(caseDir)) {
      return { ok: false, error: 'No SOAP note found in the selected folder.' }
    }
    return { ok: true, caseDir }
  })

  // ---- start-prechart-job ----
  ipcMain.handle('start-prechart-job', async (_, doctorId, caseDir, instructions, attachmentPaths) => {
    if (appCtx.stores.jobs.isRunning()) return { ok: false, error: 'Another job is already running.' }

    const allDocs = getAllDoctors()
    log(`[prechart] doctorId received: ${JSON.stringify(doctorId)}`)
    log(`[prechart] getAllDoctors() returned ${allDocs.length} doctor(s): ${JSON.stringify(allDocs.map(d => ({ id: d.id, name: d.name, templatePath: d.templatePath })))}`)
    const doctor = allDocs.find(d => d.id === doctorId)
    log(`[prechart] doctor match: ${JSON.stringify(doctor || null)}`)
    if (!doctor || !doctor.templatePath) {
      return { ok: false, error: 'Selected doctor has no template registered.' }
    }
    const templatePath = doctor.templatePath

    if (!caseDir || !fs.existsSync(caseDir)) return { ok: false, error: 'Patient case folder not found.' }
    if (!findExistingSoapNote(caseDir)) return { ok: false, error: 'No SOAP note found in the selected case folder.' }

    const trimmedInstructions = (instructions || '').trim()
    const files = Array.isArray(attachmentPaths) ? attachmentPaths.filter(p => p && fs.existsSync(p)) : []
    if (!trimmedInstructions && files.length === 0) {
      return { ok: false, error: 'Provide instructions or at least one attachment file.' }
    }

    let combined = ''
    try {
      combined = await buildCombinedAttachment(files)
    } catch (e) {
      log(`[prechart ERR] attachment extraction failed: ${e.message}`)
      return { ok: false, error: `Attachment extraction failed: ${e.message}` }
    }

    spawnPrechartJob(caseDir, templatePath, trimmedInstructions, combined)
    return { ok: true }
  })
}

module.exports = { registerPrechartIpc }