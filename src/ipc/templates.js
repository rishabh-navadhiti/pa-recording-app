'use strict'

const { CHANNELS } = require('../shared/ipc-channels')

const path = require('path')
const fs = require('fs')
const { dialog } = require('electron')

// Template create/update job IPC handlers (Templates tab), moved verbatim from
// main.js's registerIpcHandlers(). Handler bodies are byte-identical; helpers
// come from deps.
function registerTemplatesIpc(ipcMain, appCtx, deps) {
  const {
    log, nowIso, getAllDoctors, extractLastname, dbEvents,
    spawnTemplateCreation, spawnTemplateUpdate, readTemplateJob, writeTemplateJob,
  } = deps

  // -------------------------------------------------------------------------
  // Template creation (AI profile builder) — Templates tab
  // -------------------------------------------------------------------------

  // ---- browse-notes-files ----
  // Multi-select file picker for sample notes + supporting documents.
  ipcMain.handle(CHANNELS.BROWSE_NOTES_FILES, async () => {
    const result = await dialog.showOpenDialog(appCtx.win, {
      title: 'Select sample notes and supporting documents',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Notes',     extensions: ['md', 'docx', 'txt', 'json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  // ---- start-template-creation ----
  // Stages the user-selected files into NOTES_DIR/Templates/_staging/<lastname>/
  // then spawns the create-doctor-profile skill via Claude.
  ipcMain.handle(CHANNELS.START_TEMPLATE_CREATION, async (_, doctorName, filePaths) => {
    const name = (doctorName || '').trim()
    if (!name) return { ok: false, error: 'Doctor name is required' }
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return { ok: false, error: 'At least one source file is required' }
    }
    if (appCtx.stores.jobs.isRunning()) {
      return { ok: false, error: 'A template creation job is already running' }
    }

    const lastname = extractLastname(name)
    if (!lastname) return { ok: false, error: 'Doctor name produced an empty identifier' }

    const stagingDir = path.join(appCtx.paths.notesDir, 'Templates', '_staging', lastname)
    try {
      // Fresh staging folder — wipe any leftovers from a prior failed run
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true })
      }
      fs.mkdirSync(stagingDir, { recursive: true })

      for (const src of filePaths) {
        if (!fs.existsSync(src)) continue
        const dest = path.join(stagingDir, path.basename(src))
        fs.copyFileSync(src, dest)
      }
      log(`[template] Staged ${filePaths.length} file(s) → ${stagingDir}`)
    } catch (e) {
      log(`[template ERR] staging failed: ${e.message}`)
      return { ok: false, error: `Staging failed: ${e.message}` }
    }

    spawnTemplateCreation(name, stagingDir)
    return { ok: true }
  })

  // ---- browse-corrections-file ----
  ipcMain.handle(CHANNELS.BROWSE_CORRECTIONS_FILE, async () => {
    const result = await dialog.showOpenDialog(appCtx.win, {
      title: 'Select corrections file',
      properties: ['openFile'],
      filters: [
        { name: 'Text files', extensions: ['txt', 'md', 'docx'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ---- start-template-update ----
  ipcMain.handle(CHANNELS.START_TEMPLATE_UPDATE, async (_, doctorName, corrections, correctionsFile, sampleFiles) => {
    const name = (doctorName || '').trim()
    if (!name) return 'Doctor name is required.'

    const hasCorrections = (corrections || '').trim()
    const hasCorrectionsFile = correctionsFile && fs.existsSync(correctionsFile)
    const hasSamples = Array.isArray(sampleFiles) && sampleFiles.length > 0
    if (!hasCorrections && !hasCorrectionsFile && !hasSamples) {
      return 'Provide corrections text, a corrections file, or sample notes.'
    }
    if (appCtx.stores.jobs.isRunning()) return 'A template job is already running.'

    const doctor = getAllDoctors().find(d => d.name === name)
    if (!doctor || !doctor.templatePath) {
      return `No template registered for "${name}". Create a template first.`
    }
    if (!fs.existsSync(doctor.templatePath)) {
      return `Template file missing at ${doctor.templatePath}.`
    }

    // Stage sample files if provided
    let samplesDir = null
    if (hasSamples) {
      const lastname = extractLastname(name) || name.toLowerCase()
      const ts = Date.now()
      samplesDir = path.join(appCtx.paths.notesDir, 'Templates', '_staging_update', `${lastname}_${ts}`)
      try {
        fs.mkdirSync(samplesDir, { recursive: true })
        for (const src of sampleFiles) {
          if (fs.existsSync(src)) {
            fs.copyFileSync(src, path.join(samplesDir, path.basename(src)))
          }
        }
        log(`[template-update] Staged ${sampleFiles.length} sample file(s) → ${samplesDir}`)
      } catch (e) {
        log(`[template-update ERR] staging failed: ${e.message}`)
        return `Staging sample files failed: ${e.message}`
      }
    }

    spawnTemplateUpdate(name, doctor.templatePath, (corrections || '').trim(), correctionsFile || null, samplesDir)
    return null  // null = no error
  })

  // ---- get-doctors-with-templates ----
  ipcMain.handle(CHANNELS.GET_DOCTORS_WITH_TEMPLATES, () =>
    getAllDoctors()
      .filter(d => d.templatePath && fs.existsSync(d.templatePath))
      .map(d => d.name)
      .sort()
  )

  // ---- get-template-job-status ----
  ipcMain.handle(CHANNELS.GET_TEMPLATE_JOB_STATUS, () => readTemplateJob())

  // ---- dismiss-template-job ----
  ipcMain.handle(CHANNELS.DISMISS_TEMPLATE_JOB, () => {
    writeTemplateJob({ status: 'idle' })
    return { ok: true }
  })

  // ---- cancel-template-creation ----
  ipcMain.handle(CHANNELS.CANCEL_TEMPLATE_CREATION, () => {
    if (!appCtx.stores.jobs.isRunning()) return { ok: false, error: 'No job running' }
    try {
      const evId = appCtx.stores.jobs.getEventId()
      if (evId != null) {
        try { dbEvents.finishEvent(evId, { status: 'cancelled', durationMs: appCtx.stores.jobs.elapsedMs(), finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(cancel) failed: ${e.message}`) }
      }
      appCtx.stores.jobs.cancel()
      log('[template] Cancellation requested')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })
}

module.exports = { registerTemplatesIpc }