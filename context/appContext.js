'use strict'

const path = require('path')
const child_process = require('child_process')

const { createLogger, bootstrapLogger } = require('../log/logger')
const { createPaths }         = require('../config/paths')
const { createSettingsStore } = require('../config/settings')
const { createSecretStore }   = require('../config/secrets')
const { createJobStateStore } = require('../config/jobState')
const { createPlatform }      = require('../platform/index')
const { createStateMachine }  = require('./stateMachine')
const { createSessionStore }  = require('./sessionStore')
const { createRecordingsStore } = require('./recordingsStore')
const { createRecorderController } = require('./recorderController')
const { createJobRunner }     = require('../jobs/jobRunner')
const { createClaudeCliProvider } = require('../src/llm/claudeCliProvider')

/**
 * Atomic file write with EPERM/EBUSY retry (shared across config modules).
 * Defined here so config modules don't need to duplicate it.
 */
function safeWrite(filePath, data) {
  const fs = require('fs')
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
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60)
      } else break
    }
  }
  throw lastErr
}

/**
 * Build the app context.
 *
 * The context is created in two phases:
 *  1. createPreWindowContext(notesDir)  — pure config + stores; no Electron windows.
 *  2. ctx.attachWindows({ renderer, statusSend })  — called after windows are created.
 *
 * This split is necessary because BrowserWindow requires app.whenReady() to
 * have fired, while the stores can be built before the window is shown.
 *
 * @param {string} notesDir  Resolved notes directory path.
 * @returns {AppContext}
 */
function createAppContext(notesDir) {
  // ---- paths ----------------------------------------------------------------
  const paths = createPaths(notesDir)

  // ---- logger ---------------------------------------------------------------
  const logger = createLogger(paths.logFile)
  const log = (msg) => logger.log(msg)

  // ---- platform -------------------------------------------------------------
  const platform = createPlatform({
    stagingMarkerPath: path.join(__dirname, '..', '.staging-marker'),
    execSync: child_process.execSync,
    exec: child_process.exec,
    log,
  })

  // ---- config ---------------------------------------------------------------
  const config  = createSettingsStore(paths.settingsPath)
  const secrets = createSecretStore(path.join(__dirname, '..', '.env'))
  const jobState = createJobStateStore(paths.templateJobStatePath, safeWrite)

  // ---- database (opened later by bootstrap, after initDb) -------------------
  // db is set by bootstrap after initDb() succeeds.
  let _db = null

  // ---- renderer send facade (set by attachWindows) -------------------------
  let _renderer = { send() {} }       // no-op until window created
  let _statusSend = () => {}

  // ---- stores ---------------------------------------------------------------
  const stateStore = createStateMachine({
    onChange: (s) => _renderer.send('state-change', s)
  })

  const recordings = createRecordingsStore({
    onChange: (payload) => {
      _renderer.send('recording-status-update', payload)
      _statusSend('recording-status-update', payload)
    }
  })

  const session  = createSessionStore()
  const recorder = createRecorderController()
  const jobRunner = createJobRunner({ jobState, log })

  // LLM provider — claudeCliProvider (arg-array spawn, no shell:true).
  // cwd is set to notesDir so skills run with the right working directory.
  // Replaced by a future agentSdkProvider.js by swapping this one line.
  const llm = createClaudeCliProvider({ cwd: notesDir, log })

  // ---- context object -------------------------------------------------------
  const ctx = {
    paths,
    log,
    logger,
    platform,
    config,
    secrets,
    jobState,
    llm,

    get db() { return _db },
    setDb(db) { _db = db },

    stores: {
      state:      stateStore,
      session,
      recordings,
      recorder,
      jobs:       jobRunner,
    },

    /** The guarded renderer send facade — safe to call when window is closed. */
    get renderer() { return _renderer },

    /** Send to the status window (no-op until status window is opened). */
    sendStatus(channel, ...args) { _statusSend(channel, ...args) },

    /**
     * Called from bootstrap after the main window is created.
     * @param {{ send(channel, ...args): void }} rendererFacade
     * @param {Function} statusSendFn
     */
    attachWindows(rendererFacade, statusSendFn) {
      _renderer   = rendererFacade
      _statusSend = statusSendFn || (() => {})
    },
  }

  return ctx
}

module.exports = { createAppContext }
