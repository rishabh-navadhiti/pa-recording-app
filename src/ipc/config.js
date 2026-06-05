'use strict'

const path = require('path')
const fs = require('fs')
const { dialog } = require('electron')
const { spawn } = require('child_process')

// Config / settings / notes-dir IPC handlers, moved verbatim from main.js's
// registerIpcHandlers(). Handler bodies are byte-identical with two unavoidable
// adjustments (both behavior-preserving):
//   1. `__dirname` (originally repo root, used by list-audio-devices) is
//      replaced by the `appRoot` value passed through deps.
//   2. change-notes-dir reassigns main.js's module-scope `ctx`. A registrar in
//      another file cannot touch that binding, so main.js passes a
//      `setGlobalCtx(c)` setter through deps. We call it instead of the original
//      `ctx = newCtx`, then use the local `newCtx` everywhere the original used
//      `ctx` -- after `Object.assign(appCtx, newCtx)` the two refer to the same
//      app context, and `ctx === newCtx` held in the original too, so this is
//      byte-equivalent in behavior.
function registerConfigIpc(ipcMain, appCtx, deps) {
  const {
    log, appRoot, readEnv, writeEnvKey, validateElevenLabsKey, getAllDoctors,
    readSettings, writeSettings, copyDirSync, extractLastname,
    resetDb, migrateDoctorsFromSettings, tryRestoreDoctorsFromBackup, setGlobalCtx,
  } = deps

  // ---- get-config-status ----
  ipcMain.handle('get-config-status', async () => {
    const env = readEnv()
    const apiKey = env['ELEVENLABS_API_KEY'] || ''
    const settings = readSettings()
    const keyMissing = !apiKey || apiKey === 'your_key_here'
    let elevenLabsKeyInvalid = false
    if (!keyMissing) {
      const status = await validateElevenLabsKey(apiKey)
      elevenLabsKeyInvalid = status === 'invalid'
    }
    const notesDirEnv = readEnv().NOTES_DIR_PATH
    return {
      elevenLabsKeyMissing: keyMissing,
      elevenLabsKeyInvalid,
      noDoctors: getAllDoctors().length === 0,
      notesDirMissing: !notesDirEnv || !notesDirEnv.trim()
    }
  })

  // ---- get-elevenlabs-key ----
  ipcMain.handle('get-elevenlabs-key', () => {
    const env = readEnv()
    const key = env['ELEVENLABS_API_KEY'] || ''
    return key === 'your_key_here' ? '' : key
  })

  // ---- save-elevenlabs-key ----
  ipcMain.handle('save-elevenlabs-key', (_, key) => {
    try {
      const trimmed = (key || '').trim()
      if (!trimmed) return { ok: false, error: 'Key cannot be empty' }
      writeEnvKey('ELEVENLABS_API_KEY', trimmed)
      log('ElevenLabs API key saved')
      return { ok: true }
    } catch (e) {
      log(`ERROR saving ElevenLabs key: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })

  // ---- get-settings ----
  ipcMain.handle('get-settings', () => readSettings())

  // ---- save-settings ----
  ipcMain.handle('save-settings', (_, settings) => {
    try {
      // CDI⟹ICD invariant is enforced by createSettingsStore.save() automatically.
      writeSettings(settings)
      log(`Settings saved: ${JSON.stringify(readSettings())}`)
      return { ok: true }
    } catch (e) {
      log(`ERROR saving settings: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })

  // ---- list-audio-devices ----
  ipcMain.handle('list-audio-devices', () => {
    return new Promise(resolve => {
      const proc = spawn(appCtx.python, [
        path.join(appRoot, 'python', 'record.py'),
        '--list-devices'
      ], { cwd: appRoot, stdio: 'pipe' })

      let stdout = ''
      proc.stdout.on('data', d => { stdout += d.toString() })
      proc.stderr.on('data', d => log(`[list-devices] ${d.toString().trim()}`))
      proc.on('close', code => {
        if (code !== 0) {
          resolve({ devices: [], defaultOutput: '' })
          return
        }
        try {
          resolve(JSON.parse(stdout.trim()))
        } catch {
          resolve({ devices: [], defaultOutput: '' })
        }
      })
      proc.on('error', () => resolve({ devices: [], defaultOutput: '' }))
    })
  })

  // ---- get-notes-dir ----
  ipcMain.handle('get-notes-dir', () => appCtx.paths.notesDir)

  // ---- change-notes-dir ----
  ipcMain.handle('change-notes-dir', async (_, mode = 'new') => {
    const isExisting = mode === 'existing'
    const result = await dialog.showOpenDialog(appCtx.win, {
      title: isExisting ? 'Select your existing AI Medical Notes folder' : 'Choose where to store your AI Medical Notes',
      buttonLabel: 'Select Folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return { ok: false }
    const newNotesDir = isExisting ? result.filePaths[0] : path.join(result.filePaths[0], 'AI Medical Notes')

    const oldNotesDir     = appCtx.paths.notesDir
    const oldTemplatesDir = appCtx.paths.templatesDir
    const oldSettings     = readSettings()

    writeEnvKey('NOTES_DIR_PATH', newNotesDir)

    // Compute new paths for dir/file ops before re-pointing ctx
    const newCasesDir     = path.join(newNotesDir, 'Cases')
    const newTemplatesDir = path.join(newNotesDir, 'Templates')

    fs.mkdirSync(newCasesDir,     { recursive: true })
    fs.mkdirSync(newTemplatesDir, { recursive: true })

    if (oldTemplatesDir &&
        oldTemplatesDir !== newTemplatesDir &&
        fs.existsSync(oldTemplatesDir)) {
      copyDirSync(oldTemplatesDir, newTemplatesDir)
    }

    const migratedSettings = {
      ...oldSettings,
      doctors: (oldSettings.doctors || []).map(d => {
        if (!d || typeof d.templatePath !== 'string') return d
        if (oldNotesDir && d.templatePath.startsWith(oldNotesDir + path.sep)) {
          const rel = path.relative(oldNotesDir, d.templatePath)
          return { ...d, templatePath: path.join(newNotesDir, rel) }
        }
        return d
      })
    }

    // Re-point ctx to the new dir by re-creating it via createAppContext.
    // bootstrapNotesDir handles skills sync, MCP config, hide internals, and DB init.
    const { createAppContext } = require('../../context/appContext')
    const newCtx = createAppContext(newNotesDir)
    // Transfer window/tray references from the old ctx.
    newCtx.win   = appCtx.win
    newCtx.tray  = appCtx.tray
    newCtx.python = appCtx.python
    newCtx.setStatusSend = appCtx.setStatusSend
    newCtx.statusWin = appCtx.statusWin
    newCtx.attachWindows(appCtx.renderer, (ch, ...a) => appCtx.sendStatus(ch, ...a))
    // Original main.js reassigned its module-scope `ctx` here (`ctx = newCtx`).
    // From this registrar we push the new ctx back via the setter and then use
    // the local `newCtx` for the remaining `.setDb`/bootstrap calls -- identical
    // to the original, where `ctx === newCtx` for the rest of the handler.
    setGlobalCtx(newCtx)
    Object.assign(appCtx, newCtx)  // shallow-copy new ctx into the local reference

    const { bootstrapNotesDir } = require('../../startup/bootstrapNotesDir')
    await bootstrapNotesDir(newNotesDir, newCtx)
    writeSettings(migratedSettings)

    // Reset DB connection to point at the new location.
    try {
      const db = resetDb(newNotesDir)
      if (db) {
        newCtx.setDb(db)
        const s = readSettings()
        const doctors = s.doctors || []
        if (doctors.length > 0) {
          migrateDoctorsFromSettings(db, doctors,
            (patch) => writeSettings({ ...readSettings(), ...patch }),
            newNotesDir, extractLastname)
        } else {
          tryRestoreDoctorsFromBackup(db, newNotesDir,
            (patch) => writeSettings({ ...readSettings(), ...patch }),
            extractLastname)
        }
        log('[db] Database ready at new notes dir')
      }
    } catch (e) {
      log(`[db] WARNING: database init failed after dir change: ${e.message}`)
    }

    log(`Notes directory set to: ${newNotesDir} (migrated ${migratedSettings.doctors?.length || 0} doctor template paths)`)
    return { ok: true, path: newNotesDir }
  })
}

module.exports = { registerConfigIpc }