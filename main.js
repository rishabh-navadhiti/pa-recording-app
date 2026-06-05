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
const { parseSkillManifest } = require('./src/llm/skill-io/manifest')
const { extractUsage, logSkillStream } = require('./src/llm/usage')
const {
  CLAUDE_RATE_LIMITED,
  ELEVENLABS_RATE_LIMITED,
  MCP_AUTH_ERROR,
  ELEVENLABS_AUTH_ERROR,
  DURATION_SECONDS: DURATION_RE,
} = require('./src/llm/skill-io/markers')
const { bootstrapLogger }    = require('./log/logger')
const { buildPrompt }        = require('./src/llm/skill-io/prompts')
const { runCaseChain, runMultiPatientChain } = require('./src/pipeline/chain')
const { runEngine }          = require('./src/engines/engineRunner')
const icdEngine              = require('./src/engines/icd')
const { spawnTranscription } = require('./src/pipeline/transcription')
const { ingestAudio }        = require('./src/pipeline/ingest')
const { runJob }             = require('./src/jobs/jobDispatcher')
const templateCreateJob      = require('./src/jobs/templateCreate')
const templateUpdateJob      = require('./src/jobs/templateUpdate')
const prechartJob            = require('./src/jobs/prechart')
const { DEFAULT_SETTINGS }   = require('./config/settings')
const { writeMcpConfig }     = require('./config/mcp')
const { bootstrap }          = require('./startup/bootstrap')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const { STATE }        = require('./src/shared/state')
const { STATUS_LABELS } = require('./src/shared/pipeline-status')

// ---------------------------------------------------------------------------
// Single module-level context reference — set by bootstrap() in app.whenReady().
// ---------------------------------------------------------------------------

let ctx = null

// ---------------------------------------------------------------------------
// Shims — delegate to ctx after bootstrap; fallback for early startup code
// ---------------------------------------------------------------------------

function log(msg) {
  if (ctx) ctx.log(msg)
  else bootstrapLogger.log(msg)
}

function readSettings() {
  return ctx ? ctx.config.get() : { ...DEFAULT_SETTINGS }
}

function writeSettings(patch) {
  if (ctx) ctx.config.save(patch)
}

function setState(s) {
  if (ctx) ctx.stores.state.setState(s)
}

function addRecordingEntry(caseTag, displayName) {
  ctx?.stores.recordings.add({ caseTag, displayName })
}
function updateRecordingStatus(caseTag, status) {
  ctx?.stores.recordings.updateStatus(caseTag, status)
}
function setRecordingPatients(caseTag, patients) {
  ctx?.stores.recordings.setPatients(caseTag, patients)
}
function updatePatientStatus(caseTag, folderName, status) {
  ctx?.stores.recordings.updatePatientStatus(caseTag, folderName, status)
}
function setRecordingCdi(caseTag, update) {
  ctx?.stores.recordings.setCdi(caseTag, update)
}
function setPatientCdi(caseTag, folderName, update) {
  ctx?.stores.recordings.setPatientCdi(caseTag, folderName, update)
}
function broadcastRecordingStatus() {
  if (!ctx) return
  const payload = ctx.stores.recordings.getAll()
  ctx.renderer.send('recording-status-update', payload)
  ctx.sendStatus('recording-status-update', payload)
}

function nowIso() { return new Date().toISOString() }

// Canonical doctor list: DB first, then the one-time migration backup as last resort.
// settings.json no longer carries doctors[] after the v1 migration.
function getAllDoctors() {
  const fromDb = dbDoctors.listDoctors()
  if (fromDb.length > 0) return fromDb
  try {
    const backupPath = path.join(ctx.paths.notesDir, 'settings.doctors.backup.json')
    const raw = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
    if (Array.isArray(raw) && raw.length > 0) return raw
  } catch (_) {}
  return []
}

// Atomic write: write to .tmp then rename, with retry for transient Windows AV locks (EPERM/EBUSY).
// Still used by writeSettings() shim (via ctx.config.save) and by ensureMcpConfig replacement.
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
  const casesDir = ctx.paths.casesDir
  const datestamp = new Date().toISOString().slice(0, 10)
  let todayCount = 0
  try {
    todayCount = fs.readdirSync(casesDir).filter(name => name === datestamp || name.startsWith(`${datestamp}(`)).length
  } catch {}
  const folderName = todayCount === 0 ? datestamp : `${datestamp}(${todayCount + 1})`
  const sessionDir = path.join(casesDir, folderName)
  fs.mkdirSync(sessionDir, { recursive: true })
  log(`Session folder created: ${sessionDir}`)
  return sessionDir
}

function buildCaseFolder(sanitizedName) {
  const datestamp = new Date().toISOString().slice(0, 10)
  const folderName = sanitizedName
    ? `${sanitizedName}_${datestamp}`
    : `recording_${datestamp}_${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}`
  const baseDir = ctx.stores.session.get().dir || ctx.paths.casesDir
  const caseDir = path.join(baseDir, folderName)
  fs.mkdirSync(caseDir, { recursive: true })
  return { caseDir, folderName }
}

function notifyUser(title, body) {
  if (ctx) { ctx.platform.notify(title, body); return }
  const { Notification } = require('electron')
  if (Notification.isSupported()) {
    new Notification({ title, body, silent: false }).show()
  }
}

function hideFileFromUser(filePath) {
  if (ctx) { ctx.platform.hideInternal(filePath); return }
  if (process.platform !== 'win32') return
  const { exec } = require('child_process')
  exec(`attrib +h "${filePath}"`, err => {
    if (err) log(`[hide] ${path.basename(filePath)}: ${err.message}`)
  })
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

// extractUsage and logSkillStream imported from src/llm/usage.js above.
// logSkillStream call sites pass log as first arg: logSkillStream(log, tag, kind, ev)

// spawnTranscription — extracted to src/pipeline/transcription.js.
// This shim delegates to the module, injecting ctx + the downstream chain callers.
function _callSpawnTranscription(mp3Path, transcriptDest, soapNotePath, caseTag, templatePath, caseId) {
  spawnTranscription({
    mp3Path, transcriptDest, soapNotePath, caseTag, templatePath, caseId, ctx,
    onSuccess: (tDest, soapPath, tag, tmpl, cId) =>
      spawnSoapGeneration(tDest, soapPath, tag, false, tmpl, cId),
    spawnDocx: (mdPath, tag, folder, cId) =>
      spawnDocxConversion(mdPath, tag, folder, cId, ctx),
  })
}

function spawnSoapGeneration(transcriptAbsPath, soapNoteMdPath, caseTag, isRetry = false, templatePath = null, caseId = null) {
  const tag = caseTag ? `[${caseTag}] ` : ''
  if (caseTag) updateRecordingStatus(caseTag, 'generating_note')
  const relTranscript = path.relative(ctx.paths.notesDir, transcriptAbsPath).replace(/\\/g, '/')
  const relTemplate   = templatePath ? path.relative(ctx.paths.notesDir, templatePath).replace(/\\/g, '/') : null

  const soapModel = readSettings().soapModel
  if (isRetry) log(`${tag}[soap] retry attempt`)

  const startedAt = nowIso()
  let eventId = null
  try {
    eventId = dbEvents.startEvent({ caseId, jobKind: 'soap', modelUsed: soapModel, startedAt })
  } catch (e) { log(`[db] startEvent(soap) failed: ${e.message}`) }

  // Provider seam: arg-array spawn via ctx.llm (claudeCliProvider) — no shell injection.
  ctx.llm.runSkill({
    prompt: buildPrompt('generate-note', { templateRel: relTemplate, transcriptRel: relTranscript }),
    model: soapModel,
    tag,
    label: 'soap',
  }).then(async (runResult) => {
    const { code, text: resultText, resultEvent, errText } = runResult

    const isRateLimited = CLAUDE_RATE_LIMITED.test(resultText + errText)
    if (isRateLimited) {
      try {
        dbEvents.finishEvent(eventId, { status: 'rate_limited', ...extractUsage(resultEvent), errorMessage: 'Claude usage limit reached', finishedAt: nowIso() })
        dbCases.setCaseStatus(caseId, 'failed')
        dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true })
      } catch (e) { log(`[db] soap rate-limited update failed: ${e.message}`) }
      ctx.renderer.send('service-warning', { title: 'Claude usage limit reached', message: `Your recording has been saved. Notes could not be generated — try again once the limit resets.` })
      if (caseTag) updateRecordingStatus(caseTag, 'failed')
      return
    }
    if (code !== 0) {
      try {
        dbEvents.finishEvent(eventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: errText.slice(0, 1024), finishedAt: nowIso() })
        dbCases.setCaseStatus(caseId, 'failed')
        dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true })
      } catch (e) { log(`[db] soap failure update failed: ${e.message}`) }
      if (caseTag) updateRecordingStatus(caseTag, 'failed')
      return
    }

    logSkillStream(log, tag, 'soap', resultEvent)

    const manifest = parseSkillManifest(resultText)
    if (!manifest) {
      log(`${tag}[soap] ERROR: could not parse JSON manifest from skill output`)
      try { dbEvents.finishEvent(eventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: 'manifest parse failed', finishedAt: nowIso() }); dbCases.setCaseStatus(caseId, 'failed'); dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true }) } catch {}
      if (caseTag) updateRecordingStatus(caseTag, 'failed')
      return
    }

    try { log(`${tag}[soap][manifest] ${JSON.stringify(manifest)}`) } catch {}

    if (manifest.schema_version !== 1) {
      log(`${tag}[soap] ERROR: unsupported manifest schema_version=${manifest.schema_version}`)
      try { dbEvents.finishEvent(eventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: `unsupported schema_version=${manifest.schema_version}`, finishedAt: nowIso() }); dbCases.setCaseStatus(caseId, 'failed'); dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true }) } catch {}
      if (caseTag) updateRecordingStatus(caseTag, 'failed')
      return
    }

    if (manifest.status === 'failed' || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
      log(`${tag}[soap] manifest status=${manifest.status || '?'} cases=${(manifest.cases || []).length} — marking failed`)
      try { dbEvents.finishEvent(eventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: `manifest status=${manifest.status || '?'}`, finishedAt: nowIso() }); dbCases.setCaseStatus(caseId, 'failed'); dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true }) } catch {}
      if (caseTag) updateRecordingStatus(caseTag, 'failed')
      return
    }

    try { dbEvents.finishEvent(eventId, { status: 'success', ...extractUsage(resultEvent), finishedAt: nowIso() }) } catch (e) { log(`[db] soap success finishEvent failed: ${e.message}`) }

    if (!manifest.multi_patient) {
      // Single-patient: validate soap .md on disk, update DB, then run ICD→CDI→docx chain.
      const c = manifest.cases[0] || {}
      if (c.status === 'failed' || !c.soap_note_md) {
        log(`${tag}[soap] single-patient status=${c.status || '?'} or no soap_note_md — marking failed`)
        try { dbCases.setCaseStatus(caseId, 'failed'); dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true }) } catch {}
        if (caseTag) updateRecordingStatus(caseTag, 'failed')
        return
      }
      const soapPath = c.soap_note_md
      if (!fs.existsSync(soapPath)) {
        log(`${tag}[soap] WARNING: manifest declared ${soapPath} but file not on disk — marking failed`)
        try { dbCases.setCaseStatus(caseId, 'failed'); dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true }) } catch {}
        if (caseTag) updateRecordingStatus(caseTag, 'failed')
        return
      }
      log(`${tag}[soap] SOAP note confirmed: ${soapPath}`)
      try { dbCases.updateCasePaths(caseId, { status: 'converting', soap_note_path: soapPath }) } catch (e) { log(`[db] soap path update failed: ${e.message}`) }

      const doctorId = ctx.stores.session.get().doctorId
      let doctor = null
      try { doctor = dbDoctors?.getDoctor(doctorId) || null } catch {}
      await runCaseChain(ctx, {
        caseId, caseTag,
        patientFolderName: null,
        doctor,
        soapNoteMdPath: soapPath,
        caseDir: path.dirname(soapPath),
      })
    } else {
      // Multi-patient: chain.runMultiPatientChain handles child folders + ICD→CDI→docx per child.
      const doctorId = ctx.stores.session.get().doctorId
      let doctor = null
      try { doctor = dbDoctors?.getDoctor(doctorId) || null } catch {}
      await runMultiPatientChain(ctx, {
        caseTag,
        parentCaseId: caseId,
        manifest,
        recordingFolder: path.dirname(soapNoteMdPath),
        doctor,
      })
    }
  }).catch(err => {
    log(`${tag}[soap ERR] runSkill failed: ${err.message}`)
    try { dbEvents.finishEvent(eventId, { status: 'failed', errorMessage: err.message, finishedAt: nowIso() }); dbCases.setCaseStatus(caseId, 'failed'); dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true }) } catch {}
    if (err.code === 'ENOENT') ctx.renderer.send('setup-warning', 'Claude is not installed — note generation unavailable. Install the Claude CLI to enable SOAP notes.')
  })
}


// spawnDocxConversion — extracted to src/pipeline/docx.js.
// This local wrapper injects ctx so call sites remain identical.
function spawnDocxConversion(mdPath, caseTag, patientFolderName = null, caseId = null) {
  const { spawnDocxConversion: _docx } = require("./src/pipeline/docx")
  _docx(mdPath, caseTag, patientFolderName, caseId, ctx)
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

function readTemplateJob() {
  return ctx ? ctx.jobState.load() : { status: 'idle' }
}

function writeTemplateJob(job) {
  if (ctx) ctx.jobState.save(job)
}

function spawnTemplateCreation(doctorName, stagingDir) {
  const lastname = extractLastname(doctorName) || 'doctor'
  const stagingRel = path.relative(ctx.paths.notesDir, stagingDir).replace(/\\/g, '/')
  // Fire-and-forget; the IPC handler already checked jobs.isRunning(). The job
  // dispatcher acquires the single-flight lock synchronously before its first await.
  runJob(templateCreateJob, { doctorName, lastname, stagingRel }, ctx, { stagingDir })
}

function spawnTemplateUpdate(doctorName, templatePath, corrections, correctionsFile, samplesDir) {
  const lastname = extractLastname(doctorName) || doctorName.toLowerCase()
  // Flatten corrections newlines to " | " (the skill's Step 0 line separator) and
  // forward-slash paths. The old "->' shell-escaping is dropped — arg-array spawn
  // passes content faithfully, so the model now sees the scribe's text verbatim.
  const input = {
    doctorName,
    templatePath:    templatePath.replace(/\\/g, '/'),
    corrections:     (corrections || '').replace(/\r?\n/g, ' | '),
    correctionsFile: correctionsFile ? correctionsFile.replace(/\\/g, '/') : '',
    samplesDir:      samplesDir ? samplesDir.replace(/\\/g, '/') : '',
  }
  runJob(templateUpdateJob, input, ctx, { lastname })
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

  const activeDoctorId = ctx?.stores.session.get().doctorId
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
    const proc = spawn(ctx.python, [
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
  let prechartCaseId = null
  try { prechartCaseId = dbCases.getCaseIdByDir(caseDir) } catch (_) {}

  const input = {
    caseDir:        caseDir.replace(/\\/g, '/'),
    templatePath:   templatePath.replace(/\\/g, '/'),
    attachmentPath: (combinedAttachmentPath || '').replace(/\\/g, '/'),
    instructions:   (instructions || '').replace(/\r?\n/g, ' '),
  }
  runJob(prechartJob, input, ctx, {
    patientLabel,
    caseId: prechartCaseId,
    combinedAttachmentPath,   // raw temp path, for cleanup
    runEngine,
    icdEngine,
    spawnDocxConversionFn: (md, tag, folder, cid) => spawnDocxConversion(md, tag, folder, cid),
    findExistingSoapNoteFn: findExistingSoapNote,
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
    // Quote rebuildBin: default install paths contain spaces (e.g.
    // "AI Medical Scribe (Staging)"), and with shell:true an unquoted path is
    // split on the first space — cmd.exe then tries to run "...\Programs\AI".
    const rebuildProc = spawn(`"${rebuildBin}" -f -w better-sqlite3`, [], {
      cwd: __dirname,
      stdio: 'pipe',
      shell: true
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

function checkForUpdates(appCtx) {
  // Run git pull --ff-only in background — no blocking, no crash on failure
  const _ctx = appCtx || ctx
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
    const notesDir = _ctx?.paths?.notesDir
    if (notesDir) {
      const claudeConfigSrc = path.join(__dirname, 'notes-claude')
      copyDirSync(claudeConfigSrc, path.join(notesDir, '.claude'))
      writeMcpConfig(notesDir, p => _ctx?.platform?.hideInternal(p), log)
      log('[update] Skills re-synced from updated code')
    }

    // Run npm install + electron-rebuild before telling the user to restart,
    // so the native modules are ready when they do. Notification fires after
    // both steps complete (or if either fails — the safety net dialog handles
    // the restart-too-early case).
    runPostUpdateSetup(() => {
      const stagingTag = _ctx?.platform?.isStaging() ? ' (staging)' : ''
      if (_ctx?.tray) _ctx.tray.setToolTip(`AI Medical Scribe${stagingTag} — updated, restart to apply`)
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

// ---------------------------------------------------------------------------
// Recording status tracking — all shims defined at top of file; delegate to ctx store
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Single-instance guard
// ---------------------------------------------------------------------------

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
  return  // second instance — nothing to do
}

app.on('second-instance', () => {
  if (ctx?.win) {
    if (!ctx.win.isVisible()) ctx.win.show()
    ctx.win.focus()
  }
})

// ---------------------------------------------------------------------------
// App ready
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  const env = readEnv()
  const notesDir = env.NOTES_DIR_PATH && env.NOTES_DIR_PATH.trim() || null

  ctx = await bootstrap({
    notesDir,
    dbStartupError: _dbStartupError,
    registerIpcHandlers,
    checkForUpdates,
  })
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

function registerIpcHandlers(appCtx) {
  // Note: hide-window is registered inside createMainWindow() (windows/mainWindow.js),
  // not here — it's a window lifecycle concern, not a domain IPC handler.

  // ---- get-state ----
  ipcMain.handle('get-state', () => appCtx.stores.state.getState())

  // ---- get-build-info ----
  ipcMain.handle('get-build-info', () => ({
    isStaging: appCtx.platform.isStaging()
  }))

  // ---- start-session ----
  ipcMain.handle('start-session', async () => {
    log('start-session')
    const doctors = getAllDoctors()

    if (doctors.length === 0) {
      log('start-session blocked: no doctors configured')
      return { ok: false, error: 'no-doctors' }
    }

    let selectedId
    if (doctors.length === 1) {
      selectedId = doctors[0].id
      log(`Auto-selected doctor: ${doctors[0].name}`)
    } else {
      // Multiple doctors — ask renderer to pick
      appCtx.renderer.send('pick-doctor', doctors)
      selectedId = await appCtx.stores.session.awaitDoctorPick()

      if (!selectedId) {
        log('start-session cancelled: no doctor selected')
        return { ok: false, error: 'cancelled' }
      }
      log(`Selected doctor ID: ${selectedId}`)
    }

    appCtx.stores.session.setDoctor(selectedId)
    const sessionDir = createSessionFolder()
    appCtx.stores.recordings.clear()

    let sessionId = null
    try {
      sessionId = dbSessions.startSession({ sessionFolder: sessionDir, doctorId: selectedId })
    } catch (e) {
      log(`[db] startSession insert failed: ${e.message}`)
    }
    appCtx.stores.session.setSession(sessionId, sessionDir)

    setState(STATE.SESSION_ACTIVE)
    return { ok: true }
  })

  // ---- stop-session ----
  ipcMain.handle('stop-session', async () => {
    log('stop-session')
    appCtx.stores.session.cancelDoctorPick()

    try {
      const { sessionId } = appCtx.stores.session.get()
      if (sessionId) dbSessions.endSession(sessionId)
    } catch (e) {
      log(`[db] endSession failed: ${e.message}`)
    }

    // If somehow recording when session is stopped, kill the process
    if (appCtx.stores.recorder.isRecording()) {
      const proc = appCtx.stores.recorder.getProcess()
      const tmpMp3 = appCtx.stores.recorder.getTempMp3Path()
      appCtx.stores.recorder.clearProcess()
      if (proc) {
        proc.kill()
        await waitForExit(proc)
      }
      if (tmpMp3 && fs.existsSync(tmpMp3)) {
        try { fs.unlinkSync(tmpMp3) } catch {}
      }
    }
    appCtx.stores.recorder.cancelPatientName()
    if (appCtx.statusWin && !appCtx.statusWin.isDestroyed()) {
      appCtx.statusWin.close()
    }
    appCtx.stores.session.clear()
    appCtx.stores.recordings.clear()
    setState(STATE.IDLE)
    return true
  })

  // ---- start-recording ----
  ipcMain.handle('start-recording', () => {
    log('start-recording')
    const tmpMp3 = path.join(os.tmpdir(), `rec_${Date.now()}.mp3`)
    log(`Temp MP3: ${tmpMp3}`)

    const settings = readSettings()
    const recordArgs = [
      path.join(__dirname, 'python', 'record.py'),
      '--output', tmpMp3
    ]
    if (settings.manualDeviceSelection && settings.selectedDeviceIndex != null) {
      recordArgs.push('--device', String(settings.selectedDeviceIndex))
      log(`Using manual device index: ${settings.selectedDeviceIndex}`)
    }

    const recProc = spawn(appCtx.python, recordArgs, { cwd: __dirname })
    appCtx.stores.recorder.setProcess(recProc, tmpMp3)

    recProc.stdout.on('data', d => {
      const msg = d.toString().trim()
      log(`[record.py] ${msg}`)
      const m = msg.match(DURATION_RE)
      if (m) appCtx.stores.recorder.setPendingDuration(parseFloat(m[1]))
    })
    recProc.stderr.on('data', d => {
      const msg = d.toString().trim()
      if (!msg) return
      log(`[record.py ERR] ${msg}`)
      // Surface BlackHole / setup errors to renderer
      if (msg.includes('ERROR')) {
        appCtx.renderer.send('setup-warning', msg.replace(/^ERROR:\s*/, ''))
      }
    })
    recProc.on('exit', code => {
      log(`record.py exited ${code}`)
      // isRecording() returns false if stop-recording already cleared the process —
      // so a true here means Python died on its own — recover to SESSION_ACTIVE.
      const curState = appCtx.stores.state.getState()
      if ((curState === STATE.RECORDING || curState === STATE.PAUSED) && appCtx.stores.recorder.isRecording()) {
        log('record.py exited unexpectedly — returning to SESSION_ACTIVE')
        appCtx.stores.recorder.clearProcess()
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
    const tempMp3Path = appCtx.stores.recorder.getTempMp3Path()
    if (appCtx.stores.recorder.isRecording()) {
      // stop() nulls _proc internally so the exit handler sees isRecording()=false
      // and skips the "exited unexpectedly" recovery path. Returns the proc ref.
      const procToStop = appCtx.stores.recorder.stop()
      if (procToStop) exitPromise = waitForExit(procToStop)
    } else {
      log('WARNING: stop-recording called but recordingProcess already gone')
    }

    // Update UI immediately — don't wait for Python's WAV→MP3 conversion first.
    // This stops the timer and shows PROCESSING state right when Save is clicked.
    setState(STATE.PROCESSING)
    appCtx.renderer.send('show-patient-form')

    // Wait for patient name entry and Python's WAV→MP3 conversion concurrently.
    // The scribe can name the case while the conversion runs in the background.
    const [name] = await Promise.all([
      appCtx.stores.recorder.awaitPatientName(),
      exitPromise
    ])

    log(`Patient name: ${name || '(none)'}`)

    const { doctorId: _stopDoctorId } = appCtx.stores.session.get()
    const _stopDoctor = dbDoctors.getDoctor(_stopDoctorId) || getAllDoctors().find(d => d.id === _stopDoctorId)
    const _stopTemplatePath = _stopDoctor?.templatePath || null
    const capturedDuration = appCtx.stores.recorder.consumePendingDuration()

    if (!fs.existsSync(tempMp3Path)) {
      log(`WARNING: temp MP3 not found at ${tempMp3Path} — recording may have failed`)
    }

    const mp3Filename = name ? `${name}.mp3` : 'recording.mp3'
    const { ok: ingestOk } = ingestAudio({
      audioSrc:          tempMp3Path,
      audioDestName:     mp3Filename,
      patientName:       name,
      source:            'recording',
      doctorId:          _stopDoctorId,
      templatePath:      _stopTemplatePath,
      capturedDuration,
      moveAudio:         true,
      probeDuration:     false,
      ctx:               appCtx,
      spawnTranscription: _callSpawnTranscription,
    })
    if (!ingestOk) {
      setState(STATE.SESSION_ACTIVE)
      notifyUser('Recording failed', 'Could not save the recording. Check the log.')
      return false
    }

    // Return to SESSION_ACTIVE so scribe can immediately start the next recording
    setState(STATE.SESSION_ACTIVE)

    // If auto-record is enabled, tell the renderer to trigger a new recording
    if (readSettings().autoRecord) {
      appCtx.renderer.send('auto-start-recording')
    }

    return true
  })

  // ---- pause-recording ----
  ipcMain.handle('pause-recording', () => {
    log('pause-recording')
    appCtx.stores.recorder.pause()
    setState(STATE.PAUSED)
    return true
  })

  // ---- resume-recording ----
  ipcMain.handle('resume-recording', () => {
    log('resume-recording')
    appCtx.stores.recorder.resume()
    setState(STATE.RECORDING)
    return true
  })

  // ---- discard-recording ----
  ipcMain.handle('discard-recording', async () => {
    log('discard-recording')

    if (appCtx.stores.recorder.isRecording()) {
      const mp3ToDelete = appCtx.stores.recorder.getTempMp3Path()
      // discard() nulls _proc + _tempMp3Path internally then sends stop\n
      const procToStop = appCtx.stores.recorder.discard()
      // Update UI immediately — stop the timer without waiting for Python's conversion.
      setState(STATE.SESSION_ACTIVE)
      // Clean up temp files in background after Python exits.
      // Also delete the WAV in case Python hadn't converted it yet.
      if (procToStop) {
        waitForExit(procToStop).then(() => {
          const wavPath = mp3ToDelete ? mp3ToDelete.replace('.mp3', '_tmp.wav') : null
          for (const p of [mp3ToDelete, wavPath]) {
            if (p && fs.existsSync(p)) {
              try { fs.unlinkSync(p) } catch (e) { log(`Failed to delete temp file: ${e.message}`) }
            }
          }
        }).catch(() => {})
      }
      return true
    }

    const tmpMp3 = appCtx.stores.recorder.getTempMp3Path()
    if (tmpMp3 && fs.existsSync(tmpMp3)) {
      try {
        fs.unlinkSync(tmpMp3)
        log(`Discarded temp MP3: ${tmpMp3}`)
      } catch (e) {
        log(`Failed to delete temp MP3: ${e.message}`)
      }
    }
    appCtx.stores.recorder.clearProcess()

    setState(STATE.SESSION_ACTIVE)
    return true
  })

  // ---- submit-patient-name (registered once at startup) ----
  ipcMain.handle('submit-patient-name', (_, name) => {
    appCtx.stores.recorder.resolvePatientName(sanitizeName(name))
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

  // -------------------------------------------------------------------------
  // Template creation (AI profile builder) — Templates tab
  // -------------------------------------------------------------------------

  // ---- browse-notes-files ----
  // Multi-select file picker for sample notes + supporting documents.
  ipcMain.handle('browse-notes-files', async () => {
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
  ipcMain.handle('start-template-creation', async (_, doctorName, filePaths) => {
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
  ipcMain.handle('browse-corrections-file', async () => {
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
  ipcMain.handle('start-template-update', async (_, doctorName, corrections, correctionsFile, sampleFiles) => {
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
    const result = await dialog.showOpenDialog(appCtx.win, {
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

    const { doctorId: _uploadDoctorId } = appCtx.stores.session.get()
    const _uploadDoctor = dbDoctors.getDoctor(_uploadDoctorId) || getAllDoctors().find(d => d.id === _uploadDoctorId)
    const _uploadTemplatePath = _uploadDoctor?.templatePath || null
    const ext = path.extname(filePath)
    const audioFilename = name ? `${name}${ext}` : `recording${ext}`

    setState(STATE.PROCESSING)
    const { ok: ingestOk } = ingestAudio({
      audioSrc:          filePath,
      audioDestName:     audioFilename,
      patientName:       name,
      source:            'upload',
      doctorId:          _uploadDoctorId,
      templatePath:      _uploadTemplatePath,
      capturedDuration:  null,
      moveAudio:         false,
      probeDuration:     true,
      ctx:               appCtx,
      spawnTranscription: _callSpawnTranscription,
    })
    if (!ingestOk) {
      setState(STATE.SESSION_ACTIVE)
      return false
    }

    // Return to SESSION_ACTIVE immediately — pipeline runs in background
    setState(STATE.SESSION_ACTIVE)
    return true
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
    const { createAppContext } = require('./context/appContext')
    const newCtx = createAppContext(newNotesDir)
    // Transfer window/tray references from the old ctx.
    newCtx.win   = appCtx.win
    newCtx.tray  = appCtx.tray
    newCtx.python = appCtx.python
    newCtx.setStatusSend = appCtx.setStatusSend
    newCtx.statusWin = appCtx.statusWin
    newCtx.attachWindows(appCtx.renderer, (ch, ...a) => appCtx.sendStatus(ch, ...a))
    ctx = newCtx
    Object.assign(appCtx, newCtx)  // shallow-copy new ctx into the local reference

    const { bootstrapNotesDir } = require('./startup/bootstrapNotesDir')
    await bootstrapNotesDir(newNotesDir, ctx)
    writeSettings(migratedSettings)

    // Reset DB connection to point at the new location.
    try {
      const db = resetDb(newNotesDir)
      if (db) {
        ctx.setDb(db)
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

  // ---- get-session-recordings ----
  ipcMain.handle('get-session-recordings', () => appCtx.stores.recordings.getAll())

  // ---- open-status-window ----
  ipcMain.handle('open-status-window', () => {
    if (appCtx.statusWin && !appCtx.statusWin.isDestroyed()) {
      appCtx.statusWin.focus()
      return
    }
    const mainBounds = appCtx.win.getBounds()
    const statusWidth = 300
    const statusHeight = 380
    const { workArea } = screen.getPrimaryDisplay()
    let sx = mainBounds.x - statusWidth - 8
    let sy = mainBounds.y
    sx = Math.max(workArea.x, Math.min(sx, workArea.x + workArea.width - statusWidth))
    sy = Math.max(workArea.y, Math.min(sy, workArea.y + workArea.height - statusHeight))
    const statusWin = new BrowserWindow({
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
    appCtx.statusWin = statusWin
    appCtx.setStatusSend((ch, ...a) => {
      if (!statusWin.isDestroyed()) statusWin.webContents.send(ch, ...a)
    })
    statusWin.loadFile(path.join(__dirname, 'renderer', 'status.html'))
    statusWin.on('closed', () => {
      appCtx.statusWin = null
      appCtx.setStatusSend(null)
    })
  })

  // ---- close-status-window ----
  ipcMain.handle('close-status-window', () => {
    if (appCtx.statusWin && !appCtx.statusWin.isDestroyed()) appCtx.statusWin.close()
  })

  // ---- open-soap-note ----
  ipcMain.handle('open-soap-note', async (_, filePath) => {
    const { shell } = require('electron')
    // Confine to casesDir so the renderer cannot open arbitrary paths.
    const normalized = path.resolve(filePath)
    const casesDir = appCtx.paths.casesDir
    if (!casesDir || !normalized.startsWith(path.resolve(casesDir) + path.sep)) {
      log(`open-soap-note: path outside casesDir rejected: ${filePath}`)
      return ''
    }
    return shell.openPath(normalized)
  })
}
