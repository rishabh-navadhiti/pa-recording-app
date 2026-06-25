'use strict'

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, dialog } = require('electron')
app.setName('Ai medical scribe')
app.setAppUserModelId('Ai medical scribe')
const path = require('path')
const fs = require('fs')
const https = require('https')
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
const { buildSingleCallNoteGen, splitNoteAndManifest } = require('./src/llm/skill-io/singleCall')
const { normalizeApiUsage } = require('./src/llm/pricing')
const { resolveOption } = require('./src/llm/modelOptions')
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
const { buildCombinedAttachment: combineAttachmentFiles } = require('./src/pipeline/attachments')
const { ingestAudio }        = require('./src/pipeline/ingest')
const { runJob }             = require('./src/jobs/jobDispatcher')
const templateCreateJob      = require('./src/jobs/templateCreate')
const templateUpdateJob      = require('./src/jobs/templateUpdate')
const prechartJob            = require('./src/jobs/prechart')
const prechartApiJob         = require('./src/jobs/prechartApi')
const { DEFAULT_SETTINGS }   = require('./config/settings')
const { writeMcpConfig }     = require('./config/mcp')
const { bootstrap }          = require('./startup/bootstrap')
const { checkForUpdates }    = require('./src/update/autoUpdate')
const { copyDirSync }        = require('./src/pipeline/artifacts')
const { registerLifecycleIpc }   = require('./src/ipc/lifecycle')
const { registerRecordingIpc }   = require('./src/ipc/recording')
const { registerDoctorsIpc }     = require('./src/ipc/doctors')
const { registerTemplatesIpc }   = require('./src/ipc/templates')
const { registerPrechartIpc }    = require('./src/ipc/prechart')
const { registerConfigIpc }      = require('./src/ipc/config')
const { registerAudioUploadIpc } = require('./src/ipc/audioUpload')
const { registerStatusIpc }      = require('./src/ipc/status')

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

function validateAnthropicKey(apiKey) {
  return new Promise(resolve => {
    const req = https.request(
      { hostname: 'api.anthropic.com', path: '/v1/models', method: 'GET',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } },
      res => resolve(res.statusCode === 200 ? 'valid' : res.statusCode === 401 ? 'invalid' : 'unknown')
    )
    req.on('error', () => resolve('unknown'))
    req.end()
  })
}

function validateGeminiKey(apiKey) {
  return new Promise(resolve => {
    const req = https.request(
      { hostname: 'generativelanguage.googleapis.com', path: '/v1beta/models', method: 'GET',
        headers: { 'x-goog-api-key': apiKey } },
      res => resolve(res.statusCode === 200 ? 'valid' : (res.statusCode === 400 || res.statusCode === 403) ? 'invalid' : 'unknown')
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
  const cfg = readSettings()
  const opt = resolveOption(cfg.soapModel)

  if (opt.provider === 'api') {
    generateSoapViaApi(transcriptAbsPath, soapNoteMdPath, caseTag, isRetry, templatePath, caseId, opt.model, ctx.api, 'Anthropic')
    return
  }

  if (opt.provider === 'gemini') {
    generateSoapViaApi(transcriptAbsPath, soapNoteMdPath, caseTag, isRetry, templatePath, caseId, opt.model, ctx.gemini, 'Gemini')
    return
  }

  const tag = caseTag ? `[${caseTag}] ` : ''
  if (caseTag) updateRecordingStatus(caseTag, 'generating_note')
  const relTranscript = path.relative(ctx.paths.notesDir, transcriptAbsPath).replace(/\\/g, '/')
  const relTemplate   = templatePath ? path.relative(ctx.paths.notesDir, templatePath).replace(/\\/g, '/') : null

  const soapModel = cfg.soapModel
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


// ---------------------------------------------------------------------------
// generateSoapViaApi — single-call Anthropic Messages API path.
// Sibling of the CLI path inside spawnSoapGeneration; the CLI path is
// byte-for-byte untouched. Called when opt.provider === 'api'.
// ---------------------------------------------------------------------------
async function generateSoapViaApi(transcriptAbsPath, soapNoteMdPath, caseTag, isRetry, templatePath, caseId, model, provider = null, providerName = 'API') {
  if (!provider) provider = ctx.api
  const tag = caseTag ? `[${caseTag}] ` : ''
  if (caseTag) updateRecordingStatus(caseTag, 'generating_note')
  if (isRetry) log(`${tag}[soap:api] retry attempt`)

  const startedAt = nowIso()
  let eventId = null
  try {
    eventId = dbEvents.startEvent({ caseId, jobKind: 'soap', modelUsed: model, startedAt })
  } catch (e) { log(`[db] startEvent(soap:api) failed: ${e.message}`) }

  const fail = async (status, errorMessage) => {
    try {
      dbEvents.finishEvent(eventId, { status, errorMessage: (errorMessage || '').slice(0, 1024), finishedAt: nowIso() })
      dbCases.setCaseStatus(caseId, 'failed')
      dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true })
    } catch {}
    if (caseTag) updateRecordingStatus(caseTag, 'failed')
  }

  // Read inputs
  let templateText = ''
  let transcriptText = ''
  let skillText = ''
  try {
    if (templatePath && fs.existsSync(templatePath)) {
      templateText = fs.readFileSync(templatePath, 'utf8')
    }
    transcriptText = fs.readFileSync(transcriptAbsPath, 'utf8')
    const skillPath = path.join(ctx.paths.claudeDir, 'skills', 'generate-note-api', 'SKILL.md')
    skillText = fs.readFileSync(skillPath, 'utf8')
  } catch (e) {
    log(`${tag}[soap:api] [DEV-ALERT] ERROR reading inputs: ${e.message}`)
    await fail('failed', `read inputs: ${e.message}`)
    return
  }

  const caseDir = path.dirname(soapNoteMdPath)
  const doctorLastname = templatePath ? path.basename(templatePath, '.md') : 'unknown'

  // Derive injected facts from caseTag (e.g. "jackie_2026-06-18")
  const dateMatch = caseTag ? caseTag.match(/_(\d{4}-\d{2}-\d{2})$/) : null
  const dateOfService = dateMatch
    ? dateMatch[1].replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3/$1')
    : null
  const patientSlug = dateMatch ? caseTag.slice(0, caseTag.length - dateMatch[0].length) : caseTag
  const patientName = patientSlug
    ? patientSlug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : null

  const { system, user } = buildSingleCallNoteGen({
    skillText, templateText, transcriptText, caseDir, soapNoteMdPath,
    doctorLastname, patientName, dateOfService,
  })

  const runResult = await provider.runSingleCall({ system, user, model, tag, label: 'soap:api' })
  const { ok, text: resultText, rawUsage, durationMs, errText, statusCode } = runResult
  const usageFields = normalizeApiUsage({ model, rawUsage, durationMs })

  if (!ok) {
    const keyEnvName = providerName === 'Gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'
    const isAuthError = !!(errText?.includes(`${keyEnvName} not set`) || statusCode === 401)
    const isRateLimit = statusCode === 429 || statusCode === 529
    const title   = isAuthError ? `${providerName} API key missing or invalid`
                  : isRateLimit ? `${providerName} API rate limit reached`
                  : 'Note generation failed'
    const message = isAuthError
      ? `Set your ${providerName} API key in Settings → Advanced.`
      : isRateLimit
      ? 'Your recording has been saved. Notes could not be generated — try again in a moment.'
      : `Your recording has been saved. Error: ${(errText || 'unknown').slice(0, 200)}`
    log(`${tag}[soap:api] [DEV-ALERT] ${providerName} API call failed: ${errText}`)
    ctx.renderer.send('service-warning', { title, message })
    await fail('failed', errText)
    return
  }

  const { noteBody, manifest } = splitNoteAndManifest(resultText)

  if (!manifest) {
    log(`${tag}[soap:api] [DEV-ALERT] could not parse manifest from API output`)
    await fail('failed', 'manifest parse failed')
    return
  }

  try { log(`${tag}[soap:api][manifest] ${JSON.stringify(manifest)}`) } catch {}

  if (manifest.schema_version !== 1) {
    log(`${tag}[soap:api] ERROR: unsupported schema_version=${manifest.schema_version}`)
    await fail('failed', `unsupported schema_version=${manifest.schema_version}`)
    return
  }

  if (manifest.status === 'failed' || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    log(`${tag}[soap:api] manifest status=${manifest.status || '?'} cases=${(manifest.cases || []).length} — marking failed`)
    await fail('failed', `manifest status=${manifest.status || '?'}`)
    return
  }

  // Multi-patient: detect → bail → fan out (M2).
  if (manifest.multi_patient) {
    const detectedCases = manifest.cases || []
    if (detectedCases.length === 0) {
      log(`${tag}[soap:api] [DEV-ALERT] multi_patient:true but no cases in detection manifest — falling back to single-note`)
      // No patients detected — treat as single-patient fallback
    } else {
      log(`${tag}[soap:api] multi-patient detection: ${detectedCases.length} patients — fanning out`)

      // Finish the detection event (cheap — no note was written)
      try { dbEvents.finishEvent(eventId, { status: 'success', ...usageFields, finishedAt: nowIso() }) } catch {}

      // Pre-compute collision-safe slugs/paths before launching parallel calls.
      const slugsUsed = new Set()
      const fanOutTargets = detectedCases.map((c, i) => {
        let baseSlug = (c.patient_name ? sanitizeName(c.patient_name) : null) || `unknown_${i + 1}`
        let slug = baseSlug; let n = 2
        while (slugsUsed.has(slug)) { slug = `${baseSlug}_${n}`; n++ }
        slugsUsed.add(slug)
        return { c, i, slug, targetNotePath: path.join(caseDir, `${slug}_soap_note.md`) }
      })

      fs.mkdirSync(caseDir, { recursive: true })

      // Fire all targeted API calls in parallel — each is independent.
      const fanOutResults = await Promise.all(fanOutTargets.map(async ({ c, i, slug, targetNotePath }) => {
        log(`${tag}[soap:api] fan-out ${i + 1}/${detectedCases.length}: "${c.patient_name}" → ${path.basename(targetNotePath)}`)

        // Use positional fallback for unnamed patients so the "Target patient" line
        // is always present — without it the model re-enters detection mode and bails.
        const targetPatientLabel = c.patient_name || `(patient ${i + 1} in transcript, unnamed)`
        const { system: tSys, user: tUser } = buildSingleCallNoteGen({
          skillText, templateText, transcriptText,
          caseDir, soapNoteMdPath: targetNotePath,
          doctorLastname, dateOfService,
          patientName: c.patient_name,
          targetPatient: targetPatientLabel,
        })

        let tEventId = null
        try { tEventId = dbEvents.startEvent({ caseId, jobKind: 'soap', modelUsed: model, startedAt: nowIso() }) } catch {}

        const tResult = await ctx.api.runSingleCall({ system: tSys, user: tUser, model, tag, label: `soap:api:p${i + 1}` })
        const tUsage  = normalizeApiUsage({ model, rawUsage: tResult.rawUsage, durationMs: tResult.durationMs })

        if (!tResult.ok) {
          log(`${tag}[soap:api] [DEV-ALERT] fan-out "${c.patient_name}" API error: ${tResult.errText}`)
          try { dbEvents.finishEvent(tEventId, { status: 'failed', ...tUsage, finishedAt: nowIso() }) } catch {}
          return { ...c, soap_note_md: targetNotePath, status: 'failed' }
        }

        const { noteBody: tBody, manifest: tManifest } = splitNoteAndManifest(tResult.text)

        // Guard: a targeted call must never bail again — no recursion.
        if (tManifest?.multi_patient) {
          log(`${tag}[soap:api] [DEV-ALERT] targeted call for "${c.patient_name}" returned multi_patient:true — skipping, no recursion`)
          try { dbEvents.finishEvent(tEventId, { status: 'failed', ...tUsage, finishedAt: nowIso() }) } catch {}
          return { ...c, soap_note_md: targetNotePath, status: 'failed' }
        }

        try {
          fs.writeFileSync(targetNotePath, tBody, 'utf8')
          log(`${tag}[soap:api] fan-out note written: ${targetNotePath}`)
        } catch (e) {
          log(`${tag}[soap:api] [DEV-ALERT] fan-out write failed for "${c.patient_name}": ${e.message}`)
          try { dbEvents.finishEvent(tEventId, { status: 'failed', ...tUsage, finishedAt: nowIso() }) } catch {}
          return { ...c, soap_note_md: targetNotePath, status: 'failed' }
        }

        try { dbEvents.finishEvent(tEventId, { status: 'success', ...tUsage, finishedAt: nowIso() }) } catch {}
        const tc = tManifest?.cases?.[0] || {}
        return {
          patient_name:    c.patient_name,
          doctor_lastname: tc.doctor_lastname || doctorLastname,
          visit_type:      tc.visit_type      || c.visit_type      || null,
          chief_complaint: tc.chief_complaint || c.chief_complaint || null,
          soap_note_md:    targetNotePath,
          placeholders:    tc.placeholders    || [],
          warnings:        tc.warnings        || [],
          status:          tc.status          || 'ok',
        }
      }))

      const syntheticCases = fanOutResults

      if (!syntheticCases.some(c => c.status !== 'failed')) {
        log(`${tag}[soap:api] all fan-out patients failed`)
        await fail('failed', 'all fan-out patients failed')
        return
      }

      const syntheticManifest = {
        schema_version:   1,
        skill:            'generate-note',
        status:           syntheticCases.every(c => c.status === 'ok') ? 'ok' : 'partial',
        multi_patient:    true,
        recording_folder: caseDir,
        cases:            syntheticCases,
        warnings:         [],
      }

      try { dbCases.updateCasePaths(caseId, { status: 'converting', soap_note_path: null }) } catch {}

      const _mpDoctorId = ctx.stores.session.get().doctorId
      let _mpDoctor = null
      try { _mpDoctor = dbDoctors?.getDoctor(_mpDoctorId) || null } catch {}

      await runMultiPatientChain(ctx, {
        caseTag,
        parentCaseId: caseId,
        manifest:     syntheticManifest,
        recordingFolder: caseDir,
        doctor:       _mpDoctor,
      })
      return
    }
  }

  // Single-patient: validate case status then write the note.
  const c = manifest.cases[0] || {}
  if (c.status === 'failed') {
    log(`${tag}[soap:api] manifest case status=failed`)
    await fail('failed', 'manifest case status=failed')
    return
  }

  // Write the note to the app's authoritative path — never use the model-supplied path.
  try {
    fs.mkdirSync(caseDir, { recursive: true })
    fs.writeFileSync(soapNoteMdPath, noteBody, 'utf8')
    log(`${tag}[soap:api] SOAP note written: ${soapNoteMdPath}`)
  } catch (e) {
    log(`${tag}[soap:api] [DEV-ALERT] ERROR writing SOAP note: ${e.message}`)
    await fail('failed', `write failed: ${e.message}`)
    return
  }

  try { dbEvents.finishEvent(eventId, { status: 'success', ...usageFields, finishedAt: nowIso() }) } catch (e) { log(`[db] soap:api finishEvent failed: ${e.message}`) }
  try { dbCases.updateCasePaths(caseId, { status: 'converting', soap_note_path: soapNoteMdPath }) } catch (e) { log(`[db] soap:api path update failed: ${e.message}`) }

  const doctorId = ctx.stores.session.get().doctorId
  let doctor = null
  try { doctor = dbDoctors?.getDoctor(doctorId) || null } catch {}
  await runCaseChain(ctx, {
    caseId, caseTag,
    patientFolderName: null,
    doctor,
    soapNoteMdPath,
    caseDir,
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
  // Forward the RAW samplesDir (not the forward-slashed prompt value) so the
  // descriptor can delete the transient staging folder on every terminal path.
  runJob(templateUpdateJob, input, ctx, { lastname, samplesDir })
}

// ---------------------------------------------------------------------------
// Pre-chart (edit-note) — background job
// ---------------------------------------------------------------------------
//
// Invoked from the SESSION_ACTIVE "Pre-chart" sub-view. Runs the edit-note
// skill against an existing patient case folder, optionally with new clinical
// content (one or more files combined into a single .md by src/pipeline/attachments.js)
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

// Combine the Pre-chart attachment files into a single temp .md. As of Phase 5
// this runs in Node (src/pipeline/attachments.js — mammoth/.docx, pdf-parse/.pdf)
// instead of spawning python/extract_attachments.py.
function buildCombinedAttachment(filePaths) {
  return combineAttachmentFiles(filePaths, { log })
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

  const opt        = resolveOption(readSettings().soapModel)
  const descriptor = (opt?.provider === 'cli') ? prechartJob : prechartApiJob

  runJob(descriptor, input, ctx, {
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
    // checkForUpdates moved to src/update/autoUpdate.js; inject the deps it needs
    // (repo root for cwd, the shared copyDirSync, and the mcp writer).
    checkForUpdates: (c) => checkForUpdates(c, { appRoot: __dirname, copyDirSync, writeMcpConfig }),
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
  // not here -- it's a window lifecycle concern, not a domain IPC handler.
  //
  // The 43 domain handlers were split into per-domain registrars under src/ipc/
  // (Phase 3, Group 8). Each registrar destructures the helpers it needs from
  // this `deps` object, so the moved handler bodies stay byte-identical and keep
  // using the bare helper names. `appRoot` carries main.js's __dirname (the repo
  // root) so handlers that spawn Python / load window files resolve paths the
  // same way they did when they lived here. `setGlobalCtx` lets change-notes-dir
  // re-point this module's `ctx` binding from inside config.js.
  const deps = {
    log, setState, STATE, nowIso,
    getAllDoctors, createSessionFolder,
    readEnv, writeEnvKey, validateElevenLabsKey, validateAnthropicKey, validateGeminiKey,
    extractLastname, sanitizeName, notifyUser,
    readSettings, writeSettings, copyDirSync, waitForExit,
    readTemplateJob, writeTemplateJob,
    spawnTemplateCreation, spawnTemplateUpdate, spawnPrechartJob,
    findRecentPatientCases, findExistingSoapNote, buildCombinedAttachment,
    ingestAudio,
    _callSpawnTranscription,
    dbDoctors, dbSessions, dbEvents,
    resetDb, migrateDoctorsFromSettings, tryRestoreDoctorsFromBackup,
    appRoot: __dirname,
    setGlobalCtx: (c) => { ctx = c },
  }

  registerLifecycleIpc(ipcMain, appCtx, deps)
  registerRecordingIpc(ipcMain, appCtx, deps)
  registerDoctorsIpc(ipcMain, appCtx, deps)
  registerTemplatesIpc(ipcMain, appCtx, deps)
  registerPrechartIpc(ipcMain, appCtx, deps)
  registerConfigIpc(ipcMain, appCtx, deps)
  registerAudioUploadIpc(ipcMain, appCtx, deps)
  registerStatusIpc(ipcMain, appCtx, deps)
}
