'use strict'

const path = require('path')
const os   = require('os')

const { createAppContext }    = require('../context/appContext')
const { bootstrapNotesDir }   = require('./bootstrapNotesDir')
const { createMainWindow }    = require('../windows/mainWindow')
const { createTray }          = require('../windows/tray')

/**
 * Orchestrate the ordered startup sequence inside app.whenReady().
 *
 * Returns the fully-initialized AppContext. After this call the app is running:
 * windows are visible, IPC handlers are registered, and the pipeline is ready.
 *
 * @param {object} opts
 * @param {string|null} opts.notesDir          Pre-resolved notes dir (from .env) or null.
 * @param {any}         opts.dbStartupError    Set if better-sqlite3 failed to load.
 * @param {Function}    opts.registerIpcHandlers  Thin IPC registrar — receives ctx.
 * @param {Function}    opts.checkForUpdates   Git-pull updater (runs after ctx is ready).
 * @param {object}      [opts.app]             Electron app (injected for testability).
 * @param {object}      [opts.dialog]          Electron dialog (injected for testability).
 * @param {Function}    [opts.execSync]        For diagnostics (injected for testability).
 * @returns {Promise<AppContext>}
 */
async function bootstrap({
  notesDir,
  dbStartupError,
  registerIpcHandlers,
  checkForUpdates,
  app,
  dialog,
  execSync,
  spawn,
} = {}) {
  const _app    = app    || require('electron').app
  const _dialog = dialog || require('electron').dialog

  // ---- Step 0: check native-addon load error ----------------------------
  if (dbStartupError) {
    _dialog.showErrorBox(
      'AI Medical Scribe — reinstall required',
      'A required component (database module) could not load.\n\n' +
      'This usually means the app updated but the native module was not yet rebuilt.\n\n' +
      'Fix: run "reinstall.ps1" from the app folder (or re-run the original installer), then restart.\n\n' +
      `Detail: ${dbStartupError.message}`
    )
    _app.quit()
    return null
  }

  // ---- Step 1: build the pre-window context (notes dir may be null) -----
  // Use a temporary placeholder path for ctx so the logger/stores are ready.
  // If notesDir is known, use it; otherwise use a temp path (stores still work,
  // log just goes to stdout until dir is picked by the user in the folder-setup view).
  const resolvedNotesDir = notesDir || os.homedir()
  const ctx = createAppContext(resolvedNotesDir)

  // ---- Step 2: bootstrap the notes directory if known -------------------
  if (notesDir) {
    await bootstrapNotesDir(notesDir, ctx)
    ctx.log('App started')
  } else {
    ctx.log('App started (no notes dir configured — folder setup view will appear)')
  }

  // ---- Step 3: auto-update (git pull, non-blocking) ---------------------
  if (checkForUpdates) checkForUpdates(ctx)

  // ---- Step 4: startup diagnostics -------------------------------------
  const _execSync = execSync || require('child_process').execSync
  const _spawn    = spawn    || require('child_process').spawn

  ctx.log('=== Diagnostics ===')
  ctx.log(`OS: ${process.platform} ${os.release()} (${os.arch()})`)
  ctx.log(`Electron: ${process.versions.electron || 'n/a'}`)
  ctx.log(`Node: ${process.version}`)

  const pyResult = ctx.platform.resolvePython()
  if (pyResult) {
    ctx.python = pyResult.cmd
    ctx.log(`Python: ${pyResult.version} (via ${ctx.python})`)
  } else {
    ctx.python = process.platform === 'win32' ? 'python' : 'python3'
    ctx.log('WARNING: Python 3 not found on PATH — tried py/python/python3')
  }

  ctx.log(`Build: ${ctx.platform.isStaging() ? 'STAGING' : 'production'}`)

  try {
    const ffVer = _execSync('ffmpeg -version', { stdio: 'pipe' }).toString().split('\n')[0].trim()
    ctx.log(`ffmpeg: ${ffVer}`)
  } catch {
    ctx.log('WARNING: ffmpeg not found — MP3 conversion via pydub may fail')
  }

  ctx.log('=== End Diagnostics ===')

  // ---- Step 5: create tray + main window --------------------------------
  _app.dock?.hide()  // macOS: hide dock icon

  const tray = createTray({
    isStaging: ctx.platform.isStaging(),
    onTogglePopup: () => {
      const { win } = mainWindowRef
      if (!win) return
      if (win.isMinimized()) { win.restore(); win.focus() }
      else if (win.isVisible()) { win.minimize() }
      else { win.show(); win.focus() }
    }
  })
  ctx.tray = tray

  // Forward reference so togglePopup in tray can reference the window.
  const mainWindowRef = { win: null }

  const { win, send: rendererSend } = createMainWindow({
    onCloseRequest: (e, w) => {
      if (!ctx.stores.state.isQuitting()) { e.preventDefault(); w.minimize() }
    }
  })
  mainWindowRef.win = win
  ctx.win = win   // direct win ref on ctx for the before-quit handler + status window positioning

  // Status window send — managed inline by the IPC handlers.
  // A mutable reference updated when the status window is opened/closed.
  let statusSendFn = () => {}
  ctx.setStatusSend = (fn) => { statusSendFn = fn || (() => {}) }

  ctx.attachWindows(
    { send: rendererSend },
    (ch, ...a) => statusSendFn(ch, ...a)
  )

  // ---- Step 6: platform dependency checks ------------------------------
  if (process.platform === 'darwin') {
    try {
      _execSync(
        `${ctx.python} -c "import sounddevice as sd; assert any('BlackHole' in d['name'] for d in sd.query_devices())"`,
        { stdio: 'pipe' }
      )
      ctx.log('BlackHole detected')
    } catch {
      const msg = 'BlackHole not found. Install: brew install blackhole-2ch'
      ctx.log(`WARNING: ${msg}`)
      win.webContents.on('did-finish-load', () => {
        if (win && !win.isDestroyed()) win.webContents.send('setup-warning', msg)
      })
    }
  }

  // ---- Step 7: before-quit lifecycle -----------------------------------
  _app.on('before-quit', () => {
    ctx.stores.state.setQuitting()
    if (ctx.stores.recorder.isRecording()) {
      ctx.log('Killing recording process before quit')
      const proc = ctx.stores.recorder.getProcess()
      if (proc) proc.kill()
    }
  })

  // ---- Step 8: register IPC handlers -----------------------------------
  if (registerIpcHandlers) registerIpcHandlers(ctx)

  return ctx
}

module.exports = { bootstrap }
