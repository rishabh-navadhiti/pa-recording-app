'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog } = require('electron')
app.setName('Ai medical scribe')
app.setAppUserModelId('Ai medical scribe')
const path = require('path')
const fs = require('fs')
const os = require('os')
const https = require('https')
const { spawn, execSync } = require('child_process')
// DB modules use better-sqlite3, a native addon that must be compiled for the
// running Electron version. Wrap in try-catch so a missing/mis-built binary
// shows a recovery dialog instead of silently crashing. checkForUpdates() handles
// auto-rebuild after a git pull; install.ps1/reinstall.ps1 handle fresh installs.
let initDb, resetDb, migrateDoctorsFromSettings, tryRestoreDoctorsFromBackup
let dbDoctors, dbSessions, dbCases, dbEvents, dbCdiFlags
let _dbStartupError = null
try {
  ;({ initDb, resetDb, migrateDoctorsFromSettings, tryRestoreDoctorsFromBackup } = require('./db/init'))
  dbDoctors  = require('./db/doctors')
  dbSessions = require('./db/sessions')
  dbCases    = require('./db/cases')
  dbEvents   = require('./db/events')
  dbCdiFlags = require('./db/cdi_flags')
} catch (e) {
  _dbStartupError = e
}
const { parseSkillManifest } = require('./parseSkillManifest')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

let PYTHON = process.platform === 'win32' ? 'python' : 'python3'

// Staging-build detection. Presence of `.staging-marker` (gitignored, written by
// install-staging.ps1) flips the app into staging mode — UI badge, tooltip
// suffix on update notifications, etc. Marker is local-only by design so the
// same code on every branch behaves correctly without leaking the flag to users.
const STAGING_MARKER = path.join(__dirname, '.staging-marker')
function isStagingBuild () {
  try { return fs.existsSync(STAGING_MARKER) } catch { return false }
}

function getCurrentBranch () {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim()
  } catch { return 'unknown' }
}

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
  queued:          'Queued',
  coding_icd:      'Adding ICD codes...',
  running_cdi:     'Running CDI review...',
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
let activeSessionId = null
let doctorPickerResolver = null
let pendingAudioDuration = null  // set by record.py DURATION_SECONDS output; consumed in stop-recording
let activeSessionDir = null
let statusWin = null
let sessionRecordings = []
let isQuitting = false

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
  TEMPLATES_DIR = path.join(notesDir, 'Templates')
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

function nowIso() { return new Date().toISOString() }

// Canonical doctor list: DB first, then the one-time migration backup as last resort.
// settings.json no longer carries doctors[] after the v1 migration.
function getAllDoctors() {
  const fromDb = dbDoctors.listDoctors()
  if (fromDb.length > 0) return fromDb
  try {
    const backupPath = path.join(NOTES_DIR, 'settings.doctors.backup.json')
    const raw = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    if (Array.isArray(raw) && raw.length > 0) return raw
  } catch (_) {}
  return []
}

// ---------------------------------------------------------------------------
// Settings helpers (settings.json in NOTES_DIR)
// ---------------------------------------------------------------------------

function getSettingsPath() { return path.join(NOTES_DIR, 'settings.json') }

const DEFAULT_SETTINGS = {
  autoRecord: false,
  manualDeviceSelection: true,
  selectedDeviceIndex: null,
  // Model config — surfaced in settings.json so it can be edited without a code change.
  // UI controls for these will come later; for now they are silent defaults that can be
  // overridden by editing settings.json directly.
  soapModel:      'claude-sonnet-4-6',
  templateModel:  'claude-opus-4-7',
  templateEffort: 'max',
  // CDI Co-Pilot — global on/off + mode. Per-doctor specialty is in app.db
  // (doctors.specialty). When enableCdi is false, the CDI pipeline step is
  // skipped entirely for every case — no claude spawn, no DB writes, no UI.
  // When true, the CDI skill runs per case folder and emits CDI_SKIPPED for
  // doctors whose specialty is unset or unsupported.
  enableCdi: false,
  cdiMode:   'balanced'
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

function togglePopup() {
  if (win.isMinimized()) {
    win.restore()
    win.focus()
  } else if (win.isVisible()) {
    win.minimize()
  } else {
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

function hideFileFromUser(filePath) {
  if (process.platform !== 'win32') return
  const { exec } = require('child_process')
  exec(`attrib +h "${filePath}"`, err => {
    if (err) log(`[hide] ${path.basename(filePath)}: ${err.message}`)
  })
}

function hideNotesDirInternals() {
  if (process.platform !== 'win32') return
  if (!fs.existsSync(NOTES_DIR)) return
  try {
    fs.readdirSync(NOTES_DIR, { withFileTypes: true })
      .filter(e => e.name !== 'Cases')
      .forEach(e => hideFileFromUser(path.join(NOTES_DIR, e.name)))
  } catch {}
}

function hideExistingCaseMdFiles() {
  if (process.platform !== 'win32') return
  if (!fs.existsSync(CASES_DIR)) return
  try {
    const sessions = fs.readdirSync(CASES_DIR, { withFileTypes: true }).filter(e => e.isDirectory())
    for (const session of sessions) {
      const sessionPath = path.join(CASES_DIR, session.name)
      try {
        const cases = fs.readdirSync(sessionPath, { withFileTypes: true }).filter(e => e.isDirectory())
        for (const c of cases) {
          const caseDir = path.join(sessionPath, c.name)
          try {
            fs.readdirSync(caseDir)
              .filter(f => f.endsWith('.md') || f.endsWith('_cdi.json'))
              .forEach(f => hideFileFromUser(path.join(caseDir, f)))
          } catch {}
        }
      } catch {}
    }
  } catch {}
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

// Extract token + cost fields from a Claude stream-json result event for DB writes.
function extractUsage(ev) {
  if (!ev) return {}
  const u = ev.usage || {}
  return {
    inputTokens:         u.input_tokens          ?? null,
    outputTokens:        u.output_tokens          ?? null,
    cacheReadTokens:     u.cache_read_input_tokens ?? null,
    cacheCreatedTokens:  u.cache_creation_input_tokens ?? null,
    costUsd:             ev.total_cost_usd        ?? null,
    numTurns:            ev.num_turns             ?? null,
    durationMs:          ev.duration_ms           ?? null
  }
}

function spawnTranscription(mp3Path, transcriptDest, soapNotePath, caseTag, templatePath, caseId = null) {
  const tag = caseTag ? `[${caseTag}] ` : ''
  const stderrChunks = []
  const startedAt = nowIso()
  const wallStart = Date.now()

  let eventId = null
  try {
    eventId = dbEvents.startEvent({ caseId, jobKind: 'transcribe', startedAt })
  } catch (e) { log(`[db] startEvent(transcribe) failed: ${e.message}`) }

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
    const durationMs = Date.now() - wallStart
    if (code === 0) {
      try {
        dbEvents.finishEvent(eventId, { status: 'success', durationMs, finishedAt: nowIso() })
        dbCases.updateCasePaths(caseId, { status: 'generating_note', transcript_path: transcriptDest })
      } catch (e) { log(`[db] transcribe success update failed: ${e.message}`) }
      spawnSoapGeneration(transcriptDest, soapNotePath, caseTag, false, templatePath, caseId)
      spawnDocxConversion(transcriptDest, caseTag, null, caseId)
    } else {
      try {
        const stderr = stderrChunks.join('')
        dbEvents.finishEvent(eventId, { status: 'failed', durationMs, errorMessage: stderr.slice(0, 1024), finishedAt: nowIso() })
        dbCases.setCaseStatus(caseId, 'failed')
        if (caseId) dbSessions.bumpSessionCounters(activeSessionId, { failed: true })
      } catch (e) { log(`[db] transcribe failure update failed: ${e.message}`) }
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

// Shared wrapper for all claude -p invocations.
// Adds --output-format stream-json, parses the result event, and logs one usage line per job.
// onClose(code, errText, resultText, resultEvent) is called on exit;
// resultEvent is the full parsed { type:'result', usage:{...}, total_cost_usd, num_turns, duration_ms, result:'...' }
// or null if Claude exited without emitting a result event.
// onError(err) on spawn failure (optional).
function spawnClaude({ prompt, model, effort, tag, label, env, onClose, onError }) {
  const safePrompt = prompt.replace(/"/g, '\\"')
  const modelFlag = model ? ` --model ${model}` : ''
  const spawnEnv = { ...process.env, ...(effort ? { CLAUDE_CODE_EFFORT_LEVEL: effort } : {}), ...(env || {}) }

  const proc = spawn(
    `claude -p "${safePrompt}"${modelFlag} --output-format stream-json --verbose --dangerously-skip-permissions`,
    [],
    { cwd: NOTES_DIR, stdio: ['ignore', 'pipe', 'pipe'], shell: true, env: spawnEnv }
  )

  let buf = ''
  let resultText = ''
  let resultEvent = null
  const errChunks = []

  const processLine = line => {
    if (!line.trim()) return
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'result') {
        resultEvent = ev
        resultText = ev.result || ''
        const u = ev.usage || {}
        const cost = ev.total_cost_usd != null ? `$${ev.total_cost_usd.toFixed(4)}` : 'n/a'
        log(`${tag}[${label}][usage] input=${u.input_tokens || 0} output=${u.output_tokens || 0} cache_read=${u.cache_read_input_tokens || 0} cache_created=${u.cache_creation_input_tokens || 0} cost=${cost} turns=${ev.num_turns || '?'} time=${Math.round((ev.duration_ms || 0) / 1000)}s`)
      }
    } catch (_) {
      if (line.trim()) log(`${tag}[${label}] ${line.trim()}`)
    }
  }

  proc.stdout.on('data', chunk => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) processLine(line)
  })

  proc.stderr.on('data', d => {
    const msg = d.toString()
    errChunks.push(msg)
    log(`${tag}[${label} ERR] ${msg.trim()}`)
  })

  proc.on('close', code => {
    if (buf.trim()) processLine(buf)
    log(`${tag}[${label}] claude exited ${code}`)
    onClose(code, errChunks.join(''), resultText, resultEvent)
  })

  proc.on('error', err => {
    log(`${tag}[${label} ERR] failed to spawn claude: ${err.message}`)
    if (onError) onError(err)
    else onClose(null, '', '')
  })

  return proc
}

function spawnSoapGeneration(transcriptAbsPath, soapNoteMdPath, caseTag, isRetry = false, templatePath = null, caseId = null) {
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
  log(`${tag}[soap] Spawning${attempt}: claude -p "${prompt}"${soapModel ? ` --model ${soapModel}` : ''}`)

  const startedAt = nowIso()
  let eventId = null
  try {
    eventId = dbEvents.startEvent({ caseId, jobKind: 'soap', modelUsed: soapModel, startedAt })
  } catch (e) { log(`[db] startEvent(soap) failed: ${e.message}`) }

  spawnClaude({
    prompt,
    model: soapModel,
    tag,
    label: 'soap',
    onClose(code, errText, resultText, resultEvent) {
      const isRateLimited = /rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i.test(resultText + errText)
      if (isRateLimited) {
        try {
          dbEvents.finishEvent(eventId, {
            status: 'rate_limited',
            ...extractUsage(resultEvent),
            errorMessage: 'Claude usage limit reached',
            finishedAt: nowIso()
          })
          dbCases.setCaseStatus(caseId, 'failed')
          dbSessions.bumpSessionCounters(activeSessionId, { failed: true })
        } catch (e) { log(`[db] soap rate-limited update failed: ${e.message}`) }
        win.webContents.send('service-warning', {
          title: 'Claude usage limit reached',
          message: `Your recording has been saved. Notes could not be generated — try again once the limit resets.`
        })
        if (caseTag) updateRecordingStatus(caseTag, 'failed')
        return
      }
      if (code !== 0) {
        try {
          dbEvents.finishEvent(eventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: errText.slice(0, 1024), finishedAt: nowIso() })
          dbCases.setCaseStatus(caseId, 'failed')
          dbSessions.bumpSessionCounters(activeSessionId, { failed: true })
        } catch (e) { log(`[db] soap failure update failed: ${e.message}`) }
        if (caseTag) updateRecordingStatus(caseTag, 'failed')
        return
      }

      // Claude exited 0 — parse the JSON manifest from the skill's final assistant text.
      const manifest = parseSkillManifest(resultText)
      if (!manifest) {
        log(`${tag}[soap] ERROR: could not parse JSON manifest from skill output`)
        if (resultText && resultText.trim()) {
          log(`${tag}[soap][response]\n${resultText.trim()}`)
        } else {
          log(`${tag}[soap] (resultText was empty)`)
        }
        try {
          dbEvents.finishEvent(eventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: 'manifest parse failed', finishedAt: nowIso() })
          dbCases.setCaseStatus(caseId, 'failed')
          dbSessions.bumpSessionCounters(activeSessionId, { failed: true })
        } catch (e) { log(`[db] soap manifest-parse update failed: ${e.message}`) }
        if (caseTag) updateRecordingStatus(caseTag, 'failed')
        return
      }

      // Log Claude's full final response (chief-complaint prose + manifest line) as-is,
      // then log the parsed manifest separately on one line for grep. Non-DB manifest
      // fields (visit_type, chief_complaint, placeholders, warnings, summary) all live
      // in the manifest log entry below; the response above also preserves any
      // narrative prose the skill emitted before the manifest line.
      if (resultText && resultText.trim()) {
        log(`${tag}[soap][response]\n${resultText.trim()}`)
      }
      try { log(`${tag}[soap][manifest] ${JSON.stringify(manifest)}`) } catch {}

      if (manifest.schema_version !== 1) {
        log(`${tag}[soap] ERROR: unsupported manifest schema_version=${manifest.schema_version}; this app only knows v1`)
        try {
          dbEvents.finishEvent(eventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: `unsupported manifest schema_version=${manifest.schema_version}`, finishedAt: nowIso() })
          dbCases.setCaseStatus(caseId, 'failed')
          dbSessions.bumpSessionCounters(activeSessionId, { failed: true })
        } catch {}
        if (caseTag) updateRecordingStatus(caseTag, 'failed')
        return
      }

      if (manifest.status === 'failed' || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
        log(`${tag}[soap] manifest status=${manifest.status || '?'} cases=${(manifest.cases || []).length} — marking case failed`)
        try {
          dbEvents.finishEvent(eventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: `manifest status=${manifest.status || '?'}`, finishedAt: nowIso() })
          dbCases.setCaseStatus(caseId, 'failed')
          dbSessions.bumpSessionCounters(activeSessionId, { failed: true })
        } catch {}
        if (caseTag) updateRecordingStatus(caseTag, 'failed')
        return
      }

      // Manifest is usable — record SOAP event success now; per-case file work happens below.
      try {
        dbEvents.finishEvent(eventId, { status: 'success', ...extractUsage(resultEvent), finishedAt: nowIso() })
      } catch (e) { log(`[db] soap success finishEvent failed: ${e.message}`) }

      if (!manifest.multi_patient) {
        applySinglePatientManifest({ manifest, caseId, caseTag, expectedSoapPath: soapNoteMdPath })
      } else {
        applyMultiPatientManifest({ manifest, parentCaseId: caseId, caseTag, expectedSoapPath: soapNoteMdPath })
      }
    },
    onError(err) {
      try {
        dbEvents.finishEvent(eventId, { status: 'failed', errorMessage: err.message, finishedAt: nowIso() })
        dbCases.setCaseStatus(caseId, 'failed')
        dbSessions.bumpSessionCounters(activeSessionId, { failed: true })
      } catch (e) { log(`[db] soap onError update failed: ${e.message}`) }
      if (err.code === 'ENOENT') {
        win.webContents.send('setup-warning', 'Claude is not installed — note generation unavailable. Install the Claude CLI to enable SOAP notes.')
      }
    }
  })
}

// Single-patient manifest: verify the declared .md exists, update the existing case row,
// hand off to docx. Behaviour-equivalent to the pre-manifest single-patient flow.
function applySinglePatientManifest({ manifest, caseId, caseTag, expectedSoapPath }) {
  const tag = caseTag ? `[${caseTag}] ` : ''
  const c = manifest.cases[0] || {}

  if (c.status === 'failed' || !c.soap_note_md) {
    log(`${tag}[soap] single-patient case status=${c.status || '?'} or no soap_note_md — marking failed`)
    try {
      dbCases.setCaseStatus(caseId, 'failed')
      dbSessions.bumpSessionCounters(activeSessionId, { failed: true })
    } catch {}
    if (caseTag) updateRecordingStatus(caseTag, 'failed')
    return
  }

  const soapPath = c.soap_note_md
  if (!fs.existsSync(soapPath)) {
    log(`${tag}[soap] WARNING: manifest declared ${soapPath} but file is not on disk`)
    try {
      dbCases.setCaseStatus(caseId, 'failed')
      dbSessions.bumpSessionCounters(activeSessionId, { failed: true })
    } catch {}
    if (caseTag) updateRecordingStatus(caseTag, 'failed')
    return
  }

  if (soapPath !== expectedSoapPath) {
    log(`${tag}[soap] note: manifest path ${soapPath} differs from expected ${expectedSoapPath}; using manifest path`)
  }

  log(`${tag}[soap] SOAP note confirmed: ${soapPath}`)
  try {
    dbCases.updateCasePaths(caseId, { status: 'converting', soap_note_path: soapPath })
  } catch (e) { log(`[db] soap path update failed: ${e.message}`) }

  // Per-case post-processing chain: ICD → CDI → docx(soap) + docx(cdi).
  // Each step is best-effort; failures resolve cleanly and the chain continues.
  // The SOAP docx transition flips the row to 'completed' (primary deliverable);
  // the CDI docx populates cdi_docx_path so the Open CDI Review button can appear.
  const soapDoctor = dbDoctors?.getDoctor(activeDoctorId) || null
  const caseDir = path.dirname(soapPath)
  spawnIcdCoding({ soapNoteMdPath: soapPath, caseId, caseTag, doctorId: activeDoctorId })
    .then(() => spawnCdiReview({ caseDir, caseId, caseTag, doctor: soapDoctor }))
    .then(cdiResult => {
      if (caseTag) updateRecordingStatus(caseTag, 'converting')
      spawnDocxConversion(soapPath, caseTag, null, caseId)
      if (cdiResult && cdiResult.ok && cdiResult.mdPath) {
        spawnDocxConversion(cdiResult.mdPath, caseTag, null, caseId)
      }
    })
}

// Multi-patient manifest: for each ok/partial case the skill wrote into the recording
// folder, create a per-patient child folder next to it (matching the single-patient
// folder convention), copy the MP3 + transcript + transcript.docx in with single-patient
// naming, copy the .md in with the single-patient naming, hide the audit .md on Windows,
// insert a child cases row, and spawn docx on the copied .md. Finally mark the parent
// (recording) row as a completed audit row with soap_note_path=NULL.
async function applyMultiPatientManifest({ manifest, parentCaseId, caseTag, expectedSoapPath }) {
  const tag = caseTag ? `[${caseTag}] ` : ''
  log(`${tag}[soap] Multi-patient manifest: ${manifest.cases.length} cases declared`)

  const recordingFolder = path.dirname(expectedSoapPath)
  if (manifest.recording_folder && manifest.recording_folder !== recordingFolder) {
    log(`${tag}[soap] note: manifest recording_folder=${manifest.recording_folder} differs from expected=${recordingFolder}`)
  }

  const sessionDir = path.dirname(recordingFolder)

  // Pull the parent's recorded_at + doctor_id from DB so children inherit them
  // (same audio source ⇒ same recording timestamp; same doctor as the session).
  let parentRecordedAt = nowIso()
  let parentDoctorId = activeDoctorId
  let parentMp3Path = null
  try {
    const row = dbCases.getCaseRow(parentCaseId)
    if (row) {
      parentRecordedAt = row.recorded_at || parentRecordedAt
      parentDoctorId   = row.doctor_id   || parentDoctorId
      parentMp3Path    = row.mp3_path    || null
    }
  } catch (e) { log(`[db] getCaseRow(parent) failed: ${e.message}`) }

  // Fall back to a filesystem probe if the DB didn't carry the mp3 path.
  if (!parentMp3Path) {
    try {
      const found = fs.readdirSync(recordingFolder).find(f => f.toLowerCase().endsWith('.mp3'))
      if (found) parentMp3Path = path.join(recordingFolder, found)
    } catch {}
  }

  // Look up the doctor record once — all children in this run share the same
  // doctor (same recording, same session). Used by spawnCdiReview to build the
  // skill prompt's Specialty + Doctor fields.
  let childDoctor = null
  try { childDoctor = parentDoctorId ? (dbDoctors.getDoctor(parentDoctorId) || null) : null } catch {}

  const parentTranscript     = path.join(recordingFolder, 'transcript.md')
  const parentTranscriptDocx = path.join(recordingFolder, 'transcript.docx')
  const datestamp = new Date().toISOString().slice(0, 10)

  // --- Pass 1: plan all children up-front so the status popup can show every
  // patient immediately, before the (sequential) per-child ICD coding starts.
  // Skips failed-by-manifest and missing-on-disk cases. Slug + folder collision
  // handling happens here so each planned child has a stable target identity.
  const slugsUsed = new Set()
  const planned   = []

  for (let i = 0; i < manifest.cases.length; i++) {
    const c = manifest.cases[i]
    const labelName = c.patient_name || `unknown_${i + 1}`

    if (c.status === 'failed' || !c.soap_note_md) {
      log(`${tag}[soap] case ${i + 1} (${labelName}) status=${c.status || '?'} — skipping post-process; .md stays in recording folder for debugging`)
      continue
    }
    if (!fs.existsSync(c.soap_note_md)) {
      log(`${tag}[soap] case ${i + 1} (${labelName}) declared ${c.soap_note_md} but file is not on disk — skipping`)
      continue
    }

    // Slug + collision handling against earlier patients in this same run.
    let baseSlug = sanitizeName(c.patient_name) || `unknown_${i + 1}`
    let slug = baseSlug
    let n = 2
    while (slugsUsed.has(slug)) {
      slug = `${baseSlug}_${n}`
      n++
    }
    slugsUsed.add(slug)

    // Target folder: <sessionDir>/<slug>_<YYYY-MM-DD>/ with suffix on filesystem collision.
    let folderName = `${slug}_${datestamp}`
    let targetDir  = path.join(sessionDir, folderName)
    let suffix = 2
    while (fs.existsSync(targetDir)) {
      folderName = `${slug}_${datestamp}_${suffix}`
      targetDir  = path.join(sessionDir, folderName)
      suffix++
    }

    planned.push({ i, c, slug, folderName, targetDir })
  }

  // Publish the full patient list to the status UI BEFORE any per-child await
  // so every patient appears immediately when SOAP closes. Each entry starts
  // as 'queued'; spawnIcdCoding will flip the current child to 'coding_icd'
  // when its turn comes, then spawnDocxConversion flips to 'converting' →
  // 'completed' (or 'failed').
  const patientsUi = planned.map(p => ({
    name: p.c.patient_name || p.slug.replace(/_/g, ' '),
    folderName: p.folderName,
    status: 'queued'
  }))
  if (caseTag) setRecordingPatients(caseTag, patientsUi)

  // --- Pass 2: per child, do the on-disk work and run the post-processing
  // chain (ICD → docx). ICD runs sequentially across children so the MCP
  // connector + Anthropic quota aren't hit in parallel; docx is fire-and-forget.
  let childrenCreated = 0

  for (const p of planned) {
    const { i, c, slug, folderName, targetDir } = p
    const labelName = c.patient_name || `unknown_${i + 1}`

    try {
      fs.mkdirSync(targetDir, { recursive: true })
    } catch (e) {
      log(`${tag}[soap] case ${i + 1} (${labelName}): mkdir ${targetDir} failed: ${e.message}`)
      updatePatientStatus(caseTag, folderName, 'failed')
      continue
    }

    // MP3: copy parent's into the child folder, renamed <slug>.mp3 to match single-patient layout.
    let childMp3 = null
    if (parentMp3Path && fs.existsSync(parentMp3Path)) {
      childMp3 = path.join(targetDir, `${slug}.mp3`)
      try {
        fs.copyFileSync(parentMp3Path, childMp3)
      } catch (e) {
        log(`${tag}[soap] case ${i + 1}: mp3 copy failed: ${e.message}`)
        childMp3 = null
      }
    }

    // transcript.md and transcript.docx: same filenames in child folder.
    const childTranscript = path.join(targetDir, 'transcript.md')
    try {
      if (fs.existsSync(parentTranscript)) fs.copyFileSync(parentTranscript, childTranscript)
    } catch (e) { log(`${tag}[soap] case ${i + 1}: transcript.md copy failed: ${e.message}`) }

    const childTranscriptDocx = path.join(targetDir, 'transcript.docx')
    let transcriptDocxOk = false
    try {
      if (fs.existsSync(parentTranscriptDocx)) {
        fs.copyFileSync(parentTranscriptDocx, childTranscriptDocx)
        transcriptDocxOk = true
      }
    } catch (e) { log(`${tag}[soap] case ${i + 1}: transcript.docx copy failed: ${e.message}`) }

    // SOAP .md: copy the audit file from the recording folder into the child folder, renamed
    // to <folderName>_soap_note.md to match the single-patient on-disk convention.
    const childSoapMd = path.join(targetDir, `${folderName}_soap_note.md`)
    try {
      fs.copyFileSync(c.soap_note_md, childSoapMd)
    } catch (e) {
      log(`${tag}[soap] case ${i + 1}: SOAP .md copy failed: ${e.message}`)
      updatePatientStatus(caseTag, folderName, 'failed')
      continue
    }

    // Hide the audit .md in the recording folder (Windows). The copy in the child folder
    // will get hidden by spawnDocxConversion's success path after conversion runs.
    hideFileFromUser(c.soap_note_md)

    // Insert child DB row with status='converting' — docx success path flips to 'completed'
    // + soap_docx_path + completed_at, mirroring the single-patient progression.
    let childCaseId = null
    try {
      childCaseId = dbCases.createChildCase({
        patientName:        slug,
        doctorId:           parentDoctorId,
        sessionId:          activeSessionId,
        caseDir:            targetDir,
        source:             'recording',
        mp3Path:            childMp3,
        transcriptPath:     fs.existsSync(childTranscript) ? childTranscript : null,
        transcriptDocxPath: transcriptDocxOk ? childTranscriptDocx : null,
        soapNotePath:       childSoapMd,
        recordedAt:         parentRecordedAt
      })
    } catch (e) { log(`[db] createChildCase failed: ${e.message}`) }

    // Per-child post-processing chain: ICD → CDI → docx(soap) + docx(cdi).
    // Sequential across children so the MCP connector + Anthropic quota aren't
    // hit in parallel and the per-case log block stays readable. ICD modifies
    // childSoapMd in place — must complete before docx so the .docx contains
    // the appended codes. CDI runs after ICD so it sees codes in the note
    // (drives the ICD-aware validation behavior in cdi-review/SKILL.md §A).
    // spawnIcdCoding flips this patient's status from 'queued' to 'coding_icd';
    // spawnCdiReview flips to 'running_cdi' (no-op if CDI is globally off).
    await spawnIcdCoding({ soapNoteMdPath: childSoapMd, caseId: childCaseId, caseTag, patientFolderName: folderName, doctorId: parentDoctorId })
    const cdiResult = await spawnCdiReview({ caseDir: targetDir, caseId: childCaseId, caseTag, patientFolderName: folderName, doctor: childDoctor })
    if (caseTag) updatePatientStatus(caseTag, folderName, 'converting')
    spawnDocxConversion(childSoapMd, caseTag, folderName, childCaseId)
    if (cdiResult && cdiResult.ok && cdiResult.mdPath) {
      spawnDocxConversion(cdiResult.mdPath, caseTag, folderName, childCaseId)
    }
    childrenCreated++
  }

  if (childrenCreated === 0) {
    log(`${tag}[soap] WARNING: no child cases created from manifest — marking parent failed`)
    try {
      dbCases.setCaseStatus(parentCaseId, 'failed')
      dbSessions.bumpSessionCounters(activeSessionId, { failed: true })
    } catch {}
    if (caseTag) updateRecordingStatus(caseTag, 'failed')
    return
  }

  // Parent is now an audit row: soap_note_path stays NULL by design.
  try {
    dbCases.updateCasePaths(parentCaseId, { status: 'completed', completed_at: nowIso() })
  } catch (e) { log(`[db] parent multi-patient status update failed: ${e.message}`) }
}

// ---------------------------------------------------------------------------
// ICD-10 coding — runs after the SOAP .md is in its final on-disk location
// (single-patient: parent case folder; multi-patient: each child folder), and
// BEFORE the .docx conversion. Appends an "## ICD-10-CM Codes" table to the
// SOAP .md in-place via the add-icd-codes skill (which uses the claude.ai
// ICD-10 MCP connector). Best-effort: any failure logs + emits a
// service-warning IPC + records a processing_events row, but the pipeline
// always continues to spawnDocxConversion — a note without codes is still
// useful.
//
// Calls go through the shared spawnClaude wrapper so token usage, cost,
// and duration are captured for free.
//
// Returns a Promise that resolves once the ICD step completes (success OR
// failure). The caller is expected to `await` this promise before kicking
// off the per-case spawnDocxConversion, so the docx sees the appended codes.
// The promise never rejects — failures resolve cleanly so callers stay
// linear.
// ---------------------------------------------------------------------------
function spawnIcdCoding({ soapNoteMdPath, caseId = null, caseTag = null, patientFolderName = null, doctorId = null }) {
  return new Promise(resolve => {
    const tag = caseTag ? `[${caseTag}] ` : ''
    if (patientFolderName) {
      updatePatientStatus(caseTag, patientFolderName, 'coding_icd')
    } else if (caseTag) {
      updateRecordingStatus(caseTag, 'coding_icd')
    }

    if (!soapNoteMdPath || !fs.existsSync(soapNoteMdPath)) {
      log(`${tag}[icd] SKIPPED: soap note not found at ${soapNoteMdPath}`)
      try {
        const evId = dbEvents.startEvent({ caseId, jobKind: 'icd', relatedDoctorId: doctorId, startedAt: nowIso() })
        if (evId != null) dbEvents.finishEvent(evId, { status: 'failed', errorMessage: 'soap note missing before icd', finishedAt: nowIso() })
      } catch (e) { log(`${tag}[db] icd missing-soap event failed: ${e.message}`) }
      resolve()
      return
    }

    const relSoap = path.relative(NOTES_DIR, soapNoteMdPath).replace(/\\/g, '/')
    const prompt = `add ICD codes. Soap note: "${relSoap}".`
    const soapModel = readSettings().soapModel
    log(`${tag}[icd] Spawning: claude -p "${prompt}"${soapModel ? ` --model ${soapModel}` : ''}`)

    const startedAt = nowIso()
    const wallStart = Date.now()
    let eventId = null
    try {
      eventId = dbEvents.startEvent({ caseId, jobKind: 'icd', relatedDoctorId: doctorId, modelUsed: soapModel, startedAt })
    } catch (e) { log(`${tag}[db] startEvent(icd) failed: ${e.message}`) }

    spawnClaude({
      prompt,
      model: soapModel,
      tag,
      label: 'icd',
      onClose(code, errText, resultText, resultEvent) {
        const durationMs = Date.now() - wallStart
        const combined = (resultText || '') + '\n' + (errText || '')
        const isMcpError    = /Needs authentication|unauthorized|\b401\b|MCP.*(connect|connection).*(fail|error|refused)/i.test(combined)
        const isRateLimited = /rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i.test(combined)
        const isSkipped     = /ICD_SKIPPED/i.test(combined)

        // Map exit + signals to a processing_events status. Skipped (no diagnoses
        // found) is still recorded as 'success' — the skill ran to completion and
        // exited 0 by design.
        let eventStatus
        if (isMcpError)        eventStatus = 'failed'
        else if (isRateLimited) eventStatus = 'rate_limited'
        else if (code === 0)    eventStatus = 'success'
        else                    eventStatus = 'failed'

        if (eventId != null) {
          try {
            dbEvents.finishEvent(eventId, {
              status: eventStatus,
              ...extractUsage(resultEvent),
              durationMs,
              errorMessage: code === 0 ? null : (errText || '').slice(0, 1024),
              finishedAt: nowIso()
            })
          } catch (e) { log(`${tag}[db] finishEvent(icd) failed: ${e.message}`) }
        }

        if (isMcpError && win && !win.isDestroyed()) {
          win.webContents.send('service-warning', {
            title: 'ICD-10 connector unavailable',
            message: 'Could not look up ICD-10 codes — the note was generated without codes. Check that you are logged in to Claude (`claude login`) and that the ICD-10 connector is enabled.'
          })
        } else if (isRateLimited && win && !win.isDestroyed()) {
          win.webContents.send('service-warning', {
            title: 'Claude usage limit reached',
            message: 'ICD codes could not be added — try again once the limit resets. The note has been saved without codes.'
          })
        }

        if (isSkipped) log(`${tag}[icd] No diagnoses found in note — proceeding without codes`)
        resolve()
      },
      onError(err) {
        log(`${tag}[icd ERR] failed to spawn claude: ${err.message}`)
        if (eventId != null) {
          try { dbEvents.finishEvent(eventId, { status: 'failed', durationMs: Date.now() - wallStart, errorMessage: err.message, finishedAt: nowIso() }) } catch {}
        }
        resolve()
      }
    })
  })
}

// ---------------------------------------------------------------------------
// CDI review — runs after ICD-10 coding has appended codes to the SOAP .md
// (or skipped/failed), and BEFORE the .docx conversion. Invokes the
// cdi-review skill which produces <case_stem>_cdi.json + <case_stem>_cdi.md
// in the same case folder. Best-effort: any failure logs + emits a
// service-warning IPC + records a processing_events row, but the pipeline
// always continues to spawnDocxConversion — a SOAP note without a CDI review
// is still useful.
//
// Returns a Promise that resolves with { ok, jsonPath, mdPath } once the
// skill exits. On failure or skip, jsonPath/mdPath are populated only if
// the skill wrote a stub file (which it always tries to). The promise never
// rejects — the caller stays linear.
//
// Gating: three gates BEFORE we spawn Claude (saves tokens + latency):
//   1. Global `enableCdi` setting must be on.
//   2. `doctor.specialty` must be non-empty.
//   3. The standards file `<NOTES_DIR>/.claude/standards/specialties/
//      <specialty>.md` must exist.
// All three are simple JS checks — no need to round-trip through Claude
// to discover the same outcome. The skill's own Step 0b stays as a
// defensive backstop for direct `claude -p` invocations (testing, etc.).
// ---------------------------------------------------------------------------

// Helper: write the same stub _cdi.json + _cdi.md the skill's Step 0b would,
// so downstream code (DB cdi_* columns, status popup) sees a consistent shape
// whether the gate fired in main.js or in the skill.
function writeCdiStub({ caseDir, doctor, mode, reason }) {
  // Resolve the case stem the way the skill does — anchor on the existing
  // *_soap_note.md if present, otherwise fall back to the folder name.
  let fileStem = path.basename(caseDir)
  try {
    const soapMd = fs.readdirSync(caseDir).find(f => f.endsWith('_soap_note.md'))
    if (soapMd) fileStem = soapMd.replace(/_soap_note\.md$/, '')
  } catch {}
  const jsonPath = path.join(caseDir, `${fileStem}_cdi.json`)
  const mdPath   = path.join(caseDir, `${fileStem}_cdi.md`)

  const stub = {
    meta: {
      case_dir: caseDir,
      patient: fileStem,
      doctor: doctor?.name || '',
      specialty: doctor?.specialty || '',
      mode: mode || '',
      generated_at: new Date().toISOString(),
      standards_versions: { icd10_cm: null, ahima_acdis: null, specialty_pack: null }
    },
    summary: {
      overall_quality_score: null,
      specificity_subscore: null,
      evidence_subscore: null,
      completeness_subscore: null,
      flag_counts: { critical: 0, warning: 0, suggestion: 0, opportunity: 0 },
      medical_necessity_status: null,
      claim_defense_readiness: null,
      clinician_approval_required: false
    },
    flags: [],
    error: reason
  }
  try { fs.writeFileSync(jsonPath, JSON.stringify(stub, null, 2)) } catch (e) {
    log(`[cdi] WARNING: failed to write stub JSON: ${e.message}`)
    return { jsonPath: null, mdPath: null }
  }
  const md = [
    `# CDI Review — ${fileStem}`,
    '',
    'CDI review was not performed for this case.',
    '',
    `**Reason:** ${reason}`,
    ''
  ].join('\n')
  try { fs.writeFileSync(mdPath, md) } catch (e) {
    log(`[cdi] WARNING: failed to write stub MD: ${e.message}`)
    return { jsonPath, mdPath: null }
  }
  return { jsonPath, mdPath }
}

function spawnCdiReview({ caseDir, caseId, caseTag, patientFolderName, doctor }) {
  return new Promise(resolve => {
    const tag = caseTag ? `[${caseTag}] ` : ''
    const settings = readSettings()

    // Gate 1 — global enableCdi off. No spawn, no DB writes, no UI. CDI
    // simply doesn't exist for this run.
    if (!settings.enableCdi) {
      resolve({ ok: false, jsonPath: null, mdPath: null, skipped: 'disabled' })
      return
    }

    if (!caseDir || !fs.existsSync(caseDir)) {
      log(`${tag}[cdi] SKIPPED: case dir not found at ${caseDir}`)
      try {
        const evId = dbEvents.startEvent({ caseId, jobKind: 'cdi', relatedDoctorId: doctor?.id || null, startedAt: nowIso() })
        if (evId != null) dbEvents.finishEvent(evId, { status: 'failed', errorMessage: 'case_dir missing before cdi', finishedAt: nowIso() })
      } catch (e) { log(`${tag}[db] cdi missing-case-dir event failed: ${e.message}`) }
      resolve({ ok: false, jsonPath: null, mdPath: null })
      return
    }

    const mode = settings.cdiMode || 'balanced'
    const specialty = (doctor?.specialty || '').toLowerCase()
    const doctorName = doctor?.name || ''
    const standardsAbs = path.join(NOTES_DIR, '.claude', 'standards')

    // Gate 2 — no specialty set on the doctor. Skip the spawn; write the same
    // stub the skill's Step 0b would have, mark cdi_status='skipped'.
    if (!specialty) {
      const reason = `specialty not set for ${doctorName || 'this doctor'}`
      log(`${tag}[cdi] SKIPPED: ${reason}`)
      const { jsonPath, mdPath } = writeCdiStub({ caseDir, doctor, mode, reason: 'specialty not yet supported for CDI v1: (none)' })
      try { dbCases.updateCaseCdi(caseId, { cdi_status: 'skipped', cdi_mode: mode, cdi_json_path: jsonPath, cdi_md_path: mdPath }) } catch (e) {
        log(`${tag}[db] updateCaseCdi(skipped:no-specialty) failed: ${e.message}`)
      }
      const cdiUi = { cdiStatus: 'skipped', cdiSkipReason: reason }
      if (patientFolderName) setPatientCdi(caseTag, patientFolderName, cdiUi)
      else if (caseTag)      setRecordingCdi(caseTag, cdiUi)
      if (jsonPath) hideFileFromUser(jsonPath)
      resolve({ ok: false, jsonPath, mdPath, status: 'skipped', skipped: 'no_specialty' })
      return
    }

    // Gate 3 — specialty is set but the standards file doesn't exist (e.g.,
    // user picked 'cardiology' but only orthopedics.md ships in v1). Same
    // shape as gate 2.
    const specialtyFile = path.join(standardsAbs, 'specialties', `${specialty}.md`)
    if (!fs.existsSync(specialtyFile)) {
      const reason = `unsupported specialty '${specialty}' — no standards file at specialties/${specialty}.md`
      log(`${tag}[cdi] SKIPPED: ${reason}`)
      const { jsonPath, mdPath } = writeCdiStub({ caseDir, doctor, mode, reason: `specialty not yet supported for CDI v1: ${specialty}` })
      try { dbCases.updateCaseCdi(caseId, { cdi_status: 'skipped', cdi_mode: mode, cdi_json_path: jsonPath, cdi_md_path: mdPath }) } catch (e) {
        log(`${tag}[db] updateCaseCdi(skipped:unsupported-specialty) failed: ${e.message}`)
      }
      const cdiUi = { cdiStatus: 'skipped', cdiSkipReason: `unsupported specialty '${specialty}'` }
      if (patientFolderName) setPatientCdi(caseTag, patientFolderName, cdiUi)
      else if (caseTag)      setRecordingCdi(caseTag, cdiUi)
      if (jsonPath) hideFileFromUser(jsonPath)
      resolve({ ok: false, jsonPath, mdPath, status: 'skipped', skipped: 'unsupported_specialty' })
      return
    }

    // Prompt signature matches notes-claude/skills/cdi-review/SKILL.md Step 0a.
    // The skill parses by ordered markers (`Case:` `Specialty:` `Mode:`
    // `Doctor:` `Standards:`) — keep the field order stable.
    const prompt = [
      'review cdi.',
      `Case: ${caseDir}.`,
      `Specialty: ${specialty}.`,
      `Mode: ${mode}.`,
      `Doctor: ${doctorName}.`,
      `Standards: ${standardsAbs}`
    ].join(' ')

    const soapModel = settings.soapModel
    log(`${tag}[cdi] Spawning: claude -p "${prompt}"${soapModel ? ` --model ${soapModel}` : ''} (effort=high)`)

    // Surface the running stage in the popup. Mirror spawnIcdCoding's pattern.
    if (patientFolderName) {
      updatePatientStatus(caseTag, patientFolderName, 'running_cdi')
    } else if (caseTag) {
      updateRecordingStatus(caseTag, 'running_cdi')
    }

    // Mark the case row as running CDI; record the mode + transition to 'running'.
    try { dbCases.updateCaseCdi(caseId, { cdi_status: 'running', cdi_mode: mode }) } catch (e) {
      log(`${tag}[db] updateCaseCdi(running) failed: ${e.message}`)
    }

    const startedAt = nowIso()
    const wallStart = Date.now()
    let eventId = null
    try {
      eventId = dbEvents.startEvent({ caseId, jobKind: 'cdi', relatedDoctorId: doctor?.id || null, modelUsed: soapModel, effort: 'high', startedAt })
    } catch (e) { log(`${tag}[db] startEvent(cdi) failed: ${e.message}`) }

    spawnClaude({
      prompt,
      model: soapModel,
      effort: 'high',
      tag,
      label: 'cdi',
      onClose(code, errText, resultText, resultEvent) {
        const durationMs = Date.now() - wallStart
        const combined = (resultText || '') + '\n' + (errText || '')
        const isRateLimited = /rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i.test(combined)

        // Parse the terminal contract line from the skill (Step 9):
        //   CDI_OK: <abs path> · <N> flags · quality <X>/100 [· ICD validated]
        //   CDI_SKIPPED: unsupported specialty '<specialty>'
        //   CDI_FAIL: <reason>
        const okMatch      = /CDI_OK:\s*(\S+)\s*·\s*(\d+)\s*flags\s*·\s*quality\s*(\d+)\/100(.*)/i.exec(resultText)
        const skippedMatch = /CDI_SKIPPED:\s*(.*)$/im.exec(resultText)
        const failMatch    = /CDI_FAIL:\s*(.*)$/im.exec(resultText)

        let outcome
        if (okMatch)             outcome = 'ok'
        else if (skippedMatch)   outcome = 'skipped'
        else if (failMatch)      outcome = 'failed'
        else if (code === 0)     outcome = 'failed_silent'  // exit 0 but no terminal line
        else                     outcome = 'failed'

        let cdiStatusDb     = 'failed'
        let eventStatus     = 'failed'
        let jsonPathResult  = null
        let mdPathResult    = null

        if (outcome === 'ok') {
          cdiStatusDb = 'completed'
          eventStatus = isRateLimited ? 'rate_limited' : 'success'
          jsonPathResult = okMatch[1]
          // .md sits next to .json with the same stem.
          if (jsonPathResult && jsonPathResult.endsWith('_cdi.json')) {
            mdPathResult = jsonPathResult.replace(/_cdi\.json$/, '_cdi.md')
          }

          // Parse the JSON, persist summary fields + flags.
          try {
            if (jsonPathResult && fs.existsSync(jsonPathResult)) {
              const cdi = JSON.parse(fs.readFileSync(jsonPathResult, 'utf8'))
              const summary = cdi.summary || {}
              const flagCount = Array.isArray(cdi.flags) ? cdi.flags.length : 0
              const qScore = (summary.overall_quality_score != null) ? Number(summary.overall_quality_score) : null
              const approval = !!summary.clinician_approval_required

              try {
                dbCases.updateCaseCdi(caseId, {
                  cdi_status:                       'completed',
                  cdi_json_path:                    jsonPathResult,
                  cdi_md_path:                      mdPathResult,
                  cdi_quality_score:                qScore,
                  cdi_medical_necessity:            summary.medical_necessity_status || null,
                  cdi_claim_defense_readiness:      summary.claim_defense_readiness || null,
                  cdi_clinician_approval_required:  approval ? 1 : 0
                })
              } catch (e) { log(`${tag}[db] updateCaseCdi(ok) failed: ${e.message}`) }

              if (Array.isArray(cdi.flags) && cdi.flags.length > 0) {
                try { dbCdiFlags.insertFlags(caseId, eventId, cdi.flags) } catch (e) {
                  log(`${tag}[db] insertFlags failed: ${e.message}`)
                }
              }

              // Surface to the popup so the Open CDI Review button can appear
              // (once the cdi docx is generated) and the badge can show.
              const cdiUi = {
                cdiStatus:                       'completed',
                cdiFlagCount:                    flagCount,
                cdiQualityScore:                 qScore,
                cdiClinicianApprovalRequired:    approval
              }
              if (patientFolderName) setPatientCdi(caseTag, patientFolderName, cdiUi)
              else if (caseTag)      setRecordingCdi(caseTag, cdiUi)

              // Hide the _cdi.json on Windows — the user opens the .docx.
              hideFileFromUser(jsonPathResult)

              log(`${tag}[cdi] CDI_OK: ${flagCount} flags, quality ${qScore}/100${approval ? ' (approval required)' : ''}`)
            } else {
              log(`${tag}[cdi] WARNING: CDI_OK terminal line but JSON not on disk: ${jsonPathResult}`)
            }
          } catch (e) {
            log(`${tag}[cdi] WARNING: failed to read/parse cdi JSON: ${e.message}`)
            // Still record success at the event level — the file just had a parse issue.
          }
        } else if (outcome === 'skipped') {
          cdiStatusDb = 'skipped'
          eventStatus = 'success'
          const reason = (skippedMatch[1] || '').trim()
          log(`${tag}[cdi] CDI_SKIPPED: ${reason}`)
          try { dbCases.updateCaseCdi(caseId, { cdi_status: 'skipped' }) } catch (e) {
            log(`${tag}[db] updateCaseCdi(skipped) failed: ${e.message}`)
          }
          const cdiUi = { cdiStatus: 'skipped', cdiSkipReason: reason }
          if (patientFolderName) setPatientCdi(caseTag, patientFolderName, cdiUi)
          else if (caseTag)      setRecordingCdi(caseTag, cdiUi)
        } else {
          // failed or failed_silent
          eventStatus = isRateLimited ? 'rate_limited' : 'failed'
          const reason = failMatch ? (failMatch[1] || '').trim() : (outcome === 'failed_silent' ? 'no terminal line' : 'exit non-zero')
          log(`${tag}[cdi] CDI_FAIL: ${reason}`)
          try { dbCases.updateCaseCdi(caseId, { cdi_status: 'failed' }) } catch (e) {
            log(`${tag}[db] updateCaseCdi(failed) failed: ${e.message}`)
          }
          const cdiUi = { cdiStatus: 'failed' }
          if (patientFolderName) setPatientCdi(caseTag, patientFolderName, cdiUi)
          else if (caseTag)      setRecordingCdi(caseTag, cdiUi)

          if (isRateLimited && win && !win.isDestroyed()) {
            win.webContents.send('service-warning', {
              title: 'Claude usage limit reached',
              message: 'CDI review could not be completed — try again once the limit resets. The SOAP note has been saved.'
            })
          } else if (win && !win.isDestroyed()) {
            win.webContents.send('service-warning', {
              title: 'CDI review failed',
              message: 'The CDI review skill exited with an error. The SOAP note is unaffected — check app.log for details.'
            })
          }
        }

        if (eventId != null) {
          try {
            dbEvents.finishEvent(eventId, {
              status: eventStatus,
              ...extractUsage(resultEvent),
              durationMs,
              errorMessage: eventStatus === 'success' ? null : (errText || '').slice(0, 1024) || null,
              finishedAt: nowIso()
            })
          } catch (e) { log(`${tag}[db] finishEvent(cdi) failed: ${e.message}`) }
        }

        resolve({ ok: outcome === 'ok', jsonPath: jsonPathResult, mdPath: mdPathResult, status: cdiStatusDb })
      },
      onError(err) {
        log(`${tag}[cdi ERR] failed to spawn claude: ${err.message}`)
        if (eventId != null) {
          try { dbEvents.finishEvent(eventId, { status: 'failed', durationMs: Date.now() - wallStart, errorMessage: err.message, finishedAt: nowIso() }) } catch {}
        }
        try { dbCases.updateCaseCdi(caseId, { cdi_status: 'failed' }) } catch {}
        resolve({ ok: false, jsonPath: null, mdPath: null, status: 'failed' })
      }
    })
  })
}

function spawnDocxConversion(mdPath, caseTag, patientFolderName = null, caseId = null) {
  const tag = caseTag ? `[${caseTag}] ` : ''
  log(`${tag}[docx] Converting: ${mdPath}`)
  // Classify the .md so the success path knows which case column to populate:
  //   'soap'       — updates soap_docx_path AND transitions the row to
  //                  'completed' (primary deliverable).
  //   'cdi'        — updates cdi_docx_path; never touches case status.
  //   'transcript' — updates transcript_docx_path; never touches case status.
  //
  // Source of truth: the case row's *_path columns. By the time this function
  // runs, the relevant column is always populated (transcript_path during
  // spawnTranscription's onSuccess; soap_note_path in apply*Manifest before
  // the docx call; cdi_md_path in spawnCdiReview's CDI_OK branch before docx
  // fires on the cdi .md). Falls back to filename-suffix matching when the
  // case row isn't available (e.g., DB unavailable or caseId not passed).
  const base = path.basename(mdPath)
  let docxKind = null
  if (caseId && dbCases) {
    try {
      const row = dbCases.getCaseRow(caseId)
      if (row) {
        if (mdPath === row.cdi_md_path)            docxKind = 'cdi'
        else if (mdPath === row.transcript_path)   docxKind = 'transcript'
        else if (mdPath === row.soap_note_path)    docxKind = 'soap'
      }
    } catch (e) { log(`${tag}[docx] getCaseRow lookup failed: ${e.message}`) }
  }
  if (!docxKind) {
    // Filename fallback — same heuristic as before. Only used when the DB row
    // wasn't decisive (no caseId, no row, or mdPath didn't match any column —
    // e.g., the row was inserted with a different absolute-path normalisation).
    const fallback = base === 'transcript.md'
      ? 'transcript'
      : base.endsWith('_cdi.md')
        ? 'cdi'
        : 'soap'
    if (caseId) log(`${tag}[docx] WARNING: case row didn't disambiguate ${mdPath}; falling back to filename heuristic → ${fallback}`)
    docxKind = fallback
  }
  const wallStart = Date.now()

  let eventId = null
  try {
    eventId = dbEvents.startEvent({ caseId, jobKind: 'docx', startedAt: nowIso() })
  } catch (e) { log(`[db] startEvent(docx) failed: ${e.message}`) }

  const proc = spawn(PYTHON, [
    path.join(__dirname, 'python', 'md_to_docx.py'),
    mdPath
  ], { cwd: __dirname, stdio: 'pipe' })

  proc.stdout.on('data', d => log(`${tag}[docx] Saved: ${d.toString().trim()}`))
  proc.stderr.on('data', d => log(`${tag}[docx ERR] ${d.toString().trim()}`))
  proc.on('close', code => {
    log(`${tag}[docx] exited ${code}`)
    const durationMs = Date.now() - wallStart
    const docxPath = mdPath.replace(/\.md$/, '.docx')
    if (code === 0) hideFileFromUser(mdPath)

    if (docxKind === 'soap') {
      if (code === 0) {
        try {
          dbEvents.finishEvent(eventId, { status: 'success', durationMs, finishedAt: nowIso() })
          dbCases.updateCasePaths(caseId, { status: 'completed', soap_docx_path: docxPath, completed_at: nowIso() })
          dbSessions.bumpSessionCounters(activeSessionId, { failed: false })
        } catch (e) { log(`[db] docx soap success update failed: ${e.message}`) }
        if (patientFolderName) {
          const entry = sessionRecordings.find(r => r.caseTag === caseTag)
          const patient = entry?.patients?.find(p => p.folderName === patientFolderName)
          if (patient) patient.soapDocxPath = docxPath
          notifyUser('SOAP note ready', patient?.name || patientFolderName.replace(/_/g, ' '))
          updatePatientStatus(caseTag, patientFolderName, 'completed')
        } else if (caseTag) {
          const entry = sessionRecordings.find(r => r.caseTag === caseTag)
          if (entry) entry.soapDocxPath = docxPath
          notifyUser('SOAP note ready', entry?.displayName || caseTag)
          updateRecordingStatus(caseTag, 'completed')
        }
      } else {
        try {
          dbEvents.finishEvent(eventId, { status: 'failed', durationMs, finishedAt: nowIso() })
          dbCases.setCaseStatus(caseId, 'failed')
          dbSessions.bumpSessionCounters(activeSessionId, { failed: true })
        } catch (e) { log(`[db] docx soap failure update failed: ${e.message}`) }
        if (patientFolderName) {
          updatePatientStatus(caseTag, patientFolderName, 'failed')
        } else if (caseTag) {
          updateRecordingStatus(caseTag, 'failed')
        }
      }
    } else if (docxKind === 'cdi') {
      // CDI docx — populate cdi_docx_path, surface Open CDI Review button in
      // status popup, but do NOT change case status (the soap docx owns that).
      try {
        dbEvents.finishEvent(eventId, { status: code === 0 ? 'success' : 'failed', durationMs, finishedAt: nowIso() })
        if (code === 0) dbCases.updateCaseCdi(caseId, { cdi_docx_path: docxPath })
      } catch (e) { log(`[db] docx cdi update failed: ${e.message}`) }
      if (code === 0) {
        if (patientFolderName) {
          setPatientCdi(caseTag, patientFolderName, { cdiDocxPath: docxPath })
        } else if (caseTag) {
          setRecordingCdi(caseTag, { cdiDocxPath: docxPath })
        }
      }
    } else {
      // transcript docx — just record the path, don't change case status
      try {
        dbEvents.finishEvent(eventId, { status: code === 0 ? 'success' : 'failed', durationMs, finishedAt: nowIso() })
        if (code === 0) dbCases.updateCasePaths(caseId, { transcript_docx_path: docxPath })
      } catch (e) { log(`[db] docx transcript update failed: ${e.message}`) }
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
let templateJobEventId = null

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

  log(`[template] Spawning: claude -p "${prompt}" --model ${model} (effort=${effort})`)
  templateJobStartMs = Date.now()

  const templateCreateStartedAt = nowIso()
  templateJobEventId = null
  try {
    templateJobEventId = dbEvents.startEvent({ jobKind: 'template_create', modelUsed: model, effort, startedAt: templateCreateStartedAt })
  } catch (e) { log(`[db] startEvent(template_create) failed: ${e.message}`) }

  templateJobProc = spawnClaude({
    prompt,
    model,
    effort,
    tag: '',
    label: 'template',
    onClose(code, errText, resultText, resultEvent) {
      templateJobProc = null
      const durationMs = Date.now() - templateJobStartMs

      if (/rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i.test(resultText + errText)) {
        if (templateJobEventId != null) {
          try { dbEvents.finishEvent(templateJobEventId, { status: 'rate_limited', ...extractUsage(resultEvent), errorMessage: 'Claude usage limit reached', finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_create) failed: ${e.message}`) }
          templateJobEventId = null
        }
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
        // Register the doctor in DB (and keep settings.json in sync for backward compat)
        let doctorId = null
        try {
          const existing = dbDoctors.getDoctorByLastname(lastname)
          doctorId = existing ? existing.id : String(Date.now())
          dbDoctors.upsertDoctor({ id: doctorId, name: doctorName.trim(), lastname, templatePath: expectedPath })
          log(`[template] Doctor registered in DB: ${doctorName} (${expectedPath})`)
        } catch (e) {
          log(`[template] WARNING: failed to register doctor in DB: ${e.message}`)
        }

        if (templateJobEventId != null) {
          try { dbEvents.finishEvent(templateJobEventId, { status: 'success', ...extractUsage(resultEvent), relatedDoctorId: doctorId, finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_create) failed: ${e.message}`) }
          templateJobEventId = null
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
        if (templateJobEventId != null) {
          try { dbEvents.finishEvent(templateJobEventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: code === 0 ? `Template file not found at ${expectedPath}` : `Exit code ${code}`, finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_create) failed: ${e.message}`) }
          templateJobEventId = null
        }
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
    },
    onError(err) {
      templateJobProc = null
      if (templateJobEventId != null) {
        try { dbEvents.finishEvent(templateJobEventId, { status: 'failed', errorMessage: err.message, finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_create) onError failed: ${e.message}`) }
        templateJobEventId = null
      }
      broadcastTemplateJob({
        status: 'failed',
        doctorName,
        lastname,
        error: err.code === 'ENOENT'
          ? 'Claude CLI not installed. Install the Claude CLI to enable template creation.'
          : err.message,
        finishedAt: Date.now()
      })
    }
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

  const doctorForUpdate = dbDoctors.getDoctorByLastname(lastname)
  const doctorIdForUpdate = doctorForUpdate?.id || null

  const templateUpdateStartedAt = nowIso()
  templateJobEventId = null
  try {
    templateJobEventId = dbEvents.startEvent({ jobKind: 'template_update', relatedDoctorId: doctorIdForUpdate, modelUsed: model, effort, startedAt: templateUpdateStartedAt })
  } catch (e) { log(`[db] startEvent(template_update) failed: ${e.message}`) }

  templateJobProc = spawnClaude({
    prompt,
    model,
    effort,
    tag: '',
    label: 'template-update',
    onClose(code, errText, resultText, resultEvent) {
      templateJobProc = null
      const durationMs = Date.now() - templateJobStartMs

      if (/rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i.test(resultText + errText)) {
        if (templateJobEventId != null) {
          try { dbEvents.finishEvent(templateJobEventId, { status: 'rate_limited', ...extractUsage(resultEvent), errorMessage: 'Claude usage limit reached', finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_update) failed: ${e.message}`) }
          templateJobEventId = null
        }
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
        if (templateJobEventId != null) {
          try { dbEvents.finishEvent(templateJobEventId, { status: 'success', ...extractUsage(resultEvent), finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_update) failed: ${e.message}`) }
          templateJobEventId = null
        }

        // Extract the Step 7 changes report — everything from "Updated:" to end of output
        const changesReport = (() => {
          const idx = resultText.indexOf('Updated:')
          return idx !== -1 ? resultText.slice(idx).trim() : null
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
        if (templateJobEventId != null) {
          try { dbEvents.finishEvent(templateJobEventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: errText.slice(0, 1024), finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_update) failed: ${e.message}`) }
          templateJobEventId = null
        }
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
    },
    onError(err) {
      templateJobProc = null
      if (templateJobEventId != null) {
        try { dbEvents.finishEvent(templateJobEventId, { status: 'failed', errorMessage: err.message, finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_update) onError failed: ${e.message}`) }
        templateJobEventId = null
      }
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
    }
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
  // DB doctors by sanitized last-name. Fall back to active doctor.
  const doctors = getAllDoctors()
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

  // Look up the case DB id by folder path so we can bump revision + write backup_path
  let prechartCaseId = null
  try { prechartCaseId = dbCases.getCaseIdByDir(caseDir) } catch (_) {}

  const prechartStartedAt = nowIso()
  templateJobEventId = null
  try {
    templateJobEventId = dbEvents.startEvent({ caseId: prechartCaseId, jobKind: 'prechart', modelUsed: model, effort: 'high', startedAt: prechartStartedAt })
  } catch (e) { log(`[db] startEvent(prechart) failed: ${e.message}`) }

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

  templateJobProc = spawnClaude({
    prompt: promptText,
    model,
    effort: 'high',
    tag: '',
    label: `prechart][${patientLabel}`,
    onClose(code, errText, resultText, resultEvent) {
      templateJobProc = null
      cleanupAttachment()
      const durationMs = Date.now() - templateJobStartMs

      if (/rate.limit|usage.limit|too.many.requests|RateLimitError|overloaded|Claude.AI.usage.limit/i.test(resultText + errText)) {
        if (templateJobEventId != null) {
          try { dbEvents.finishEvent(templateJobEventId, { status: 'rate_limited', ...extractUsage(resultEvent), errorMessage: 'Claude usage limit reached', finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(prechart) failed: ${e.message}`) }
          templateJobEventId = null
        }
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
        // Parse BACKUP_OK: <abs-path> from skill output (Step 9 of edit-note skill)
        let backupPath = null
        const backupMatch = resultText.match(/BACKUP_OK:\s*(.+)/)
        if (backupMatch) {
          backupPath = backupMatch[1].trim()
        } else {
          // Defensive fallback: glob for most-recent backup file in the case dir
          try {
            const backups = fs.readdirSync(caseDir)
              .filter(f => /_soap_note_backup_/.test(f) && f.endsWith('.md'))
              .map(f => ({ f, mt: fs.statSync(path.join(caseDir, f)).mtimeMs }))
              .sort((a, b) => b.mt - a.mt)
            if (backups.length > 0) backupPath = path.join(caseDir, backups[0].f)
          } catch (_) {}
        }

        if (templateJobEventId != null) {
          try { dbEvents.finishEvent(templateJobEventId, { status: 'success', ...extractUsage(resultEvent), backupPath, finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(prechart) failed: ${e.message}`) }
          templateJobEventId = null
        }
        try { dbCases.bumpCaseRevision(prechartCaseId) } catch (e) { log(`[db] prechart bumpRevision failed: ${e.message}`) }

        // Skill overwrites the soap note in place. Diagnoses may have changed,
        // so re-run ICD coding before refreshing the .docx mirror. ICD is
        // best-effort — failures fall through to docx.
        const updatedNote = findExistingSoapNote(caseDir)
        if (updatedNote) {
          spawnIcdCoding({ soapNoteMdPath: updatedNote, caseId: prechartCaseId, caseTag: null })
            .then(() => spawnDocxConversion(updatedNote, null, null, prechartCaseId))
        } else {
          log(`[prechart][${patientLabel}] WARNING: claude exited 0 but soap note not found in ${caseDir}`)
        }
        // Hide backup .md files created by the edit-note skill
        try {
          fs.readdirSync(caseDir)
            .filter(f => f.endsWith('.md'))
            .forEach(f => hideFileFromUser(path.join(caseDir, f)))
        } catch {}
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
        if (templateJobEventId != null) {
          try { dbEvents.finishEvent(templateJobEventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: errText.slice(0, 1024), finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(prechart) failed: ${e.message}`) }
          templateJobEventId = null
        }
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
    },
    onError(err) {
      templateJobProc = null
      cleanupAttachment()
      if (templateJobEventId != null) {
        try { dbEvents.finishEvent(templateJobEventId, { status: 'failed', errorMessage: err.message, finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(prechart) onError failed: ${e.message}`) }
        templateJobEventId = null
      }
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
    }
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

// After a git pull that brought new commits: run npm install (picks up new/changed
// deps) then electron-rebuild (recompiles better-sqlite3 for this Electron ABI).
// Always calls onDone() — failure is logged but non-fatal; the safety net in
// app.whenReady() will show a recovery dialog if the user restarts too early.
function runPostUpdateSetup(onDone) {
  const isWin = process.platform === 'win32'

  log('[update] Running npm install...')
  const npmProc = spawn('npm', ['install', '--no-audit', '--silent'], {
    cwd: __dirname,
    stdio: 'pipe',
    shell: isWin
  })
  let npmStderr = ''
  npmProc.stderr.on('data', d => { npmStderr += d.toString() })
  npmProc.on('error', err => {
    log(`[update] npm install error: ${err.message}`)
    onDone()
  })
  npmProc.on('close', code => {
    if (code !== 0) {
      log(`[update] npm install failed (exit ${code}): ${npmStderr.trim()}`)
      onDone()
      return
    }
    log('[update] npm install OK — rebuilding native modules for Electron...')

    const rebuildBin = path.join(
      __dirname, 'node_modules', '.bin',
      isWin ? 'electron-rebuild.cmd' : 'electron-rebuild'
    )
    const rebuildProc = spawn(rebuildBin, ['-f', '-w', 'better-sqlite3'], {
      cwd: __dirname,
      stdio: 'pipe',
      shell: isWin
    })
    let rebuildLog = ''
    rebuildProc.stdout.on('data', d => { rebuildLog += d.toString() })
    rebuildProc.stderr.on('data', d => { rebuildLog += d.toString() })
    rebuildProc.on('error', err => {
      log(`[update] electron-rebuild not found or failed to start: ${err.message}`)
      onDone()
    })
    rebuildProc.on('close', rCode => {
      if (rCode !== 0) {
        log(`[update] electron-rebuild failed (exit ${rCode}): ${rebuildLog.trim()}`)
      } else {
        log('[update] Native modules rebuilt OK')
      }
      onDone()
    })
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
      ensureMcpConfig(NOTES_DIR)
      log('[update] Skills re-synced from updated code')
    }

    // Run npm install + electron-rebuild before telling the user to restart,
    // so the native modules are ready when they do. Notification fires after
    // both steps complete (or if either fails — the safety net dialog handles
    // the restart-too-early case).
    runPostUpdateSetup(() => {
      const stagingTag = isStagingBuild() ? ' (staging)' : ''
      if (tray) tray.setToolTip(`AI Medical Scribe${stagingTag} — updated, restart to apply`)
      log('[update] Notifying user to restart')
      const { Notification } = require('electron')
      if (Notification.isSupported()) {
        new Notification({
          title: `AI Medical Scribe${stagingTag} updated`,
          body: 'A new version was downloaded. Restart the app to apply it.',
          silent: true
        }).show()
      }
    })
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

// Project-scope MCP config — written to <NOTES_DIR>/.mcp.json so the `claude -p`
// invocations (cwd: NOTES_DIR) always have the ICD-10 connector available,
// even if the user's personal ~/.claude.json doesn't already have it. Re-written
// on every sync alongside the .claude/ skills copy so an upstream tweak to the
// connector URL propagates without a manual fix.
const MCP_CONFIG = {
  mcpServers: {
    icd10: {
      type: 'http',
      url: 'https://hcls.mcp.claude.com/icd10_codes/mcp'
    }
  }
}

function ensureMcpConfig(notesDir) {
  if (!notesDir) return
  try {
    fs.writeFileSync(path.join(notesDir, '.mcp.json'), JSON.stringify(MCP_CONFIG, null, 2) + '\n')
  } catch (err) {
    log(`[mcp] failed to write .mcp.json: ${err.message}`)
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

// Merge a CDI field update onto the single-patient recording entry and rebroadcast.
// The CDI fields are decorative on top of the main status state machine — they
// drive the Open CDI Review button + the approval-required badge in the popup
// without affecting the recording's primary status transitions.
function setRecordingCdi(caseTag, cdiUpdate) {
  const entry = sessionRecordings.find(r => r.caseTag === caseTag)
  if (!entry || !cdiUpdate) return
  Object.assign(entry, cdiUpdate)
  broadcastRecordingStatus()
}

// Same, but for one child in a multi-patient recording.
function setPatientCdi(caseTag, patientFolderName, cdiUpdate) {
  const entry = sessionRecordings.find(r => r.caseTag === caseTag)
  if (!entry || !entry.patients || !cdiUpdate) return
  const patient = entry.patients.find(p => p.folderName === patientFolderName)
  if (!patient) return
  Object.assign(patient, cdiUpdate)
  broadcastRecordingStatus()
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

  // better-sqlite3 is a native addon — if it didn't load, show a recovery dialog
  // and quit. The user needs to run reinstall.ps1 to rebuild the binary for this
  // Electron version. checkForUpdates() does this automatically going forward.
  if (_dbStartupError) {
    dialog.showErrorBox(
      'AI Medical Scribe — reinstall required',
      'A required component (database module) could not load.\n\n' +
      'This usually means the app updated but the native module was not yet rebuilt.\n\n' +
      'Fix: run "reinstall.ps1" from the app folder (or re-run the original installer), then restart.\n\n' +
      `Detail: ${_dbStartupError.message}`
    )
    app.quit()
    return
  }

  // Load notes directory from .env if already configured
  const env = readEnv()
  const savedPath = env.NOTES_DIR_PATH && env.NOTES_DIR_PATH.trim()
  if (savedPath) {
    loadPaths(savedPath)
    fs.mkdirSync(CASES_DIR, { recursive: true })
    fs.mkdirSync(TEMPLATES_DIR, { recursive: true })
    copyDirSync(CLAUDE_CONFIG_SRC, path.join(NOTES_DIR, '.claude'))
    ensureMcpConfig(NOTES_DIR)
    log('.claude config synced to AI Medical Notes')
    hideNotesDirInternals()
    hideExistingCaseMdFiles()

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

    // Open (or create) the SQLite metadata DB.
    try {
      const db = initDb(savedPath)
      if (db) {
        const s = readSettings()
        const doctors = s.doctors || []
        if (doctors.length > 0) {
          migrateDoctorsFromSettings(db, doctors,
            (patch) => writeSettings({ ...readSettings(), ...patch }),
            savedPath, extractLastname)
        } else {
          tryRestoreDoctorsFromBackup(db, savedPath,
            (patch) => writeSettings({ ...readSettings(), ...patch }),
            extractLastname)
        }
        log('[db] Database ready')
      }
    } catch (e) {
      log(`[db] WARNING: database init failed — running without DB: ${e.message}`)
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

  log(`Build: ${isStagingBuild() ? 'STAGING' : 'production'} (branch=${getCurrentBranch()})`)

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

  // Create main window
  win = new BrowserWindow({
    width: 280,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.once('ready-to-show', () => win.show())

  ipcMain.handle('hide-window', () => { if (win && !win.isDestroyed()) win.minimize() })

  // Minimize to taskbar instead of closing; real quit comes from tray → Quit
  win.on('close', e => {
    if (!isQuitting) {
      e.preventDefault()
      win.minimize()
    }
  })

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
    isQuitting = true
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

  // ---- get-build-info ----
  ipcMain.handle('get-build-info', () => ({
    isStaging: isStagingBuild(),
    branch:    getCurrentBranch()
  }))

  // ---- start-session ----
  ipcMain.handle('start-session', async () => {
    log('start-session')
    const doctors = getAllDoctors()

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
    broadcastRecordingStatus()

    try {
      activeSessionId = dbSessions.startSession({ sessionFolder: activeSessionDir, doctorId: activeDoctorId })
    } catch (e) {
      log(`[db] startSession insert failed: ${e.message}`)
      activeSessionId = null
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

    try {
      if (activeSessionId) dbSessions.endSession(activeSessionId)
    } catch (e) {
      log(`[db] endSession failed: ${e.message}`)
    }

    activeDoctorId = null
    activeSessionId = null
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

    pendingAudioDuration = null
    recordingProcess = spawn(PYTHON, recordArgs, { cwd: __dirname })

    recordingProcess.stdout.on('data', d => {
      const msg = d.toString().trim()
      log(`[record.py] ${msg}`)
      const m = msg.match(/DURATION_SECONDS:\s*([\d.]+)/)
      if (m) pendingAudioDuration = parseFloat(m[1])
    })
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

    const _stopDoctor = dbDoctors.getDoctor(activeDoctorId) || getAllDoctors().find(d => d.id === activeDoctorId)
    const _stopTemplatePath = _stopDoctor?.templatePath || null

    if (fs.existsSync(tempMp3Path)) {
      try {
        fs.copyFileSync(tempMp3Path, mp3Dest)
        fs.unlinkSync(tempMp3Path)
        log(`MP3 moved to: ${mp3Dest}`)
      } catch (e) {
        log(`ERROR moving MP3 from ${tempMp3Path} to ${mp3Dest}: ${e.message}`)
        tempMp3Path = null
        setState(STATE.SESSION_ACTIVE)
        notifyUser('Recording failed', 'Could not save the recording. Check the log.')
        return false
      }
    } else {
      log(`WARNING: temp MP3 not found at ${tempMp3Path} — recording may have failed`)
    }

    // Capture audio metadata before nulling the duration var
    const capturedDuration = pendingAudioDuration
    pendingAudioDuration = null
    tempMp3Path = null

    // Create the case DB row now that the MP3 is in its final location.
    let caseId = null
    try {
      caseId = dbCases.createCase({
        patientName:  name || null,
        doctorId:     activeDoctorId,
        sessionId:    activeSessionId,
        caseDir,
        source:       'recording',
        mp3Path:      mp3Dest,
        recordedAt:   nowIso()
      })
      if (caseId && (capturedDuration != null || fs.existsSync(mp3Dest))) {
        dbCases.updateCaseAudio(caseId, {
          durationSeconds: capturedDuration,
          sizeBytes:       fs.existsSync(mp3Dest) ? fs.statSync(mp3Dest).size : null
        })
      }
    } catch (e) {
      log(`[db] createCase failed: ${e.message}`)
    }

    addRecordingEntry(folderName, name ? name.replace(/_/g, ' ') : null)
    spawnTranscription(mp3Dest, transcriptDest, soapNotePath, folderName, _stopTemplatePath, caseId)

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
      noDoctors: getAllDoctors().length === 0,
      notesDirMissing: !notesDirEnv || !notesDirEnv.trim()
    }
  })

  // ---- get-doctors ----
  ipcMain.handle('get-doctors', () => getAllDoctors())

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
    try {
      dbDoctors.updateDoctorTemplate(id, destPath)
      log(`Template updated in DB for ${doctor.name}: ${destPath}`)
    } catch (e) {
      log(`[db] updateDoctorTemplate failed: ${e.message}`)
    }
    log(`Template updated for ${doctor.name}: ${destPath}`)
    return { ok: true, doctor: { ...doctor, templatePath: destPath } }
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
  ipcMain.handle('get-doctors-with-templates', () =>
    getAllDoctors()
      .filter(d => d.templatePath && fs.existsSync(d.templatePath))
      .map(d => d.name)
      .sort()
  )

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
      if (templateJobEventId != null) {
        try { dbEvents.finishEvent(templateJobEventId, { status: 'cancelled', durationMs: Date.now() - templateJobStartMs, finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(cancel) failed: ${e.message}`) }
        templateJobEventId = null  // onClose fires after kill — null ID makes finishEvent a no-op
      }
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
        if (!othersUsingTemplate && tp.startsWith(TEMPLATES_DIR) && fs.existsSync(tp)) {
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
  // don't have a corresponding standards file produce CDI_SKIPPED.
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

    const _uploadDoctor = dbDoctors.getDoctor(activeDoctorId) || getAllDoctors().find(d => d.id === activeDoctorId)
    const _uploadTemplatePath = _uploadDoctor?.templatePath || null

    // Create the case DB row
    let caseId = null
    const audioSizeBytes = fs.existsSync(audioDest) ? fs.statSync(audioDest).size : null
    try {
      caseId = dbCases.createCase({
        patientName:  name || null,
        doctorId:     activeDoctorId,
        sessionId:    activeSessionId,
        caseDir,
        source:       'upload',
        mp3Path:      audioDest,
        recordedAt:   nowIso()
      })
      if (caseId) {
        dbCases.updateCaseAudio(caseId, { durationSeconds: null, sizeBytes: audioSizeBytes })
      }
    } catch (e) {
      log(`[db] createCase(upload) failed: ${e.message}`)
    }

    // Probe audio duration via pydub (already a required dep) — non-blocking
    if (caseId && fs.existsSync(audioDest)) {
      const probeProc = spawn(
        PYTHON,
        ['-c', `from pydub import AudioSegment; a = AudioSegment.from_file(r"${audioDest}"); print(f"DURATION_SECONDS: {a.duration_seconds:.3f}")`],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let probeBuf = ''
      probeProc.stdout.on('data', d => { probeBuf += d.toString() })
      probeProc.on('close', code => {
        if (code === 0) {
          const m = probeBuf.match(/DURATION_SECONDS:\s*([\d.]+)/)
          if (m) {
            try { dbCases.updateCaseAudio(caseId, { durationSeconds: parseFloat(m[1]), sizeBytes: audioSizeBytes }) } catch (_) {}
            log(`[upload] Duration: ${m[1]}s`)
          }
        }
      })
      probeProc.on('error', () => {})  // non-fatal — transcription continues regardless
    }

    addRecordingEntry(folderName, name ? name.replace(/_/g, ' ') : null)
    setState(STATE.PROCESSING)
    spawnTranscription(audioDest, transcriptDest, soapNotePath, folderName, _uploadTemplatePath, caseId)

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
    ensureMcpConfig(NOTES_DIR)
    hideNotesDirInternals()
    hideExistingCaseMdFiles()

    // Reset DB connection to point at the new location.
    try {
      const db = resetDb(NOTES_DIR)
      if (db) {
        const s = readSettings()
        const doctors = s.doctors || []
        if (doctors.length > 0) {
          migrateDoctorsFromSettings(db, doctors,
            (patch) => writeSettings({ ...readSettings(), ...patch }),
            NOTES_DIR, extractLastname)
        } else {
          tryRestoreDoctorsFromBackup(db, NOTES_DIR,
            (patch) => writeSettings({ ...readSettings(), ...patch }),
            extractLastname)
        }
        log('[db] Database ready at new notes dir')
      }
    } catch (e) {
      log(`[db] WARNING: database init failed after dir change: ${e.message}`)
    }

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
