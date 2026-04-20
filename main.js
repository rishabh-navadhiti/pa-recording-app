'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog } = require('electron')
app.setName('Ai medical scribe')
app.setAppUserModelId('Ai medical scribe')
const path = require('path')
const fs = require('fs')
const os = require('os')
const https = require('https')
const { spawn, execSync } = require('child_process')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

const STATE = {
  IDLE: 'IDLE',
  SESSION_ACTIVE: 'SESSION_ACTIVE',
  RECORDING: 'RECORDING',
  PAUSED: 'PAUSED',
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
let activeDoctorId = null
let doctorPickerResolver = null

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const CLAUDE_CONFIG_SRC = path.join(__dirname, 'notes-claude')

let NOTES_DIR   = ''
let CASES_DIR   = ''
let TEMPLATES_DIR = ''
let LOG_FILE    = ''

function loadPaths(notesDir) {
  NOTES_DIR     = notesDir
  CASES_DIR     = path.join(notesDir, 'Cases')
  TEMPLATES_DIR = path.join(notesDir, 'templates')
  LOG_FILE      = path.join(notesDir, 'app.log')
}

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
// Settings helpers (settings.json in NOTES_DIR)
// ---------------------------------------------------------------------------

function getSettingsPath() { return path.join(NOTES_DIR, 'settings.json') }

const DEFAULT_SETTINGS = {
  autoRecord: false,
  manualDeviceSelection: true,
  selectedDeviceIndex: null,
  doctors: []
}

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8')) }
  } catch { return { ...DEFAULT_SETTINGS } }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true })
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// .env helpers
// ---------------------------------------------------------------------------

const ENV_PATH = path.join(__dirname, '.env')

function readEnv() {
  try {
    return Object.fromEntries(
      fs.readFileSync(ENV_PATH, 'utf8')
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && l.includes('='))
        .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
    )
  } catch { return {} }
}

function writeEnvKey(key, value) {
  let lines = []
  try { lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n') } catch {}
  const re = new RegExp(`^${key}=`)
  if (lines.some(l => re.test(l))) {
    lines = lines.map(l => re.test(l) ? `${key}=${value}` : l)
  } else {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('')
    lines.push(`${key}=${value}`)
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf8')
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

// ---------------------------------------------------------------------------
// Shared helpers — used by both recording flow and upload flow
// ---------------------------------------------------------------------------

function sanitizeName(name) {
  if (!name) return null
  const result = name.trim().toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
  return result || null
}

function buildCaseFolder(sanitizedName) {
  const datestamp = new Date().toISOString().slice(0, 10)
  const folderName = sanitizedName
    ? `${sanitizedName}_${datestamp}`
    : `recording_${datestamp}_${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}`
  const caseDir = path.join(CASES_DIR, folderName)
  fs.mkdirSync(caseDir, { recursive: true })
  return { caseDir, folderName }
}

function notifyUser(title, body) {
  const { Notification } = require('electron')
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show()
  }
}

function validateElevenLabsKey(apiKey) {
  return new Promise(resolve => {
    const req = https.request(
      { hostname: 'api.elevenlabs.io', path: '/v1/user', method: 'GET', headers: { 'xi-api-key': apiKey } },
      res => resolve(res.statusCode === 200 ? 'valid' : res.statusCode === 401 ? 'invalid' : 'unknown')
    )
    req.on('error', () => resolve('unknown'))
    req.end()
  })
}

function spawnTranscription(mp3Path, transcriptDest, soapNotePath, caseTag, templatePath) {
  const tag = caseTag ? `[${caseTag}] ` : ''
  const stderrChunks = []
  const transcribeProc = spawn(PYTHON, [
    path.join(__dirname, 'python', 'transcribe.py'),
    '--input', mp3Path,
    '--output', transcriptDest
  ], { cwd: __dirname, stdio: 'pipe' })

  transcribeProc.stdout.on('data', d => log(`${tag}[transcribe] ${d.toString().trim()}`))
  transcribeProc.stderr.on('data', d => {
    const msg = d.toString()
    stderrChunks.push(msg)
    log(`${tag}[transcribe ERR] ${msg.trim()}`)
  })
  transcribeProc.on('close', code => {
    log(`${tag}[transcribe] exited ${code}`)
    if (code === 0) {
      spawnSoapGeneration(transcriptDest, soapNotePath, caseTag, false, templatePath)
      spawnDocxConversion(transcriptDest, caseTag)
    } else {
      const stderr = stderrChunks.join('')
      if (/401|invalid.api.key|unauthorized/i.test(stderr)) {
        win.webContents.send('service-warning', {
          title: 'ElevenLabs API key invalid',
          message: 'Your API key was rejected. Update it in Settings to resume transcription.'
        })
      } else if (/429|quota.exceeded|rate.limit|insufficient.credit/i.test(stderr)) {
        win.webContents.send('service-warning', {
          title: 'ElevenLabs quota exceeded',
          message: 'Your ElevenLabs usage limit has been reached. Transcription could not complete.'
        })
      } else {
        notifyUser('Transcription failed', `Case: ${caseTag || 'unknown'} — check app.log for details`)
      }
    }
  })
  log(`${tag}Transcription started for: ${mp3Path}`)
}

function spawnSoapGeneration(transcriptAbsPath, soapNoteMdPath, caseTag, isRetry = false, templatePath = null) {
  const tag = caseTag ? `[${caseTag}] ` : ''
  const relTranscript = path.relative(NOTES_DIR, transcriptAbsPath).replace(/\\/g, '/')
  let prompt
  if (templatePath) {
    const relTemplate = path.relative(NOTES_DIR, templatePath).replace(/\\/g, '/')
    prompt = `generate a note using template "${relTemplate}" and transcript "${relTranscript}"`
  } else {
    prompt = `generate a note using transcript "${relTranscript}"`
  }

  const attempt = isRetry ? ' (retry)' : ''
  log(`${tag}[soap] Spawning${attempt}: claude -p "${prompt}"`)

  const safePrompt = prompt.replace(/"/g, '\\"')
  const claudeProc = spawn(
    `claude -p "${safePrompt}" --dangerously-skip-permissions`,
    [],
    {
      cwd: NOTES_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true
    }
  )

  const soapOutputChunks = []
  claudeProc.stdout.on('data', d => {
    const msg = d.toString()
    soapOutputChunks.push(msg)
    log(`${tag}[soap] ${msg.trim()}`)
  })
  claudeProc.stderr.on('data', d => {
    const msg = d.toString()
    soapOutputChunks.push(msg)
    log(`${tag}[soap ERR] ${msg.trim()}`)
  })
  claudeProc.on('close', code => {
    log(`${tag}[soap] claude exited ${code}`)
    const soapOutput = soapOutputChunks.join('')
    if (/rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i.test(soapOutput)) {
      win.webContents.send('service-warning', {
        title: 'Claude usage limit reached',
        message: `Your recording has been saved. Notes could not be generated — try again once the limit resets.`
      })
      return
    }
    if (code === 0 && soapNoteMdPath) {
      if (fs.existsSync(soapNoteMdPath)) {
        log(`${tag}[soap] SOAP note confirmed: ${soapNoteMdPath}`)
        spawnDocxConversion(soapNoteMdPath, caseTag)
      } else if (!isRetry) {
        log(`${tag}[soap] WARNING: claude exited 0 but SOAP note file not found — skill may not have been invoked. Retrying...`)
        spawnSoapGeneration(transcriptAbsPath, soapNoteMdPath, caseTag, true, templatePath)
      } else {
        log(`${tag}[soap] ERROR: SOAP note file still missing after retry — manual intervention required: ${soapNoteMdPath}`)
        notifyUser('SOAP generation failed', `Case: ${caseTag || 'unknown'} — skill may not have been invoked`)
      }
    }
  })
  claudeProc.on('error', err => {
    log(`${tag}[soap ERR] failed to spawn claude: ${err.message}`)
    if (err.code === 'ENOENT') {
      win.webContents.send('setup-warning', 'Claude is not installed — note generation unavailable. Install the Claude CLI to enable SOAP notes.')
    }
  })
}

function spawnDocxConversion(mdPath, caseTag) {
  const tag = caseTag ? `[${caseTag}] ` : ''
  log(`${tag}[docx] Converting: ${mdPath}`)
  const proc = spawn(PYTHON, [
    path.join(__dirname, 'python', 'md_to_docx.py'),
    mdPath
  ], { cwd: __dirname, stdio: 'pipe' })

  proc.stdout.on('data', d => log(`${tag}[docx] Saved: ${d.toString().trim()}`))
  proc.stderr.on('data', d => log(`${tag}[docx ERR] ${d.toString().trim()}`))
  proc.on('close', code => {
    log(`${tag}[docx] exited ${code}`)
    if (code === 0 && path.basename(mdPath) !== 'transcript.md') {
      notifyUser('SOAP note ready', `Case: ${caseTag || 'unknown'}`)
    }
  })
  proc.on('error', err => log(`${tag}[docx ERR] failed to spawn md_to_docx: ${err.message}`))
}

function checkForUpdates() {
  // Run git pull --ff-only in background — no blocking, no crash on failure
  const gitPull = spawn('git', ['pull', '--ff-only'], {
    cwd: __dirname,
    stdio: 'pipe',
    shell: process.platform === 'win32'
  })

  let stdout = ''
  let stderr = ''
  gitPull.stdout.on('data', d => { stdout += d.toString() })
  gitPull.stderr.on('data', d => { stderr += d.toString() })

  gitPull.on('close', code => {
    if (code !== 0) {
      log(`[update] git pull failed (exit ${code}): ${stderr.trim()}`)
      return
    }
    const output = stdout.trim()
    log(`[update] ${output}`)

    // 'Already up to date.' means no changes — do nothing
    if (output === 'Already up to date.') return

    // New commits were pulled — notify the user via tray tooltip and OS notification
    log('[update] New version pulled — notifying user')
    if (tray) tray.setToolTip('AI Medical Scribe — updated, restart to apply')

    const { Notification } = require('electron')
    if (Notification.isSupported()) {
      new Notification({
        title: 'AI Medical Scribe updated',
        body: 'A new version was downloaded. Restart the app to apply it.',
        silent: true
      }).show()
    }
  })

  gitPull.on('error', err => log(`[update] git not found or failed: ${err.message}`))
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
// Single-instance guard
// ---------------------------------------------------------------------------

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (!win.isVisible()) win.show()
      win.focus()
    }
  })

// ---------------------------------------------------------------------------
// App ready
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  // No dock icon on macOS
  app.dock?.hide()

  // Load notes directory from .env if already configured
  const env = readEnv()
  const savedPath = env.NOTES_DIR_PATH && env.NOTES_DIR_PATH.trim()
  if (savedPath) {
    loadPaths(savedPath)
    fs.mkdirSync(CASES_DIR, { recursive: true })
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true })
    copyDirSync(CLAUDE_CONFIG_SRC, path.join(NOTES_DIR, '.claude'))
    log('.claude config synced to AI Medical Notes')
  }
  // If no path set, the renderer will show the folder setup view


  log('App started')

  // Auto-update: pull latest code from GitHub silently on startup
  checkForUpdates()

  // Startup diagnostics
  log('=== Diagnostics ===')
  log(`OS: ${process.platform} ${os.release()} (${os.arch()})`)
  log(`Electron: ${process.versions.electron}`)
  log(`Node: ${process.version}`)

  try {
    const pyVer = execSync(`${PYTHON} --version`, { stdio: 'pipe' }).toString().trim()
    log(`Python: ${pyVer}`)
  } catch {
    log('WARNING: Python not found')
  }

  try {
    const ffVer = execSync('ffmpeg -version', { stdio: 'pipe' }).toString().split('\n')[0].trim()
    log(`ffmpeg: ${ffVer}`)
  } catch {
    log('WARNING: ffmpeg not found — MP3 conversion via pydub may fail')
  }

  // Log audio device list in background (Windows only — macOS uses BlackHole)
  if (process.platform === 'win32') {
    const devProc = spawn(PYTHON, [
      path.join(__dirname, 'python', 'record.py'), '--list-devices'
    ], { cwd: __dirname, stdio: 'pipe' })
    let devOut = ''
    devProc.stdout.on('data', d => { devOut += d.toString() })
    devProc.on('close', code => {
      if (code === 0) {
        try {
          const info = JSON.parse(devOut.trim())
          log(`Default output: ${info.defaultOutput}`)
          info.devices.forEach(d => log(`  Loopback [${d.index}]: ${d.name}${d.isDefault ? ' (default)' : ''}`))
        } catch { /* ignore parse errors */ }
      }
    })
  }

  log('=== End Diagnostics ===')

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

  ipcMain.handle('hide-window', () => { if (win && !win.isDestroyed()) win.hide() })

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
  ipcMain.handle('start-session', async () => {
    log('start-session')
    const settings = readSettings()
    const doctors = settings.doctors || []

    if (doctors.length === 0) {
      log('start-session blocked: no doctors configured')
      return { ok: false, error: 'no-doctors' }
    }

    if (doctors.length === 1) {
      activeDoctorId = doctors[0].id
      log(`Auto-selected doctor: ${doctors[0].name}`)
    } else {
      // Multiple doctors — ask renderer to pick
      const selectedId = await new Promise(resolve => {
        doctorPickerResolver = resolve
        win.webContents.send('pick-doctor', doctors)
      })

      if (!selectedId) {
        log('start-session cancelled: no doctor selected')
        return { ok: false, error: 'cancelled' }
      }

      activeDoctorId = selectedId
      log(`Selected doctor ID: ${selectedId}`)
    }

    setState(STATE.SESSION_ACTIVE)
    return { ok: true }
  })

  // ---- stop-session ----
  ipcMain.handle('stop-session', async () => {
    log('stop-session')
    if (doctorPickerResolver) {
      doctorPickerResolver(null)
      doctorPickerResolver = null
    }
    activeDoctorId = null
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

    const settings = readSettings()
    const recordArgs = [
      path.join(__dirname, 'python', 'record.py'),
      '--output', tempMp3Path
    ]
    if (settings.manualDeviceSelection && settings.selectedDeviceIndex != null) {
      recordArgs.push('--device', String(settings.selectedDeviceIndex))
      log(`Using manual device index: ${settings.selectedDeviceIndex}`)
    }

    recordingProcess = spawn(PYTHON, recordArgs, { cwd: __dirname })

    recordingProcess.stdout.on('data', d => log(`[record.py] ${d.toString().trim()}`))
    recordingProcess.stderr.on('data', d => {
      const msg = d.toString().trim()
      if (!msg) return
      log(`[record.py ERR] ${msg}`)
      // Surface BlackHole / setup errors to renderer
      if (msg.includes('ERROR')) {
        win.webContents.send('setup-warning', msg.replace(/^ERROR:\s*/, ''))
      }
    })
    recordingProcess.on('exit', code => {
      log(`record.py exited ${code}`)
      // recordingProcess is nulled by stop-recording before it awaits exit,
      // so a non-null value here means Python died on its own — recover to SESSION_ACTIVE.
      if ((currentState === STATE.RECORDING || currentState === STATE.PAUSED) && recordingProcess !== null) {
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
      // Null recordingProcess BEFORE awaiting exit so the exit handler (registered in
      // start-recording) knows this is an intentional stop and doesn't fire the
      // "exited unexpectedly" recovery path.
      const procToStop = recordingProcess
      recordingProcess = null
      // Signal Python to stop cleanly via stdin (reliable on Windows).
      // Python flushes the WAV and converts to MP3 before exiting.
      // Do NOT use kill() here — TerminateProcess() on Windows gives Python
      // no chance to run cleanup code.
      try {
        procToStop.stdin.write('stop\n')
        procToStop.stdin.end()
      } catch (e) {
        log(`stdin write failed (process may have already exited): ${e.message}`)
      }
      await waitForExit(procToStop)
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

    const { caseDir, folderName } = buildCaseFolder(name)
    const mp3Filename = name ? `${name}.mp3` : 'recording.mp3'
    const mp3Dest = path.join(caseDir, mp3Filename)
    const transcriptDest = path.join(caseDir, 'transcript.md')
    const soapNotePath = path.join(caseDir, `${folderName}_soap_note.md`)

    const _stopSettings = readSettings()
    const _stopDoctor = (_stopSettings.doctors || []).find(d => d.id === activeDoctorId)
    const _stopTemplatePath = _stopDoctor?.templatePath || null

    if (fs.existsSync(tempMp3Path)) {
      fs.renameSync(tempMp3Path, mp3Dest)
      log(`MP3 moved to: ${mp3Dest}`)
    } else {
      log(`WARNING: temp MP3 not found at ${tempMp3Path} — recording may have failed`)
    }
    tempMp3Path = null

    spawnTranscription(mp3Dest, transcriptDest, soapNotePath, folderName, _stopTemplatePath)

    // Return to SESSION_ACTIVE so scribe can immediately start the next recording
    setState(STATE.SESSION_ACTIVE)

    // If auto-record is enabled, tell the renderer to trigger a new recording
    if (readSettings().autoRecord && win && !win.isDestroyed()) {
      win.webContents.send('auto-start-recording')
    }

    return true
  })

  // ---- pause-recording ----
  ipcMain.handle('pause-recording', () => {
    log('pause-recording')
    if (recordingProcess) {
      try {
        recordingProcess.stdin.write('pause\n')
      } catch (e) {
        log(`stdin write failed: ${e.message}`)
      }
    }
    setState(STATE.PAUSED)
    return true
  })

  // ---- resume-recording ----
  ipcMain.handle('resume-recording', () => {
    log('resume-recording')
    if (recordingProcess) {
      try {
        recordingProcess.stdin.write('resume\n')
      } catch (e) {
        log(`stdin write failed: ${e.message}`)
      }
    }
    setState(STATE.RECORDING)
    return true
  })

  // ---- discard-recording ----
  ipcMain.handle('discard-recording', async () => {
    log('discard-recording')

    if (recordingProcess) {
      const procToStop = recordingProcess
      recordingProcess = null
      try {
        procToStop.stdin.write('stop\n')
        procToStop.stdin.end()
      } catch (e) {
        log(`stdin write failed (process may have already exited): ${e.message}`)
      }
      await waitForExit(procToStop)
    }

    if (tempMp3Path && fs.existsSync(tempMp3Path)) {
      try {
        fs.unlinkSync(tempMp3Path)
        log(`Discarded temp MP3: ${tempMp3Path}`)
      } catch (e) {
        log(`Failed to delete temp MP3: ${e.message}`)
      }
    }
    tempMp3Path = null

    setState(STATE.SESSION_ACTIVE)
    return true
  })

  // ---- submit-patient-name (registered once at startup) ----
  ipcMain.handle('submit-patient-name', (_, name) => {
    if (patientNameResolver) {
      patientNameResolver(sanitizeName(name))
      patientNameResolver = null
    }
    return true
  })

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
      noDoctors: (settings.doctors || []).length === 0,
      notesDirMissing: !notesDirEnv || !notesDirEnv.trim()
    }
  })

  // ---- get-doctors ----
  ipcMain.handle('get-doctors', () => {
    const settings = readSettings()
    return settings.doctors || []
  })

  // ---- add-doctor ----
  ipcMain.handle('add-doctor', async (_, name) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return { ok: false, error: 'Name cannot be empty' }

    const result = await dialog.showOpenDialog(win, {
      title: `Select Template for ${trimmed}`,
      properties: ['openFile'],
      filters: [{ name: 'Markdown Files', extensions: ['md'] }]
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' }
    }

    const templatePath = result.filePaths[0]
    const doctor = { id: String(Date.now()), name: trimmed, templatePath }
    const settings = readSettings()
    const doctors = settings.doctors || []
    doctors.push(doctor)
    writeSettings({ ...settings, doctors })
    log(`Doctor added: ${trimmed} (template: ${templatePath})`)
    return { ok: true, doctor }
  })

  // ---- update-doctor-template ----
  ipcMain.handle('update-doctor-template', async (_, id) => {
    const settings = readSettings()
    const doctor = (settings.doctors || []).find(d => d.id === id)
    if (!doctor) return { ok: false, error: 'Doctor not found' }

    const result = await dialog.showOpenDialog(win, {
      title: `Select Template for ${doctor.name}`,
      properties: ['openFile'],
      filters: [{ name: 'Markdown Files', extensions: ['md'] }]
    })

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: 'cancelled' }
    }

    doctor.templatePath = result.filePaths[0]
    writeSettings(settings)
    log(`Template updated for ${doctor.name}: ${doctor.templatePath}`)
    return { ok: true, doctor }
  })

  // ---- update-doctor ----
  ipcMain.handle('update-doctor', (_, id, name) => {
    const trimmed = (name || '').trim()
    if (!trimmed) return { ok: false, error: 'Name cannot be empty' }
    const settings = readSettings()
    const doctor = (settings.doctors || []).find(d => d.id === id)
    if (!doctor) return { ok: false, error: 'Doctor not found' }
    doctor.name = trimmed
    writeSettings(settings)
    log(`Doctor name updated: ${id} -> ${trimmed}`)
    return { ok: true }
  })

  // ---- remove-doctor ----
  ipcMain.handle('remove-doctor', (_, id) => {
    try {
      const settings = readSettings()
      const doctors = (settings.doctors || []).filter(d => d.id !== id)
      writeSettings({ ...settings, doctors })
      log(`Doctor removed: ${id}`)
      return { ok: true }
    } catch (e) {
      log(`ERROR removing doctor: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })

  // ---- select-doctor (resolves picker shown during start-session) ----
  ipcMain.handle('select-doctor', (_, id) => {
    if (doctorPickerResolver) {
      doctorPickerResolver(id)
      doctorPickerResolver = null
    }
    return true
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
      const current = readSettings()
      const merged = { ...current, ...settings }
      writeSettings(merged)
      log(`Settings saved: ${JSON.stringify(merged)}`)
      return { ok: true }
    } catch (e) {
      log(`ERROR saving settings: ${e.message}`)
      return { ok: false, error: e.message }
    }
  })

  // ---- list-audio-devices ----
  ipcMain.handle('list-audio-devices', () => {
    return new Promise(resolve => {
      const proc = spawn(PYTHON, [
        path.join(__dirname, 'python', 'record.py'),
        '--list-devices'
      ], { cwd: __dirname, stdio: 'pipe' })

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

  // ---- browse-audio-file ----
  ipcMain.handle('browse-audio-file', async () => {
    const result = await dialog.showOpenDialog(win, {
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
  ipcMain.handle('process-audio-file', (_, filePath, patientName) => {
    log(`process-audio-file: ${filePath}`)
    const name = sanitizeName(patientName)
    log(`Patient name: ${name || '(none)'}`)

    const { caseDir, folderName } = buildCaseFolder(name)
    const ext = path.extname(filePath)
    const audioFilename = name ? `${name}${ext}` : `recording${ext}`
    const audioDest = path.join(caseDir, audioFilename)
    const transcriptDest = path.join(caseDir, 'transcript.md')
    const soapNotePath = path.join(caseDir, `${folderName}_soap_note.md`)

    try {
      fs.copyFileSync(filePath, audioDest)
      log(`Audio copied to: ${audioDest}`)
    } catch (e) {
      log(`ERROR copying audio file: ${e.message}`)
      setState(STATE.SESSION_ACTIVE)
      return false
    }

    const _uploadSettings = readSettings()
    const _uploadDoctor = (_uploadSettings.doctors || []).find(d => d.id === activeDoctorId)
    const _uploadTemplatePath = _uploadDoctor?.templatePath || null

    setState(STATE.PROCESSING)
    spawnTranscription(audioDest, transcriptDest, soapNotePath, folderName, _uploadTemplatePath)

    // Return to SESSION_ACTIVE immediately — pipeline runs in background
    setState(STATE.SESSION_ACTIVE)
    return true
  })

  // ---- get-notes-dir ----
  ipcMain.handle('get-notes-dir', () => NOTES_DIR)

  // ---- change-notes-dir ----
  ipcMain.handle('change-notes-dir', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Choose where to store your AI Medical Notes',
      buttonLabel: 'Select Folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return { ok: false }
    const newNotesDir = path.join(result.filePaths[0], 'AI Medical Notes')
    writeEnvKey('NOTES_DIR_PATH', newNotesDir)
    loadPaths(newNotesDir)
    fs.mkdirSync(CASES_DIR, { recursive: true })
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true })
    copyDirSync(CLAUDE_CONFIG_SRC, path.join(NOTES_DIR, '.claude'))
    log(`Notes directory set to: ${NOTES_DIR}`)
    return { ok: true, path: NOTES_DIR }
  })
}

} // end single-instance else block
