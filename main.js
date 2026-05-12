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

let PYTHON = process.platform === 'win32' ? 'python' : 'python3'

function resolvePythonCommand () {
  const candidates = process.platform === 'win32'
    ? ['py', 'python', 'python3']
    : ['python3', 'python']
  for (const cmd of candidates) {
    try {
      const out = execSync(`${cmd} --version`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
      if (/^Python\s+3\./.test(out)) return { cmd, version: out }
    } catch { /* not available — try next */ }
  }
  return null
}

const STATE = {
  IDLE: 'IDLE',
  SESSION_ACTIVE: 'SESSION_ACTIVE',
  RECORDING: 'RECORDING',
  PAUSED: 'PAUSED',
  PROCESSING: 'PROCESSING'
}

const STATUS_LABELS = {
  transcribing:    'Transcribing...',
  generating_note: 'Generating note...',
  converting:      'Converting...',
  completed:       'Completed',
  failed:          'Failed'
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
let activeSessionDir = null
let statusWin = null
let sessionRecordings = []
let userMovedPopup = false
let isProgrammaticMove = false

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
  doctors: [],
  // Model config — surfaced in settings.json so it can be edited without a code change.
  // UI controls for these will come later; for now they are silent defaults that can be
  // overridden by editing settings.json directly.
  soapModel:      'claude-sonnet-4-6',
  templateModel:  'claude-opus-4-7',
  templateEffort: 'max'
}

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8')) }
  } catch { return { ...DEFAULT_SETTINGS } }
}

// Atomic write: write to .tmp then rename, with retry for transient Windows AV locks (EPERM/EBUSY).
function safeWriteFile(filePath, data) {
  const tmp = filePath + '.tmp'
  let lastErr
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.writeFileSync(tmp, data, 'utf8')
      fs.renameSync(tmp, filePath)
      return
    } catch (e) {
      lastErr = e
      if (attempt < 3 && (e.code === 'EPERM' || e.code === 'EBUSY')) {
        // Transient AV/indexer lock — wait and retry
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
      } else {
        break
      }
    }
  }
  throw lastErr
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true })
  safeWriteFile(getSettingsPath(), JSON.stringify(settings, null, 2))
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
    if (!userMovedPopup) {
      const pos = getPopupPosition(tray, win)
      isProgrammaticMove = true
      win.setPosition(pos.x, pos.y, false)
      setImmediate(() => { isProgrammaticMove = false })
    }
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

function extractLastname(fullName) {
  const stripped = fullName.trim().replace(/^(dr\.?|mr\.?|ms\.?|mrs\.?|prof\.?)\s*/i, '')
  const parts = stripped.trim().split(/\s+/)
  return sanitizeName(parts[parts.length - 1])
}

function sanitizeName(name) {
  if (!name) return null
  const result = name.trim().toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
  return result || null
}

function createSessionFolder() {
  const datestamp = new Date().toISOString().slice(0, 10)
  let todayCount = 0
  try {
    todayCount = fs.readdirSync(CASES_DIR).filter(name => name === datestamp || name.startsWith(`${datestamp}(`)).length
  } catch {}
  const folderName = todayCount === 0 ? datestamp : `${datestamp}(${todayCount + 1})`
  const sessionDir = path.join(CASES_DIR, folderName)
  fs.mkdirSync(sessionDir, { recursive: true })
  log(`Session folder created: ${sessionDir}`)
  return sessionDir
}

function buildCaseFolder(sanitizedName) {
  const datestamp = new Date().toISOString().slice(0, 10)
  const folderName = sanitizedName
    ? `${sanitizedName}_${datestamp}`
    : `recording_${datestamp}_${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}`
  const baseDir = activeSessionDir || CASES_DIR
  const caseDir = path.join(baseDir, folderName)
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
      if (caseTag) updateRecordingStatus(caseTag, 'failed')
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
  if (caseTag) updateRecordingStatus(caseTag, 'generating_note')
  const relTranscript = path.relative(NOTES_DIR, transcriptAbsPath).replace(/\\/g, '/')
  let prompt
  if (templatePath) {
    const relTemplate = path.relative(NOTES_DIR, templatePath).replace(/\\/g, '/')
    prompt = `generate a note using template "${relTemplate}" and transcript "${relTranscript}"`
  } else {
    prompt = `generate a note using transcript "${relTranscript}"`
  }

  const attempt = isRetry ? ' (retry)' : ''
  const soapModel = readSettings().soapModel
  const modelFlag = soapModel ? ` --model ${soapModel}` : ''
  log(`${tag}[soap] Spawning${attempt}: claude -p "${prompt}"${modelFlag}`)

  const safePrompt = prompt.replace(/"/g, '\\"')
  const claudeProc = spawn(
    `claude -p "${safePrompt}"${modelFlag} --dangerously-skip-permissions`,
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
      if (caseTag) updateRecordingStatus(caseTag, 'failed')
      return
    }
    if (code === 0 && soapNoteMdPath) {
      if (fs.existsSync(soapNoteMdPath)) {
        log(`${tag}[soap] SOAP note confirmed: ${soapNoteMdPath}`)
        spawnDocxConversion(soapNoteMdPath, caseTag)
      } else {
        // Top-level soap note missing — Claude may have created per-patient subfolders
        const caseDir = path.dirname(soapNoteMdPath)
        const patientFolders = detectPatientFolders(caseDir)
        if (patientFolders.length > 0) {
          log(`${tag}[soap] Multi-patient: ${patientFolders.length} patient(s) detected`)
          const patients = patientFolders.map(pf => ({
            name: pf.folderName.replace(/_\d{4}-\d{2}-\d{2}$/, '').replace(/_/g, ' '),
            folderName: pf.folderName,
            status: 'converting'
          }))
          if (caseTag) setRecordingPatients(caseTag, patients)
          for (const pf of patientFolders) {
            spawnDocxConversion(pf.soapNotePath, caseTag, pf.folderName)
          }
        } else {
          log(`${tag}[soap] WARNING: claude exited 0 but no SOAP note found at ${soapNoteMdPath}`)
          if (caseTag) updateRecordingStatus(caseTag, 'failed')
        }
      }
    } else if (code !== 0) {
      if (caseTag) updateRecordingStatus(caseTag, 'failed')
    }
  })
  claudeProc.on('error', err => {
    log(`${tag}[soap ERR] failed to spawn claude: ${err.message}`)
    if (err.code === 'ENOENT') {
      win.webContents.send('setup-warning', 'Claude is not installed — note generation unavailable. Install the Claude CLI to enable SOAP notes.')
    }
  })
}

function spawnDocxConversion(mdPath, caseTag, patientFolderName = null) {
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
    if (path.basename(mdPath) !== 'transcript.md') {
      if (code === 0) {
        if (patientFolderName) {
          const entry = sessionRecordings.find(r => r.caseTag === caseTag)
          const patient = entry?.patients?.find(p => p.folderName === patientFolderName)
          if (patient) patient.soapDocxPath = mdPath.replace(/\.md$/, '.docx')
          notifyUser('SOAP note ready', patient?.name || patientFolderName.replace(/_/g, ' '))
          updatePatientStatus(caseTag, patientFolderName, 'completed')
        } else if (caseTag) {
          const entry = sessionRecordings.find(r => r.caseTag === caseTag)
          if (entry) entry.soapDocxPath = mdPath.replace(/\.md$/, '.docx')
          notifyUser('SOAP note ready', entry?.displayName || caseTag)
          updateRecordingStatus(caseTag, 'completed')
        }
      } else {
        if (patientFolderName) {
          updatePatientStatus(caseTag, patientFolderName, 'failed')
        } else if (caseTag) {
          updateRecordingStatus(caseTag, 'failed')
        }
      }
    }
  })
  proc.on('error', err => log(`${tag}[docx ERR] failed to spawn md_to_docx: ${err.message}`))
}

// ---------------------------------------------------------------------------
// Template creation (Doctor Profile) — background job
// ---------------------------------------------------------------------------
//
// Invoked from the Templates tab "Create with AI" flow.
// Runs the create-doctor-profile skill via Claude (Opus 4.7 max effort by default)
// on a folder of sample notes + supporting docs the user has uploaded.
// Only ONE job can run at a time (lock). Job state is written to
// <NOTES_DIR>/.template_job.json so the renderer can poll while the popup
// is closed and pick up progress on reopen.

let templateJobProc = null
let templateJobStartMs = 0

function getJobStatusPath() { return path.join(NOTES_DIR, '.template_job.json') }

function readTemplateJob() {
  try {
    return JSON.parse(fs.readFileSync(getJobStatusPath(), 'utf8'))
  } catch {
    return { status: 'idle' }
  }
}

function writeTemplateJob(job) {
  try {
    safeWriteFile(getJobStatusPath(), JSON.stringify(job, null, 2))
  } catch (e) {
    log(`[template-job] WARNING: failed to write job status: ${e.message}`)
  }
}

function broadcastTemplateJob(job) {
  writeTemplateJob(job)
  if (win && !win.isDestroyed()) {
    win.webContents.send('template-job-status', job)
  }
}

function spawnTemplateCreation(doctorName, stagingDir) {
  const lastname = extractLastname(doctorName) || 'doctor'
  const stagingRel = path.relative(NOTES_DIR, stagingDir).replace(/\\/g, '/')
  const settings = readSettings()
  const model  = settings.templateModel  || 'claude-opus-4-7'
  const effort = settings.templateEffort || 'max'

  const prompt = `create a doctor profile for "${doctorName}" from source folder "${stagingRel}"`
  const safePrompt = prompt.replace(/"/g, '\\"')

  log(`[template] Spawning: claude -p "${prompt}" --model ${model} (effort=${effort})`)
  templateJobStartMs = Date.now()

  templateJobProc = spawn(
    `claude -p "${safePrompt}" --model ${model} --dangerously-skip-permissions`,
    [],
    {
      cwd: NOTES_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: effort }
    }
  )

  const outChunks = []
  templateJobProc.stdout.on('data', d => {
    const msg = d.toString()
    outChunks.push(msg)
    log(`[template] ${msg.trim()}`)
  })
  templateJobProc.stderr.on('data', d => {
    const msg = d.toString()
    outChunks.push(msg)
    log(`[template ERR] ${msg.trim()}`)
  })

  templateJobProc.on('close', code => {
    const proc = templateJobProc
    templateJobProc = null
    const output = outChunks.join('')
    const durationMs = Date.now() - templateJobStartMs
    log(`[template] claude exited ${code} after ${Math.round(durationMs / 1000)}s`)

    // Detect Claude usage-limit errors and surface them as a service warning
    if (/rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i.test(output)) {
      broadcastTemplateJob({
        status: 'failed',
        doctorName,
        lastname,
        error: 'Claude usage limit reached. Try again once the limit resets.',
        finishedAt: Date.now()
      })
      if (win && !win.isDestroyed()) {
        win.webContents.send('service-warning', {
          title: 'Claude usage limit reached',
          message: 'Template creation could not complete — try again once the limit resets.'
        })
      }
      return
    }

    const expectedPath = path.join(TEMPLATES_DIR, `${lastname}.md`)
    if (code === 0 && fs.existsSync(expectedPath)) {
      // Success — register the doctor in settings.json (if not already there)
      try {
        const s = readSettings()
        const doctors = s.doctors || []
        const existingIdx = doctors.findIndex(d =>
          d.templatePath === expectedPath ||
          sanitizeName(d.name) === lastname
        )
        const doctorEntry = {
          id: existingIdx >= 0 ? doctors[existingIdx].id : String(Date.now()),
          name: doctorName.trim(),
          templatePath: expectedPath
        }
        if (existingIdx >= 0) doctors[existingIdx] = doctorEntry
        else doctors.push(doctorEntry)
        writeSettings({ ...s, doctors })
        log(`[template] Doctor registered: ${doctorName} (${expectedPath})`)
      } catch (e) {
        log(`[template] WARNING: failed to register doctor: ${e.message}`)
      }

      // Delete staging folder after success
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true })
        log(`[template] Staging deleted: ${stagingDir}`)
      } catch (e) {
        log(`[template] WARNING: failed to delete staging: ${e.message}`)
      }

      broadcastTemplateJob({
        status: 'success',
        doctorName,
        lastname,
        templatePath: expectedPath,
        durationMs,
        finishedAt: Date.now()
      })
      notifyUser('Template ready', `Profile for ${doctorName} saved.`)
    } else {
      broadcastTemplateJob({
        status: 'failed',
        doctorName,
        lastname,
        error: code === 0
          ? `Claude exited 0 but template file not found at ${expectedPath}`
          : `Claude exited with code ${code}`,
        finishedAt: Date.now()
      })
      notifyUser('Template creation failed', `${doctorName} — check app.log for details`)
    }
  })

  templateJobProc.on('error', err => {
    const proc = templateJobProc
    templateJobProc = null
    log(`[template ERR] failed to spawn claude: ${err.message}`)
    broadcastTemplateJob({
      status: 'failed',
      doctorName,
      lastname,
      error: err.code === 'ENOENT'
        ? 'Claude CLI not installed. Install the Claude CLI to enable template creation.'
        : err.message,
      finishedAt: Date.now()
    })
  })

  broadcastTemplateJob({
    status: 'running',
    doctorName,
    lastname,
    startedAt: templateJobStartMs,
    model,
    effort
  })
}

function spawnTemplateUpdate(doctorName, templatePath, corrections, correctionsFile, samplesDir) {
  const lastname = extractLastname(doctorName) || doctorName.toLowerCase()
  const settings = readSettings()
  const model  = settings.templateModel  || 'claude-opus-4-7'
  const effort = settings.templateEffort || 'max'

  // Flatten multi-line corrections and strip double quotes to avoid breaking shell quoting on Windows
  const safeCorrections = (corrections || '').replace(/\r?\n/g, ' | ').replace(/"/g, "'")
  const safeName = doctorName.replace(/"/g, "'")
  const safePath = templatePath.replace(/\\/g, '/').replace(/"/g, "'")
  const safeCorrectionsFile = correctionsFile ? correctionsFile.replace(/\\/g, '/').replace(/"/g, "'") : ''
  const safeSamplesDir = samplesDir ? samplesDir.replace(/\\/g, '/').replace(/"/g, "'") : ''

  const prompt = `update doctor profile. Doctor: ${safeName}. Template: ${safePath}. Corrections: ${safeCorrections}. CorrectionsFile: ${safeCorrectionsFile}. Samples: ${safeSamplesDir}`

  log(`[template-update] Spawning: claude -p <update prompt> --model ${model} (effort=${effort})`)
  templateJobStartMs = Date.now()

  templateJobProc = spawn(
    `claude -p "${prompt}" --model ${model} --dangerously-skip-permissions`,
    [],
    {
      cwd: NOTES_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: effort }
    }
  )

  const outChunks = []
  templateJobProc.stdout.on('data', d => {
    const msg = d.toString()
    outChunks.push(msg)
    log(`[template-update] ${msg.trim()}`)
  })
  templateJobProc.stderr.on('data', d => {
    const msg = d.toString()
    outChunks.push(msg)
    log(`[template-update ERR] ${msg.trim()}`)
  })

  templateJobProc.on('close', code => {
    templateJobProc = null
    const output = outChunks.join('')
    const durationMs = Date.now() - templateJobStartMs
    log(`[template-update] claude exited ${code} after ${Math.round(durationMs / 1000)}s`)

    if (/rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i.test(output)) {
      broadcastTemplateJob({
        type: 'update',
        status: 'failed',
        doctorName,
        lastname,
        error: 'Claude usage limit reached. Try again once the limit resets.',
        finishedAt: Date.now()
      })
      if (win && !win.isDestroyed()) {
        win.webContents.send('service-warning', {
          title: 'Claude usage limit reached',
          message: 'Template update could not complete — try again once the limit resets.'
        })
      }
      return
    }

    if (code === 0) {
      // Extract the Step 7 changes report — everything from "Updated:" to end of output
      const changesReport = (() => {
        const idx = output.indexOf('Updated:')
        return idx !== -1 ? output.slice(idx).trim() : null
      })()

      broadcastTemplateJob({
        type: 'update',
        status: 'success',
        doctorName,
        lastname,
        templatePath,
        durationMs,
        changesReport,
        finishedAt: Date.now()
      })

      // Clean up samples staging folder if one was used
      if (samplesDir && fs.existsSync(samplesDir)) {
        try { fs.rmSync(samplesDir, { recursive: true, force: true }) } catch (_) {}
      }

      notifyUser('Template updated', `Profile for ${doctorName} updated.`)
    } else {
      broadcastTemplateJob({
        type: 'update',
        status: 'failed',
        doctorName,
        lastname,
        error: `Claude exited with code ${code}`,
        finishedAt: Date.now()
      })
      notifyUser('Template update failed', `${doctorName} — check app.log for details`)
    }
  })

  templateJobProc.on('error', err => {
    templateJobProc = null
    log(`[template-update ERR] failed to spawn claude: ${err.message}`)
    broadcastTemplateJob({
      type: 'update',
      status: 'failed',
      doctorName,
      lastname,
      error: err.code === 'ENOENT'
        ? 'Claude CLI not installed. Install the Claude CLI to enable template updates.'
        : err.message,
      finishedAt: Date.now()
    })
  })

  broadcastTemplateJob({
    type: 'update',
    status: 'running',
    doctorName,
    lastname,
    startedAt: templateJobStartMs,
    model,
    effort
  })
}

// ---------------------------------------------------------------------------
// Pre-chart (edit-note) — background job
// ---------------------------------------------------------------------------
//
// Invoked from the SESSION_ACTIVE "Pre-chart" sub-view. Runs the edit-note
// skill against an existing patient case folder, optionally with new clinical
// content (one or more files combined into a single .md by extract_attachments.py)
// and/or scribe instructions. Shares the templateJobProc lock with template
// creation/update so only one Claude job runs at a time.

function findRecentPatientCases(notesDir, limit = 30) {
  if (!notesDir) return []
  const casesRoot = path.join(notesDir, 'Cases')
  if (!fs.existsSync(casesRoot)) return []

  const results = []
  let sessions = []
  try {
    sessions = fs.readdirSync(casesRoot, { withFileTypes: true }).filter(e => e.isDirectory())
  } catch { return [] }

  for (const session of sessions) {
    const sessionPath = path.join(casesRoot, session.name)
    let caseDirs = []
    try {
      caseDirs = fs.readdirSync(sessionPath, { withFileTypes: true }).filter(e => e.isDirectory())
    } catch { continue }
    for (const c of caseDirs) {
      const caseDir = path.join(sessionPath, c.name)
      let soapNote = null
      try {
        soapNote = fs.readdirSync(caseDir).find(f =>
          f.endsWith('_soap_note.md') && !/_soap_note_backup_/.test(f)
        )
      } catch { continue }
      if (!soapNote) continue

      let mtime = 0
      try { mtime = fs.statSync(path.join(caseDir, soapNote)).mtimeMs } catch {}

      // Folder name: "<patient>_<YYYY-MM-DD>" or "recording_<YYYY-MM-DD>_<HH-MM-SS>"
      const m = c.name.match(/^(.+)_(\d{4}-\d{2}-\d{2})(?:_(\d{2}-\d{2}-\d{2}))?$/)
      let patient = c.name
      let date = ''
      if (m) {
        patient = m[1].replace(/_/g, ' ')
        date = m[2]
      }
      results.push({ caseDir, patient, date, mtime })
    }
  }

  results.sort((a, b) => b.mtime - a.mtime)
  return results.slice(0, limit)
}

function findExistingSoapNote(caseDir) {
  if (!caseDir || !fs.existsSync(caseDir)) return null
  try {
    const f = fs.readdirSync(caseDir).find(name =>
      name.endsWith('_soap_note.md') && !/_soap_note_backup_/.test(name)
    )
    return f ? path.join(caseDir, f) : null
  } catch { return null }
}

function resolveTemplateFromSoapNote(caseDir) {
  // Priority: parse **Doctor:** header from the existing soap note, match against
  // settings.json doctors by sanitized last-name. Fall back to active doctor.
  const settings = readSettings()
  const doctors = settings.doctors || []
  const soapPath = findExistingSoapNote(caseDir)

  let parsedLastname = null
  if (soapPath) {
    try {
      // Read just the header section — soap notes are short; reading 4KB is plenty.
      const head = fs.readFileSync(soapPath, 'utf8').slice(0, 4096)
      const m = head.match(/\*\*Doctor:\*\*\s*([^\n\r]+)/)
      if (m) parsedLastname = extractLastname(m[1])
    } catch {}
  }

  if (parsedLastname) {
    const match = doctors.find(d => extractLastname(d.name) === parsedLastname && d.templatePath && fs.existsSync(d.templatePath))
    if (match) return match.templatePath
  }

  if (activeDoctorId) {
    const active = doctors.find(d => d.id === activeDoctorId)
    if (active && active.templatePath && fs.existsSync(active.templatePath)) return active.templatePath
  }

  return null
}

function buildCombinedAttachment(filePaths) {
  return new Promise((resolve, reject) => {
    if (!filePaths || filePaths.length === 0) {
      resolve('')
      return
    }
    const tmp = path.join(os.tmpdir(), `prechart_${Date.now()}_${process.pid}.md`)
    const proc = spawn(PYTHON, [
      path.join(__dirname, 'python', 'extract_attachments.py'),
      '--output', tmp,
      '--inputs', ...filePaths
    ], { cwd: __dirname, stdio: 'pipe' })

    let stderr = ''
    proc.stderr.on('data', d => {
      const msg = d.toString()
      stderr += msg
      log(`[prechart][extract ERR] ${msg.trim()}`)
    })
    proc.stdout.on('data', d => log(`[prechart][extract] ${d.toString().trim()}`))
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(tmp)) {
        log(`[prechart][extract] combined ${filePaths.length} file(s) → ${tmp}`)
        resolve(tmp)
      } else {
        reject(new Error(`extract_attachments exited ${code}: ${stderr.trim()}`))
      }
    })
    proc.on('error', err => reject(err))
  })
}

function spawnPrechartJob(caseDir, templatePath, instructions, combinedAttachmentPath) {
  const caseName = path.basename(caseDir)
  const patientLabel = caseName.replace(/_\d{4}-\d{2}-\d{2}.*$/, '').replace(/_/g, ' ') || caseName
  const settings = readSettings()
  const model = settings.soapModel || 'claude-sonnet-4-6'

  // Build the skill prompt. Match update-doctor-profile's style: literal field names,
  // shell-safe quoting (replace " with ' inside any user-supplied string).
  const safeCase    = caseDir.replace(/\\/g, '/').replace(/"/g, "'")
  const safeTpl     = templatePath.replace(/\\/g, '/').replace(/"/g, "'")
  const safeAttach  = (combinedAttachmentPath || '').replace(/\\/g, '/').replace(/"/g, "'")
  const safeInstr   = (instructions || '').replace(/\r?\n/g, ' ').replace(/"/g, "'")
  const promptText  = `edit note. Case: ${safeCase}. Template: ${safeTpl}. Attachment: ${safeAttach}. Instructions: ${safeInstr}`

  log(`[prechart][${patientLabel}] Spawning: claude -p <edit-note prompt> --model ${model}`)
  templateJobStartMs = Date.now()

  templateJobProc = spawn(
    `claude -p "${promptText}" --model ${model} --dangerously-skip-permissions`,
    [],
    {
      cwd: NOTES_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env, CLAUDE_CODE_EFFORT_LEVEL: 'high' }
    }
  )

  const outChunks = []
  templateJobProc.stdout.on('data', d => {
    const msg = d.toString()
    outChunks.push(msg)
    log(`[prechart][${patientLabel}] ${msg.trim()}`)
  })
  templateJobProc.stderr.on('data', d => {
    const msg = d.toString()
    outChunks.push(msg)
    log(`[prechart][${patientLabel} ERR] ${msg.trim()}`)
  })

  const cleanupAttachment = () => {
    if (combinedAttachmentPath) {
      try {
        fs.unlinkSync(combinedAttachmentPath)
        log(`[prechart][${patientLabel}] cleaned up temp attachment`)
      } catch (e) {
        log(`[prechart][${patientLabel}] WARNING: failed to delete temp attachment: ${e.message}`)
      }
    }
  }

  templateJobProc.on('close', code => {
    templateJobProc = null
    cleanupAttachment()
    const output = outChunks.join('')
    const durationMs = Date.now() - templateJobStartMs
    log(`[prechart][${patientLabel}] claude exited ${code} after ${Math.round(durationMs / 1000)}s`)

    if (/rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i.test(output)) {
      broadcastTemplateJob({
        type: 'prechart',
        status: 'failed',
        doctorName: patientLabel,
        lastname: patientLabel,
        caseDir,
        error: 'Claude usage limit reached. Try again once the limit resets.',
        finishedAt: Date.now()
      })
      if (win && !win.isDestroyed()) {
        win.webContents.send('service-warning', {
          title: 'Claude usage limit reached',
          message: 'Pre-chart could not complete — try again once the limit resets.'
        })
      }
      return
    }

    if (code === 0) {
      // Skill overwrites the soap note in place — refresh the .docx mirror
      const updatedNote = findExistingSoapNote(caseDir)
      if (updatedNote) {
        spawnDocxConversion(updatedNote, null)
      } else {
        log(`[prechart][${patientLabel}] WARNING: claude exited 0 but soap note not found in ${caseDir}`)
      }
      broadcastTemplateJob({
        type: 'prechart',
        status: 'success',
        doctorName: patientLabel,
        lastname: patientLabel,
        caseDir,
        durationMs,
        finishedAt: Date.now()
      })
      notifyUser('Pre-chart applied', `${patientLabel}'s note has been updated.`)
    } else {
      broadcastTemplateJob({
        type: 'prechart',
        status: 'failed',
        doctorName: patientLabel,
        lastname: patientLabel,
        caseDir,
        error: `Claude exited with code ${code}`,
        finishedAt: Date.now()
      })
      notifyUser('Pre-chart failed', `${patientLabel} — check app.log for details`)
    }
  })

  templateJobProc.on('error', err => {
    templateJobProc = null
    cleanupAttachment()
    log(`[prechart][${patientLabel} ERR] failed to spawn claude: ${err.message}`)
    broadcastTemplateJob({
      type: 'prechart',
      status: 'failed',
      doctorName: patientLabel,
      lastname: patientLabel,
      caseDir,
      error: err.code === 'ENOENT'
        ? 'Claude CLI not installed. Install the Claude CLI to enable pre-chart.'
        : err.message,
      finishedAt: Date.now()
    })
  })

  broadcastTemplateJob({
    type: 'prechart',
    status: 'running',
    doctorName: patientLabel,
    lastname: patientLabel,
    caseDir,
    startedAt: templateJobStartMs,
    model
  })
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

    // New commits were pulled — re-sync skills immediately from updated code
    if (NOTES_DIR) {
      copyDirSync(CLAUDE_CONFIG_SRC, path.join(NOTES_DIR, '.claude'))
      log('[update] Skills re-synced from updated code')
    }

    // Notify the user via tray tooltip and OS notification
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
// Recording status tracking
// ---------------------------------------------------------------------------

function addRecordingEntry(caseTag, displayName) {
  sessionRecordings.push({
    caseTag,
    displayName: displayName || (caseTag ? caseTag.replace(/_/g, ' ') : 'Unnamed'),
    startedAt: Date.now(),
    status: 'transcribing'
  })
  broadcastRecordingStatus()
}

function updateRecordingStatus(caseTag, status) {
  const entry = sessionRecordings.find(r => r.caseTag === caseTag)
  if (entry) {
    entry.status = status
    broadcastRecordingStatus()
  }
}

function setRecordingPatients(caseTag, patients) {
  const entry = sessionRecordings.find(r => r.caseTag === caseTag)
  if (entry) {
    entry.patients = patients
    broadcastRecordingStatus()
  }
}

function updatePatientStatus(caseTag, patientFolderName, status) {
  const entry = sessionRecordings.find(r => r.caseTag === caseTag)
  if (!entry || !entry.patients) return
  const patient = entry.patients.find(p => p.folderName === patientFolderName)
  if (patient) {
    patient.status = status
    const allDone = entry.patients.every(p => p.status === 'completed' || p.status === 'failed')
    if (allDone) {
      entry.status = entry.patients.some(p => p.status === 'failed') ? 'failed' : 'completed'
    }
    broadcastRecordingStatus()
  }
}

function detectPatientFolders(caseDir) {
  // Patient folders are siblings of caseDir inside the session folder, not children of it
  const sessionDir = path.dirname(caseDir)

  // Exclude known recording case folders and patient folders already attributed to prior recordings
  const knownCaseTags = new Set(sessionRecordings.map(r => r.caseTag))
  const claimedPatients = new Set()
  sessionRecordings.forEach(r => {
    if (r.patients) r.patients.forEach(p => claimedPatients.add(p.folderName))
  })

  const results = []
  try {
    for (const entry of fs.readdirSync(sessionDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (knownCaseTags.has(entry.name)) continue   // skip recording case folders
      if (claimedPatients.has(entry.name)) continue  // skip patients of earlier recordings
      const subDir = path.join(sessionDir, entry.name)
      const soapNote = fs.readdirSync(subDir).find(f => f.endsWith('_soap_note.md'))
      if (soapNote) {
        results.push({ folderName: entry.name, soapNotePath: path.join(subDir, soapNote) })
      }
    }
  } catch (e) {
    log(`ERROR scanning patient folders in ${sessionDir}: ${e.message}`)
  }
  return results
}

function broadcastRecordingStatus() {
  const payload = sessionRecordings.map(r => ({
    ...r,
    statusLabel: STATUS_LABELS[r.status] || r.status,
    patients: r.patients ? r.patients.map(p => ({ ...p, statusLabel: STATUS_LABELS[p.status] || p.status })) : null
  }))
  if (win && !win.isDestroyed()) {
    win.webContents.send('recording-status-update', payload)
  }
  if (statusWin && !statusWin.isDestroyed()) {
    statusWin.webContents.send('recording-status-update', payload)
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

    // Clean up any stale template job from a prior crash/restart — the child
    // process died with the app, so a 'running' status in the file is orphaned.
    const staleJob = readTemplateJob()
    if (staleJob && staleJob.status === 'running') {
      writeTemplateJob({
        status: 'failed',
        doctorName: staleJob.doctorName,
        lastname: staleJob.lastname,
        error: 'Job was interrupted by an app restart. Please retry.',
        finishedAt: Date.now()
      })
      log('[template] Cleared stale running job state from previous run')
    }
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

  const pyResolved = resolvePythonCommand()
  if (pyResolved) {
    PYTHON = pyResolved.cmd
    log(`Python: ${pyResolved.version} (via ${PYTHON})`)
  } else {
    log('WARNING: Python 3 not found — tried py, python, python3')
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
    height: 420,
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

  win.on('move', () => {
    if (!isProgrammaticMove) userMovedPopup = true
  })

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

    activeSessionDir = createSessionFolder()
    sessionRecordings = []
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
    activeSessionDir = null
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
    if (statusWin && !statusWin.isDestroyed()) {
      statusWin.close()
    }
    sessionRecordings = []
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

    let exitPromise = Promise.resolve()
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
      exitPromise = waitForExit(procToStop)
    } else {
      log('WARNING: stop-recording called but recordingProcess already gone')
    }

    // Update UI immediately — don't wait for Python's WAV→MP3 conversion first.
    // This stops the timer and shows PROCESSING state right when Save is clicked.
    setState(STATE.PROCESSING)
    win.webContents.send('show-patient-form')

    // Wait for patient name entry and Python's WAV→MP3 conversion concurrently.
    // The scribe can name the case while the conversion runs in the background.
    const [name] = await Promise.all([
      new Promise(resolve => { patientNameResolver = resolve }),
      exitPromise
    ])

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

    addRecordingEntry(folderName, name ? name.replace(/_/g, ' ') : null)
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
      const mp3ToDelete = tempMp3Path
      tempMp3Path = null
      try {
        procToStop.stdin.write('stop\n')
        procToStop.stdin.end()
      } catch (e) {
        log(`stdin write failed (process may have already exited): ${e.message}`)
      }
      // Update UI immediately — stop the timer without waiting for Python's conversion.
      setState(STATE.SESSION_ACTIVE)
      // Clean up temp files in background after Python exits.
      // Also delete the WAV in case Python hadn't converted it yet.
      waitForExit(procToStop).then(() => {
        const wavPath = mp3ToDelete ? mp3ToDelete.replace('.mp3', '_tmp.wav') : null
        for (const p of [mp3ToDelete, wavPath]) {
          if (p && fs.existsSync(p)) {
            try { fs.unlinkSync(p) } catch (e) { log(`Failed to delete temp file: ${e.message}`) }
          }
        }
      }).catch(() => {})
      return true
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

    const srcPath = result.filePaths[0]
    const destPath = path.join(TEMPLATES_DIR, path.basename(srcPath))
    fs.copyFileSync(srcPath, destPath)
    const doctor = { id: String(Date.now()), name: trimmed, templatePath: destPath }
    const settings = readSettings()
    const doctors = settings.doctors || []
    doctors.push(doctor)
    writeSettings({ ...settings, doctors })
    log(`Doctor added: ${trimmed} (template: ${destPath})`)
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

    const srcPath = result.filePaths[0]
    const destPath = path.join(TEMPLATES_DIR, path.basename(srcPath))
    fs.copyFileSync(srcPath, destPath)
    doctor.templatePath = destPath
    writeSettings(settings)
    log(`Template updated for ${doctor.name}: ${destPath}`)
    return { ok: true, doctor }
  })

  // -------------------------------------------------------------------------
  // Template creation (AI profile builder) — Templates tab
  // -------------------------------------------------------------------------

  // ---- browse-notes-files ----
  // Multi-select file picker for sample notes + supporting documents.
  ipcMain.handle('browse-notes-files', async () => {
    const result = await dialog.showOpenDialog(win, {
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
  ipcMain.handle('start-template-creation', async (_, doctorName, filePaths) => {
    const name = (doctorName || '').trim()
    if (!name) return { ok: false, error: 'Doctor name is required' }
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return { ok: false, error: 'At least one source file is required' }
    }
    if (templateJobProc) {
      return { ok: false, error: 'A template creation job is already running' }
    }

    const lastname = extractLastname(name)
    if (!lastname) return { ok: false, error: 'Doctor name produced an empty identifier' }

    const stagingDir = path.join(NOTES_DIR, 'Templates', '_staging', lastname)
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
  ipcMain.handle('browse-corrections-file', async () => {
    const result = await dialog.showOpenDialog(win, {
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
  ipcMain.handle('start-template-update', async (_, doctorName, corrections, correctionsFile, sampleFiles) => {
    const name = (doctorName || '').trim()
    if (!name) return 'Doctor name is required.'

    const hasCorrections = (corrections || '').trim()
    const hasCorrectionsFile = correctionsFile && fs.existsSync(correctionsFile)
    const hasSamples = Array.isArray(sampleFiles) && sampleFiles.length > 0
    if (!hasCorrections && !hasCorrectionsFile && !hasSamples) {
      return 'Provide corrections text, a corrections file, or sample notes.'
    }
    if (templateJobProc) return 'A template job is already running.'

    const settings = readSettings()
    const doctor = (settings.doctors || []).find(d => d.name === name)
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
      samplesDir = path.join(NOTES_DIR, 'Templates', '_staging_update', `${lastname}_${ts}`)
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
  ipcMain.handle('get-doctors-with-templates', () => {
    const settings = readSettings()
    return (settings.doctors || [])
      .filter(d => d.templatePath && fs.existsSync(d.templatePath))
      .map(d => d.name)
      .sort()
  })

  // ---- get-template-job-status ----
  ipcMain.handle('get-template-job-status', () => readTemplateJob())

  // ---- dismiss-template-job ----
  ipcMain.handle('dismiss-template-job', () => {
    writeTemplateJob({ status: 'idle' })
    return { ok: true }
  })

  // ---- cancel-template-creation ----
  ipcMain.handle('cancel-template-creation', () => {
    if (!templateJobProc) return { ok: false, error: 'No job running' }
    try {
      templateJobProc.kill()
      log('[template] Cancellation requested')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  // -------------------------------------------------------------------------
  // Pre-chart (edit-note) — Record tab "Pre-chart" sub-view
  // -------------------------------------------------------------------------

  // ---- browse-prechart-files ----
  // Multi-select picker for attachment files (prechart docs, prior visit notes, etc.).
  // Same formats the edit-note skill knows how to read.
  ipcMain.handle('browse-prechart-files', async () => {
    const result = await dialog.showOpenDialog(win, {
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
  ipcMain.handle('list-recent-patient-cases', () => findRecentPatientCases(NOTES_DIR, 30))

  // ---- browse-patient-case-folder ----
  // Folder picker scoped to <NOTES_DIR>/Cases/. Validates the picked folder
  // contains a *_soap_note.md (excluding backup files).
  ipcMain.handle('browse-patient-case-folder', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Select patient case folder',
      defaultPath: CASES_DIR,
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
    if (templateJobProc) return { ok: false, error: 'Another job is already running.' }

    const settings = readSettings()
    const doctor = (settings.doctors || []).find(d => d.id === doctorId)
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
      const doctor = (settings.doctors || []).find(d => d.id === id)
      const doctors = (settings.doctors || []).filter(d => d.id !== id)
      writeSettings({ ...settings, doctors })

      if (doctor?.templatePath) {
        const tp = doctor.templatePath
        const stillUsed = doctors.some(d => d.templatePath === tp)
        if (!stillUsed && tp.startsWith(TEMPLATES_DIR) && fs.existsSync(tp)) {
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

  // ---- select-doctor (resolves picker shown during start-session) ----
  ipcMain.handle('select-doctor', (_, id) => {
    if (doctorPickerResolver) {
      doctorPickerResolver(id)
      doctorPickerResolver = null
    }
    return true
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

    addRecordingEntry(folderName, name ? name.replace(/_/g, ' ') : null)
    setState(STATE.PROCESSING)
    spawnTranscription(audioDest, transcriptDest, soapNotePath, folderName, _uploadTemplatePath)

    // Return to SESSION_ACTIVE immediately — pipeline runs in background
    setState(STATE.SESSION_ACTIVE)
    return true
  })

  // ---- get-notes-dir ----
  ipcMain.handle('get-notes-dir', () => NOTES_DIR)

  // ---- change-notes-dir ----
  ipcMain.handle('change-notes-dir', async (_, mode = 'new') => {
    const isExisting = mode === 'existing'
    const result = await dialog.showOpenDialog(win, {
      title: isExisting ? 'Select your existing AI Medical Notes folder' : 'Choose where to store your AI Medical Notes',
      buttonLabel: 'Select Folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return { ok: false }
    const newNotesDir = isExisting ? result.filePaths[0] : path.join(result.filePaths[0], 'AI Medical Notes')

    const oldNotesDir     = NOTES_DIR
    const oldTemplatesDir = TEMPLATES_DIR
    const oldSettings     = readSettings()

    writeEnvKey('NOTES_DIR_PATH', newNotesDir)
    loadPaths(newNotesDir)
    fs.mkdirSync(CASES_DIR, { recursive: true })
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true })

    if (oldTemplatesDir &&
        oldTemplatesDir !== TEMPLATES_DIR &&
        fs.existsSync(oldTemplatesDir)) {
      copyDirSync(oldTemplatesDir, TEMPLATES_DIR)
    }

    const migratedSettings = {
      ...oldSettings,
      doctors: (oldSettings.doctors || []).map(d => {
        if (!d || typeof d.templatePath !== 'string') return d
        if (oldNotesDir && d.templatePath.startsWith(oldNotesDir + path.sep)) {
          const rel = path.relative(oldNotesDir, d.templatePath)
          return { ...d, templatePath: path.join(NOTES_DIR, rel) }
        }
        return d
      })
    }

    writeSettings(migratedSettings)
    copyDirSync(CLAUDE_CONFIG_SRC, path.join(NOTES_DIR, '.claude'))
    log(`Notes directory set to: ${NOTES_DIR} (migrated ${migratedSettings.doctors?.length || 0} doctor template paths)`)
    return { ok: true, path: NOTES_DIR }
  })

  // ---- get-session-recordings ----
  ipcMain.handle('get-session-recordings', () => {
    return sessionRecordings.map(r => ({
      ...r,
      statusLabel: STATUS_LABELS[r.status] || r.status,
      patients: r.patients ? r.patients.map(p => ({ ...p, statusLabel: STATUS_LABELS[p.status] || p.status })) : null
    }))
  })

  // ---- open-status-window ----
  ipcMain.handle('open-status-window', () => {
    if (statusWin && !statusWin.isDestroyed()) {
      statusWin.focus()
      return
    }
    const mainBounds = win.getBounds()
    const statusWidth = 300
    const statusHeight = 380
    const { workArea } = screen.getPrimaryDisplay()
    let sx = mainBounds.x - statusWidth - 8
    let sy = mainBounds.y
    sx = Math.max(workArea.x, Math.min(sx, workArea.x + workArea.width - statusWidth))
    sy = Math.max(workArea.y, Math.min(sy, workArea.y + workArea.height - statusHeight))
    statusWin = new BrowserWindow({
      width: statusWidth,
      height: statusHeight,
      x: sx,
      y: sy,
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
    statusWin.loadFile(path.join(__dirname, 'renderer', 'status.html'))
    statusWin.on('closed', () => { statusWin = null })
  })

  // ---- close-status-window ----
  ipcMain.handle('close-status-window', () => {
    if (statusWin && !statusWin.isDestroyed()) statusWin.close()
  })

  // ---- open-soap-note ----
  ipcMain.handle('open-soap-note', async (_, filePath) => {
    const { shell } = require('electron')
    return shell.openPath(filePath)
  })
}

} // end single-instance else block
