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

function spawnTranscription(mp3Path, transcriptDest, soapNotePath, caseTag, templatePath, caseId = null) {
  const tag = caseTag ? `[${caseTag}] ` : ''
  const stderrChunks = []
  const startedAt = nowIso()
  const wallStart = Date.now()

  let eventId = null
  try {
    eventId = dbEvents.startEvent({ caseId, jobKind: 'transcribe', startedAt })
  } catch (e) { log(`[db] startEvent(transcribe) failed: ${e.message}`) }

  const transcribeProc = spawn(ctx.python, [
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
        if (caseId) dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true })
      } catch (e) { log(`[db] transcribe failure update failed: ${e.message}`) }
      if (caseTag) updateRecordingStatus(caseTag, 'failed')
      const stderr = stderrChunks.join('')
      if (ELEVENLABS_AUTH_ERROR.test(stderr)) {
        ctx.renderer.send('service-warning', {
          title: 'ElevenLabs API key invalid',
          message: 'Your API key was rejected. Update it in Settings to resume transcription.'
        })
      } else if (ELEVENLABS_RATE_LIMITED.test(stderr)) {
        ctx.renderer.send('service-warning', {
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
  const shellCmd = `claude -p "${safePrompt}"${modelFlag} --output-format stream-json --verbose --dangerously-skip-permissions`

  // Log the actual command that's about to run — prefix any custom env vars
  // the way you'd type them in a shell, so the line is copy-pasteable for
  // debugging (cwd is always NOTES_DIR).
  const envPrefix = [
    effort ? `CLAUDE_CODE_EFFORT_LEVEL=${effort}` : null,
    ...(env ? Object.entries(env).map(([k, v]) => `${k}=${v}`) : [])
  ].filter(Boolean).join(' ')
  log(`${tag}[${label}] $ ${envPrefix ? envPrefix + ' ' : ''}${shellCmd}`)

  const proc = spawn(
    shellCmd,
    [],
    { cwd: ctx.paths.notesDir, stdio: ['ignore', 'pipe', 'pipe'], shell: true, env: spawnEnv }
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
      }, spawnDocxConversion)
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
      }, spawnDocxConversion)
    }
  }).catch(err => {
    log(`${tag}[soap ERR] runSkill failed: ${err.message}`)
    try { dbEvents.finishEvent(eventId, { status: 'failed', errorMessage: err.message, finishedAt: nowIso() }); dbCases.setCaseStatus(caseId, 'failed'); dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true }) } catch {}
    if (err.code === 'ENOENT') ctx.renderer.send('setup-warning', 'Claude is not installed — note generation unavailable. Install the Claude CLI to enable SOAP notes.')
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
  // the docx call; cdi_md_path in spawnCdiReview's success branch before docx
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

  const proc = spawn(ctx.python, [
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
          dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: false })
        } catch (e) { log(`[db] docx soap success update failed: ${e.message}`) }
        if (patientFolderName) {
          const allEntries = ctx.stores.recordings.getAll()
          const entry = allEntries.find(r => r.caseTag === caseTag)
          const patient = entry?.patients?.find(p => p.folderName === patientFolderName)
          ctx.stores.recordings.setDocxPath(caseTag, docxPath)
          notifyUser('SOAP note ready', patient?.name || patientFolderName.replace(/_/g, ' '))
          updatePatientStatus(caseTag, patientFolderName, 'completed')
        } else if (caseTag) {
          const allEntries = ctx.stores.recordings.getAll()
          const entry = allEntries.find(r => r.caseTag === caseTag)
          ctx.stores.recordings.setDocxPath(caseTag, docxPath)
          notifyUser('SOAP note ready', entry?.displayName || caseTag)
          updateRecordingStatus(caseTag, 'completed')
        }
      } else {
        try {
          dbEvents.finishEvent(eventId, { status: 'failed', durationMs, finishedAt: nowIso() })
          dbCases.setCaseStatus(caseId, 'failed')
          dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: true })
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

function readTemplateJob() {
  return ctx ? ctx.jobState.load() : { status: 'idle' }
}

function writeTemplateJob(job) {
  if (ctx) ctx.jobState.save(job)
}

function broadcastTemplateJob(job) {
  writeTemplateJob(job)
  ctx?.renderer.send('template-job-status', job)
  ctx?.sendStatus('template-job-status', job)
}

function spawnTemplateCreation(doctorName, stagingDir) {
  const lastname = extractLastname(doctorName) || 'doctor'
  const stagingRel = path.relative(ctx.paths.notesDir, stagingDir).replace(/\\/g, '/')
  const settings = readSettings()
  const model  = settings.templateModel  || 'claude-opus-4-8'
  const effort = settings.templateEffort || 'max'

  const prompt = `create a doctor profile for "${doctorName}" from source folder "${stagingRel}"`

  // The actual shell command is logged by spawnClaude as `[template] $ ...`.
  const jobStartMs = Date.now()

  const templateCreateStartedAt = nowIso()
  let templateJobEventId = null
  try {
    templateJobEventId = dbEvents.startEvent({ jobKind: 'template_create', modelUsed: model, effort, startedAt: templateCreateStartedAt })
  } catch (e) { log(`[db] startEvent(template_create) failed: ${e.message}`) }

  const templateJobProc = spawnClaude({
    prompt,
    model,
    effort,
    tag: '',
    label: 'template',
    onClose(code, errText, resultText, resultEvent) {
      ctx.stores.jobs.clear()
      const durationMs = Date.now() - jobStartMs
      logSkillStream(log, '', 'template', resultEvent)

      if (CLAUDE_RATE_LIMITED.test(resultText + errText)) {
        const evId = ctx.stores.jobs.getEventId() ?? templateJobEventId
        if (evId != null) {
          try { dbEvents.finishEvent(evId, { status: 'rate_limited', ...extractUsage(resultEvent), errorMessage: 'Claude usage limit reached', finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_create) failed: ${e.message}`) }
        }
        broadcastTemplateJob({
          status: 'failed',
          doctorName,
          lastname,
          error: 'Claude usage limit reached. Try again once the limit resets.',
          finishedAt: Date.now()
        })
        ctx.renderer.send('service-warning', {
          title: 'Claude usage limit reached',
          message: 'Template creation could not complete — try again once the limit resets.'
        })
        return
      }

      const expectedPath = path.join(ctx.paths.templatesDir, `${lastname}.md`)
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
      ctx.stores.jobs.clear()
      if (templateJobEventId != null) {
        try { dbEvents.finishEvent(templateJobEventId, { status: 'failed', errorMessage: err.message, finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_create) onError failed: ${e.message}`) }
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

  ctx.stores.jobs.start('create', templateJobProc, templateJobEventId)

  broadcastTemplateJob({
    status: 'running',
    doctorName,
    lastname,
    startedAt: jobStartMs,
    model,
    effort
  })
}

function spawnTemplateUpdate(doctorName, templatePath, corrections, correctionsFile, samplesDir) {
  const lastname = extractLastname(doctorName) || doctorName.toLowerCase()
  const settings = readSettings()
  const model  = settings.templateModel  || 'claude-opus-4-8'
  const effort = settings.templateEffort || 'max'

  // Flatten multi-line corrections and strip double quotes to avoid breaking shell quoting on Windows
  const safeCorrections = (corrections || '').replace(/\r?\n/g, ' | ').replace(/"/g, "'")
  const safeName = doctorName.replace(/"/g, "'")
  const safePath = templatePath.replace(/\\/g, '/').replace(/"/g, "'")
  const safeCorrectionsFile = correctionsFile ? correctionsFile.replace(/\\/g, '/').replace(/"/g, "'") : ''
  const safeSamplesDir = samplesDir ? samplesDir.replace(/\\/g, '/').replace(/"/g, "'") : ''

  const prompt = `update doctor profile. Doctor: ${safeName}. Template: ${safePath}. Corrections: ${safeCorrections}. CorrectionsFile: ${safeCorrectionsFile}. Samples: ${safeSamplesDir}`

  // The actual shell command is logged by spawnClaude as `[template-update] $ ...`.
  const updateJobStartMs = Date.now()

  const doctorForUpdate = dbDoctors.getDoctorByLastname(lastname)
  const doctorIdForUpdate = doctorForUpdate?.id || null

  const templateUpdateStartedAt = nowIso()
  let templateUpdateJobEventId = null
  try {
    templateUpdateJobEventId = dbEvents.startEvent({ jobKind: 'template_update', relatedDoctorId: doctorIdForUpdate, modelUsed: model, effort, startedAt: templateUpdateStartedAt })
  } catch (e) { log(`[db] startEvent(template_update) failed: ${e.message}`) }

  const templateUpdateProc = spawnClaude({
    prompt,
    model,
    effort,
    tag: '',
    label: 'template-update',
    onClose(code, errText, resultText, resultEvent) {
      ctx.stores.jobs.clear()
      const durationMs = Date.now() - updateJobStartMs
      logSkillStream(log, '', 'template-update', resultEvent)

      if (CLAUDE_RATE_LIMITED.test(resultText + errText)) {
        if (templateUpdateJobEventId != null) {
          try { dbEvents.finishEvent(templateUpdateJobEventId, { status: 'rate_limited', ...extractUsage(resultEvent), errorMessage: 'Claude usage limit reached', finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_update) failed: ${e.message}`) }
        }
        broadcastTemplateJob({
          type: 'update',
          status: 'failed',
          doctorName,
          lastname,
          error: 'Claude usage limit reached. Try again once the limit resets.',
          finishedAt: Date.now()
        })
        ctx.renderer.send('service-warning', {
          title: 'Claude usage limit reached',
          message: 'Template update could not complete — try again once the limit resets.'
        })
        return
      }

      if (code === 0) {
        if (templateUpdateJobEventId != null) {
          try { dbEvents.finishEvent(templateUpdateJobEventId, { status: 'success', ...extractUsage(resultEvent), finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_update) failed: ${e.message}`) }
        }

        // Extract changes report from JSON manifest (B6) or fall back to "Updated:" text marker.
        const updateManifest = parseSkillManifest(resultText)
        const changesReport = (() => {
          if (updateManifest && updateManifest.skill === 'update-doctor-profile') {
            // Manifest is last line — everything before it is the human-readable report.
            const lastNewline = resultText.lastIndexOf('\n')
            return lastNewline > 0 ? resultText.slice(0, lastNewline).trim() : null
          }
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
        if (templateUpdateJobEventId != null) {
          try { dbEvents.finishEvent(templateUpdateJobEventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: errText.slice(0, 1024), finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_update) failed: ${e.message}`) }
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
      ctx.stores.jobs.clear()
      if (templateUpdateJobEventId != null) {
        try { dbEvents.finishEvent(templateUpdateJobEventId, { status: 'failed', errorMessage: err.message, finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(template_update) onError failed: ${e.message}`) }
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

  ctx.stores.jobs.start('update', templateUpdateProc, templateUpdateJobEventId)

  broadcastTemplateJob({
    type: 'update',
    status: 'running',
    doctorName,
    lastname,
    startedAt: updateJobStartMs,
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
  const settings = readSettings()
  const model = settings.soapModel || 'claude-sonnet-4-6'

  // Build the skill prompt. Match update-doctor-profile's style: literal field names,
  // shell-safe quoting (replace " with ' inside any user-supplied string).
  const safeCase    = caseDir.replace(/\\/g, '/').replace(/"/g, "'")
  const safeTpl     = templatePath.replace(/\\/g, '/').replace(/"/g, "'")
  const safeAttach  = (combinedAttachmentPath || '').replace(/\\/g, '/').replace(/"/g, "'")
  const safeInstr   = (instructions || '').replace(/\r?\n/g, ' ').replace(/"/g, "'")
  const promptText  = `edit note. Case: ${safeCase}. Template: ${safeTpl}. Attachment: ${safeAttach}. Instructions: ${safeInstr}`

  // The actual shell command is logged by spawnClaude as `[prechart] $ ...`.
  const prechartJobStartMs = Date.now()

  // Look up the case DB id by folder path so we can bump revision + write backup_path
  let prechartCaseId = null
  try { prechartCaseId = dbCases.getCaseIdByDir(caseDir) } catch (_) {}

  const prechartStartedAt = nowIso()
  let prechartEventId = null
  try {
    prechartEventId = dbEvents.startEvent({ caseId: prechartCaseId, jobKind: 'prechart', modelUsed: model, effort: 'high', startedAt: prechartStartedAt })
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

  const prechartProc = spawnClaude({
    prompt: promptText,
    model,
    effort: 'high',
    tag: '',
    label: `prechart][${patientLabel}`,
    onClose(code, errText, resultText, resultEvent) {
      ctx.stores.jobs.clear()
      cleanupAttachment()
      const durationMs = Date.now() - prechartJobStartMs
      logSkillStream(log, '', `prechart][${patientLabel}`, resultEvent)

      if (CLAUDE_RATE_LIMITED.test(resultText + errText)) {
        if (prechartEventId != null) {
          try { dbEvents.finishEvent(prechartEventId, { status: 'rate_limited', ...extractUsage(resultEvent), errorMessage: 'Claude usage limit reached', finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(prechart) failed: ${e.message}`) }
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
        ctx.renderer.send('service-warning', {
          title: 'Claude usage limit reached',
          message: 'Pre-chart could not complete — try again once the limit resets.'
        })
        return
      }

      if (code === 0) {
        // Parse backup_path from the JSON manifest (B6 migration).
        // Falls back to BACKUP_OK: text marker (older skill) then to filesystem glob.
        let backupPath = null
        const manifest = parseSkillManifest(resultText)
        if (manifest && manifest.skill === 'edit-note' && manifest.backup_path) {
          backupPath = manifest.backup_path
        } else if (/BACKUP_OK:\s*(.+)/.test(resultText)) {
          backupPath = resultText.match(/BACKUP_OK:\s*(.+)/)[1].trim()
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

        if (prechartEventId != null) {
          try { dbEvents.finishEvent(prechartEventId, { status: 'success', ...extractUsage(resultEvent), backupPath, finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(prechart) failed: ${e.message}`) }
        }
        try { dbCases.bumpCaseRevision(prechartCaseId) } catch (e) { log(`[db] prechart bumpRevision failed: ${e.message}`) }

        // Skill overwrites the soap note in place. Diagnoses may have changed,
        // so re-run ICD coding before refreshing the .docx mirror. ICD is
        // best-effort — failures fall through to docx.
        const updatedNote = findExistingSoapNote(caseDir)
        if (updatedNote) {
          runEngine(icdEngine, ctx, {
            caseId: prechartCaseId, caseTag: null, patientFolderName: null,
            soapNoteMdPath: updatedNote, caseDir, doctor: null,
          }).then(() => spawnDocxConversion(updatedNote, null, null, prechartCaseId))
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
        if (prechartEventId != null) {
          try { dbEvents.finishEvent(prechartEventId, { status: 'failed', ...extractUsage(resultEvent), errorMessage: errText.slice(0, 1024), finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(prechart) failed: ${e.message}`) }
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
      ctx.stores.jobs.clear()
      cleanupAttachment()
      if (prechartEventId != null) {
        try { dbEvents.finishEvent(prechartEventId, { status: 'failed', errorMessage: err.message, finishedAt: nowIso() }) } catch (e) { log(`[db] finishEvent(prechart) onError failed: ${e.message}`) }
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
    startedAt: prechartJobStartMs,
    model
  })

  ctx.stores.jobs.start('prechart', prechartProc, prechartEventId)
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

    const { caseDir, folderName } = buildCaseFolder(name)
    const mp3Filename = name ? `${name}.mp3` : 'recording.mp3'
    const mp3Dest = path.join(caseDir, mp3Filename)
    const transcriptDest = path.join(caseDir, 'transcript.md')
    const soapNotePath = path.join(caseDir, `${folderName}_soap_note.md`)

    const { doctorId: _stopDoctorId } = appCtx.stores.session.get()
    const _stopDoctor = dbDoctors.getDoctor(_stopDoctorId) || getAllDoctors().find(d => d.id === _stopDoctorId)
    const _stopTemplatePath = _stopDoctor?.templatePath || null

    if (fs.existsSync(tempMp3Path)) {
      try {
        fs.copyFileSync(tempMp3Path, mp3Dest)
        fs.unlinkSync(tempMp3Path)
        log(`MP3 moved to: ${mp3Dest}`)
      } catch (e) {
        log(`ERROR moving MP3 from ${tempMp3Path} to ${mp3Dest}: ${e.message}`)
        setState(STATE.SESSION_ACTIVE)
        notifyUser('Recording failed', 'Could not save the recording. Check the log.')
        return false
      }
    } else {
      log(`WARNING: temp MP3 not found at ${tempMp3Path} — recording may have failed`)
    }

    // Capture audio metadata before clearing the recorder state
    const capturedDuration = appCtx.stores.recorder.consumePendingDuration()

    // Create the case DB row now that the MP3 is in its final location.
    const { doctorId: _caseDoctorId, sessionId: _caseSessionId } = appCtx.stores.session.get()
    let caseId = null
    try {
      caseId = dbCases.createCase({
        patientName:  name || null,
        doctorId:     _caseDoctorId,
        sessionId:    _caseSessionId,
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

    const { doctorId: _uploadDoctorId, sessionId: _uploadSessionId } = appCtx.stores.session.get()
    const _uploadDoctor = dbDoctors.getDoctor(_uploadDoctorId) || getAllDoctors().find(d => d.id === _uploadDoctorId)
    const _uploadTemplatePath = _uploadDoctor?.templatePath || null

    // Create the case DB row
    let caseId = null
    const audioSizeBytes = fs.existsSync(audioDest) ? fs.statSync(audioDest).size : null
    try {
      caseId = dbCases.createCase({
        patientName:  name || null,
        doctorId:     _uploadDoctorId,
        sessionId:    _uploadSessionId,
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
        appCtx.python,
        [path.join(__dirname, 'python', 'probe_duration.py'), audioDest],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let probeBuf = ''
      probeProc.stdout.on('data', d => { probeBuf += d.toString() })
      probeProc.on('close', code => {
        if (code === 0) {
          const m = probeBuf.match(DURATION_RE)
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
