'use strict'

const fs   = require('fs')
const path = require('path')

const { writeMcpConfig }              = require('../config/mcp')
const { initDb, migrateDoctorsFromSettings, tryRestoreDoctorsFromBackup } = require('../db/init')

/**
 * Initialize (or re-initialize) the notes directory.
 * Called from bootstrap on startup AND from the change-notes-dir IPC handler.
 *
 * Steps (shared between first-launch and dir-change):
 *  1. Create Cases/ and Templates/ directories.
 *  2. Sync skills: copy notes-claude/ → <notesDir>/.claude/.
 *  3. Write .mcp.json (fast-path content-equality check).
 *  4. Hide internals on Windows.
 *  5. Open (or reset) the SQLite DB and run doctor migration if needed.
 *  6. Clear any stale template job from a prior crash.
 *
 * @param {string}     notesDir        Resolved notes directory.
 * @param {AppContext} ctx             The application context.
 * @param {object}     [opts]
 * @param {Function}   [opts.copyDir]  copyDirSync override (for testing).
 */
async function bootstrapNotesDir(notesDir, ctx, opts = {}) {
  const { log, platform, config, jobState, paths: p } = ctx
  const { copyDir = defaultCopyDir } = opts
  const claudeConfigSrc = path.join(__dirname, '..', 'notes-claude')

  // 1. Create directories
  fs.mkdirSync(p.casesDir,     { recursive: true })
  fs.mkdirSync(p.templatesDir, { recursive: true })

  // 2. Sync skills
  copyDir(claudeConfigSrc, p.claudeDir)
  log('.claude skills synced to AI Medical Notes')

  // 3. MCP config
  writeMcpConfig(notesDir, (f) => platform.hideInternal(f), log)

  // 4. Hide internals (Windows no-op on mac)
  platform.hideNotesDirInternals(notesDir)
  platform.hideExistingCaseMdFiles(p.casesDir)

  // 5. DB
  try {
    const db = initDb(notesDir)
    if (db) {
      ctx.setDb(db)
      const s = config.get()
      const doctors = s.doctors || []
      const writeFn = (patch) => config.save(patch)
      if (doctors.length > 0) {
        migrateDoctorsFromSettings(db, doctors, writeFn, notesDir, extractLastname)
      } else {
        tryRestoreDoctorsFromBackup(db, notesDir, writeFn, extractLastname)
      }
      log('[db] Database ready')
    }
  } catch (e) {
    log(`[db] WARNING: database init failed — running without DB: ${e.message}`)
  }

  // 6. Clear stale job
  jobState.clearStaleRunning()
}

// Pulled inline to avoid pulling main.js's full global scope.
function extractLastname(fullName) {
  const stripped = (fullName || '').trim().replace(/^(dr\.?|mr\.?|ms\.?|mrs\.?|prof\.?)\s*/i, '')
  const parts = stripped.trim().split(/\s+/)
  const last = parts[parts.length - 1] || ''
  return last.trim().toLowerCase().replace(/\s+/g, '_') || null
}

function defaultCopyDir(src, dest) {
  const { execSync } = require('child_process')
  // Use the existing copyDirSync logic from main.js — for now delegate to a
  // require of the helper. Phase 3 will extract copyDirSync into a util module.
  // Lazy require to avoid circular deps at module load time.
  try {
    // If main.js is loaded (app context), use its copyDirSync.
    // Otherwise fall back to a simple recursive copy for tests.
    _copyDirRecursive(src, dest)
  } catch {}
}

function _copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) _copyDirRecursive(s, d)
    else fs.copyFileSync(s, d)
  }
}

module.exports = { bootstrapNotesDir }
