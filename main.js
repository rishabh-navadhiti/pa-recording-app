'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn, execSync } = require('child_process')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

const STATE = {
  IDLE: 'IDLE',
  SESSION_ACTIVE: 'SESSION_ACTIVE',
  RECORDING: 'RECORDING',
  PROCESSING: 'PROCESSING'
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let tray = null
let win = null
let currentState = STATE.IDLE
let recordingProcess = null
let tempMp3Path = null
let patientNameResolver = null

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DOCS_DIR    = app.getPath('documents')
const NOTES_DIR   = path.join(DOCS_DIR, 'AI Medical Notes')
const CASES_DIR   = path.join(NOTES_DIR, 'Cases')
const TEMPLATES_DIR = path.join(NOTES_DIR, 'templates')
const LOG_FILE    = path.join(NOTES_DIR, 'app.log')

// Bundled Claude config — copied to NOTES_DIR/.claude on first run
const CLAUDE_CONFIG_SRC = path.join(__dirname, 'notes-claude')

// Hardcoded doctor for demo — will be configurable in a future release
const DOCTOR = 'sabbag'

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  process.stdout.write(line)
  try {
    fs.appendFileSync(LOG_FILE, line)
  } catch (e) {
    // Log file may not exist yet on first run — ignore
  }
}

// ---------------------------------------------------------------------------
// State broadcast
// ---------------------------------------------------------------------------

function setState(newState) {
  currentState = newState
  log(`State → ${newState}`)
  if (win && !win.isDestroyed()) {
    win.webContents.send('state-change', newState)
  }
}

// ---------------------------------------------------------------------------
// Tray popup positioning
// ---------------------------------------------------------------------------

function getPopupPosition(tray, win) {
  const trayBounds = tray.getBounds()
  const winBounds = win.getBounds()
  const { workArea } = screen.getPrimaryDisplay()

  const validTray = trayBounds.x > 0 || trayBounds.y > 0
  if (!validTray) {
    return {
      x: Math.round(workArea.x + workArea.width / 2 - winBounds.width / 2),
      y: Math.round(workArea.y + workArea.height / 2 - winBounds.height / 2)
    }
  }

  const x = Math.round(trayBounds.x + trayBounds.width / 2 - winBounds.width / 2)
  const y = process.platform === 'darwin'
    ? trayBounds.y + trayBounds.height   // macOS: menubar at top
    : trayBounds.y - winBounds.height    // Windows: taskbar at bottom

  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - winBounds.width)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - winBounds.height))
  }
}

function togglePopup() {
  if (win.isVisible()) {
    win.hide()
  } else {
    const pos = getPopupPosition(tray, win)
    win.setPosition(pos.x, pos.y, false)
    win.show()
    win.focus()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function spawnSoapGeneration(transcriptAbsPath) {
  // Build path relative to NOTES_DIR — that's the cwd claude runs from
  const relTranscript = path.relative(NOTES_DIR, transcriptAbsPath).replace(/\\/g, '/')
  const prompt = `generate a note for doctor ${DOCTOR} using transcript ${relTranscript}`

  log(`[soap] Spawning: claude -p "${prompt}"`)

  const claudeProc = spawn('claude', [
    '-p', prompt,
    '--dangerously-skip-permissions'
  ], {
    cwd: NOTES_DIR,
    stdio: 'pipe',
    // On Windows, spawn via shell so PATH is resolved correctly
    shell: process.platform === 'win32'
  })

  claudeProc.stdout.on('data', d => log(`[soap] ${d.toString().trim()}`))
  claudeProc.stderr.on('data', d => log(`[soap ERR] ${d.toString().trim()}`))
  claudeProc.on('close', code => log(`[soap] claude exited ${code}`))
  claudeProc.on('error', err => log(`[soap ERR] failed to spawn claude: ${err.message}`))
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src,  entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// ---------------------------------------------------------------------------
// App ready
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  // No dock icon on macOS
  app.dock?.hide()

  // Ensure runtime directories exist
  fs.mkdirSync(CASES_DIR, { recursive: true })
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true })

  // Copy bundled .claude config to NOTES_DIR on first run (skip if already there)
  const claudeDest = path.join(NOTES_DIR, '.claude')
  if (!fs.existsSync(claudeDest)) {
    copyDirSync(CLAUDE_CONFIG_SRC, claudeDest)
    log('.claude config copied to AI Medical Notes')
  }

  log('App started')

  // Startup checks (log warnings, don't crash)
  try {
    execSync(`${PYTHON} --version`, { stdio: 'pipe' })
    log(`Python OK: ${execSync(`${PYTHON} --version`, { stdio: 'pipe' }).toString().trim()}`)
  } catch {
    log('WARNING: Python not found')
  }

  try {
    execSync('ffmpeg -version', { stdio: 'pipe' })
    log('ffmpeg OK')
  } catch {
    log('WARNING: ffmpeg not found — MP3 conversion via pydub may fail')
  }

  // Create tray
  tray = new Tray(path.join(__dirname, 'assets', 'tray-icon.png'))
  tray.setToolTip('AI Medical Scribe')

  // Right-click context menu
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Quit', click: () => app.quit() }
  ])
  tray.on('right-click', () => tray.popUpContextMenu(contextMenu))
  tray.on('click', () => togglePopup())

  // Create popup window
  win = new BrowserWindow({
    width: 280,
    height: 360,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  win.on('blur', () => win.hide())

  // macOS BlackHole check
  if (process.platform === 'darwin') {
    try {
      execSync(
        `${PYTHON} -c "import sounddevice as sd; assert any('BlackHole' in d['name'] for d in sd.query_devices())"`,
        { stdio: 'pipe' }
      )
      log('BlackHole detected')
    } catch {
      const msg = 'BlackHole not found. Install: brew install blackhole-2ch'
      log(`WARNING: ${msg}`)
      win.webContents.on('did-finish-load', () => {
        win.webContents.send('setup-warning', msg)
      })
    }
  }

  // Clean up recording process on quit
  app.on('before-quit', () => {
    if (recordingProcess) {
      log('Killing recording process before quit')
      recordingProcess.kill()
    }
  })

  registerIpcHandlers()
})

// ---------------------------------------------------------------------------
// Helper: wait for a child process to exit (safe if already exited)
// ---------------------------------------------------------------------------

function waitForExit(proc) {
  return new Promise(resolve => {
    if (proc.exitCode !== null || proc.killed) {
      resolve()
    } else {
      proc.once('exit', resolve)
    }
  })
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

function registerIpcHandlers() {
  // ---- get-state ----
  ipcMain.handle('get-state', () => currentState)

  // ---- start-session ----
  ipcMain.handle('start-session', () => {
    log('start-session')
    setState(STATE.SESSION_ACTIVE)
    return true
  })

  // ---- stop-session ----
  ipcMain.handle('stop-session', async () => {
    log('stop-session')
    // If somehow recording when session is stopped, kill the process
    if (recordingProcess) {
      recordingProcess.kill()
      await waitForExit(recordingProcess)
      recordingProcess = null
    }
    if (tempMp3Path && fs.existsSync(tempMp3Path)) {
      try { fs.unlinkSync(tempMp3Path) } catch {}
    }
    tempMp3Path = null
    patientNameResolver = null
    setState(STATE.IDLE)
    return true
  })

  // ---- start-recording ----
  ipcMain.handle('start-recording', () => {
    log('start-recording')
    tempMp3Path = path.join(os.tmpdir(), `rec_${Date.now()}.mp3`)
    log(`Temp MP3: ${tempMp3Path}`)

    recordingProcess = spawn(PYTHON, [
      path.join(__dirname, 'python', 'record.py'),
      '--output', tempMp3Path
    ], { cwd: __dirname })

    recordingProcess.stdout.on('data', d => log(`[record.py] ${d.toString().trim()}`))
    recordingProcess.stderr.on('data', d => {
      const msg = d.toString().trim()
      log(`[record.py ERR] ${msg}`)
      // Surface BlackHole / setup errors to renderer
      if (msg.startsWith('ERROR:')) {
        win.webContents.send('setup-warning', msg.replace('ERROR: ', ''))
      }
    })
    recordingProcess.on('exit', code => {
      log(`record.py exited ${code}`)
      // If process died on its own while we're still in RECORDING state, recover
      if (currentState === STATE.RECORDING) {
        log('record.py exited unexpectedly — returning to SESSION_ACTIVE')
        recordingProcess = null
        setState(STATE.SESSION_ACTIVE)
      }
    })

    setState(STATE.RECORDING)
    return true
  })

  // ---- stop-recording ----
  ipcMain.handle('stop-recording', async () => {
    log('stop-recording')

    if (recordingProcess) {
      // Signal Python to stop cleanly via stdin (reliable on Windows).
      // Python flushes the WAV and converts to MP3 before exiting.
      // Do NOT use kill() here — TerminateProcess() on Windows gives Python
      // no chance to run cleanup code.
      try {
        recordingProcess.stdin.write('stop\n')
        recordingProcess.stdin.end()
      } catch (e) {
        log(`stdin write failed (process may have already exited): ${e.message}`)
      }
      await waitForExit(recordingProcess)
      recordingProcess = null
    } else {
      log('WARNING: stop-recording called but recordingProcess already gone')
    }

    setState(STATE.PROCESSING)

    // Ask renderer to show the patient name form
    win.webContents.send('show-patient-form')

    // Wait for the scribe to enter/skip the patient name
    const name = await new Promise(resolve => {
      patientNameResolver = resolve
    })

    log(`Patient name: ${name || '(none)'}`)

    // Build case folder
    const datestamp = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const folderName = name
      ? `${name}_${datestamp}`
      : `recording_${datestamp}_${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}`

    const caseDir = path.join(CASES_DIR, folderName)
    fs.mkdirSync(caseDir, { recursive: true })

    const mp3Filename = name ? `${name}.mp3` : 'recording.mp3'
    const mp3Dest = path.join(caseDir, mp3Filename)
    const transcriptDest = path.join(caseDir, 'transcript.md')

    if (fs.existsSync(tempMp3Path)) {
      fs.renameSync(tempMp3Path, mp3Dest)
      log(`MP3 moved to: ${mp3Dest}`)
    } else {
      log(`WARNING: temp MP3 not found at ${tempMp3Path} — recording may have failed`)
    }
    tempMp3Path = null

    // Spawn transcription (non-blocking — scribe can start next recording immediately)
    const transcribeProc = spawn(PYTHON, [
      path.join(__dirname, 'python', 'transcribe.py'),
      '--input', mp3Dest,
      '--output', transcriptDest
    ], { cwd: __dirname, stdio: 'pipe' })

    transcribeProc.stdout.on('data', d => log(`[transcribe.py] ${d.toString().trim()}`))
    transcribeProc.stderr.on('data', d => log(`[transcribe.py ERR] ${d.toString().trim()}`))
    transcribeProc.on('close', code => {
      log(`transcribe.py exited ${code}`)
      if (code === 0) {
        spawnSoapGeneration(transcriptDest)
      }
    })

    log(`Transcription started for: ${mp3Dest}`)

    // Return to SESSION_ACTIVE so scribe can immediately start the next recording
    setState(STATE.SESSION_ACTIVE)
    return true
  })

  // ---- submit-patient-name (registered once at startup) ----
  ipcMain.handle('submit-patient-name', (_, name) => {
    if (patientNameResolver) {
      const sanitized = name
        ? name.trim().toLowerCase().replace(/\s+/g, '_')
        : null
      patientNameResolver(sanitized)
      patientNameResolver = null
    }
    return true
  })
}
