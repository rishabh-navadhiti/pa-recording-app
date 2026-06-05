'use strict'

const path = require('path')
const fs = require('fs')
const { dialog } = require('electron')

// Doctor CRUD + picker-resolution IPC handlers, moved verbatim from main.js's
// registerIpcHandlers(). Handler bodies are byte-identical; helpers come from deps.
function registerDoctorsIpc(ipcMain, appCtx, deps) {
  const { log, getAllDoctors, dbDoctors, extractLastname } = deps

  // ---- get-doctors ----
  ipcMain.handle('get-doctors', () => getAllDoctors())

  // ---- add-doctor ----
  ipcMain.handle('add-doctor', async (_, name) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return { ok: false, error: 'Name cannot be empty' }

    const result = await dialog.showOpenDialog(appCtx.win, {
      title: `Select Template for ${trimmed}`,
      properties: ['openFile'],
      filters: [{ name: 'Markdown Files', extensions: ['md'] }]
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' }
    }

    const srcPath = result.filePaths[0]
    const destPath = path.join(appCtx.paths.templatesDir, path.basename(srcPath))
    fs.copyFileSync(srcPath, destPath)
    const doctor = { id: String(Date.now()), name: trimmed, templatePath: destPath, lastname: extractLastname(trimmed) || trimmed.toLowerCase() }
    try {
      dbDoctors.upsertDoctor(doctor)
      log(`Doctor added to DB: ${trimmed} (template: ${destPath})`)
    } catch (e) {
      log(`[db] add-doctor upsert failed: ${e.message}`)
    }
    log(`Doctor added: ${trimmed} (template: ${destPath})`)
    return { ok: true, doctor }
  })

  // ---- update-doctor-template ----
  ipcMain.handle('update-doctor-template', async (_, id) => {
    const doctor = dbDoctors.getDoctor(id) || getAllDoctors().find(d => d.id === id)
    if (!doctor) return { ok: false, error: 'Doctor not found' }

    const result = await dialog.showOpenDialog(appCtx.win, {
      title: `Select Template for ${doctor.name}`,
      properties: ['openFile'],
      filters: [{ name: 'Markdown Files', extensions: ['md'] }]
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' }
    }

    const srcPath = result.filePaths[0]
    const destPath = path.join(appCtx.paths.templatesDir, path.basename(srcPath))
    fs.copyFileSync(srcPath, destPath)
    try {
      dbDoctors.updateDoctorTemplate(id, destPath)
      log(`Template updated in DB for ${doctor.name}: ${destPath}`)
    } catch (e) {
      log(`[db] updateDoctorTemplate failed: ${e.message}`)
    }
    log(`Template updated for ${doctor.name}: ${destPath}`)
    return { ok: true, doctor: { ...doctor, templatePath: destPath } }
  })

  // ---- update-doctor ----
  ipcMain.handle('update-doctor', (_, id, name) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return { ok: false, error: 'Name cannot be empty' }
    const doctor = dbDoctors.getDoctor(id) || getAllDoctors().find(d => d.id === id)
    if (!doctor) return { ok: false, error: 'Doctor not found' }
    try {
      dbDoctors.upsertDoctor({ ...doctor, name: trimmed, lastname: extractLastname(trimmed) || doctor.lastname })
      log(`Doctor name updated: ${id} -> ${trimmed}`)
    } catch (e) {
      log(`[db] update-doctor failed: ${e.message}`)
      return { ok: false, error: e.message }
    }
    return { ok: true }
  })

  // ---- remove-doctor ----
  ipcMain.handle('remove-doctor', (_, id) => {
    try {
      const doctor = dbDoctors.getDoctor(id)
      const tp = doctor?.templatePath

      dbDoctors.removeDoctor(id)

      if (tp) {
        const othersUsingTemplate = dbDoctors.listDoctors().some(d => d.id !== id && d.templatePath === tp)
        if (!othersUsingTemplate && tp.startsWith(appCtx.paths.templatesDir) && fs.existsSync(tp)) {
          try {
            fs.unlinkSync(tp)
            log(`Template file removed: ${tp}`)
          } catch (e) {
            log(`WARNING: failed to delete template file ${tp}: ${e.message}`)
          }
        }
      }

      log(`Doctor removed: ${id}`)
      return { ok: true }
    } catch (e) {
      log(`ERROR removing doctor: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })

  // ---- update-doctor-specialty (per-doctor CDI specialty assignment) ----
  // Pass a value from the closed enum or empty/null to clear. The skill loads
  // notes-claude/standards/specialties/<value>.md at runtime — values that
  // don't have a corresponding standards file are gated in main.js's
  // spawnCdiReview and never reach the skill.
  ipcMain.handle('update-doctor-specialty', (_, id, specialty) => {
    const doctor = dbDoctors.getDoctor(id)
    if (!doctor) return { ok: false, error: 'Doctor not found' }
    try {
      dbDoctors.updateDoctorSpecialty(id, specialty)
      log(`Doctor specialty updated: ${id} -> ${specialty || '(cleared)'}`)
      return { ok: true }
    } catch (e) {
      log(`[db] update-doctor-specialty failed: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })

  // ---- select-doctor (resolves picker shown during start-session) ----
  ipcMain.handle('select-doctor', (_, id) => {
    appCtx.stores.session.resolveDoctorPick(id)
    return true
  })
}

module.exports = { registerDoctorsIpc }