'use strict'

const path = require('path')
const { spawn } = require('child_process')

/**
 * After a git pull that brought new commits: run npm install (picks up new/changed
 * deps) then electron-rebuild (recompiles better-sqlite3 for this Electron ABI).
 * Always calls onDone() — failure is logged but non-fatal; the safety net in
 * bootstrap() shows a recovery dialog if the user restarts too early.
 *
 * @param {string}   appRoot  Repo root (main.js __dirname) — npm/electron-rebuild cwd.
 * @param {Function} log
 * @param {Function} onDone
 */
function runPostUpdateSetup(appRoot, log, onDone) {
  const isWin = process.platform === 'win32'

  log('[update] Running npm install...')
  const npmProc = spawn('npm', ['install', '--no-audit', '--silent'], { cwd: appRoot, stdio: 'pipe', shell: isWin })
  let npmStderr = ''
  npmProc.stderr.on('data', d => { npmStderr += d.toString() })
  npmProc.on('error', err => { log(`[update] npm install error: ${err.message}`); onDone() })
  npmProc.on('close', code => {
    if (code !== 0) {
      log(`[update] npm install failed (exit ${code}): ${npmStderr.trim()}`)
      onDone()
      return
    }
    log('[update] npm install OK — rebuilding native modules for Electron...')

    const rebuildBin = path.join(appRoot, 'node_modules', '.bin', isWin ? 'electron-rebuild.cmd' : 'electron-rebuild')
    // Quote rebuildBin: default install paths contain spaces (e.g.
    // "AI Medical Scribe (Staging)"), and with shell:true an unquoted path is
    // split on the first space — cmd.exe then tries to run "...\Programs\AI".
    const rebuildProc = spawn(`"${rebuildBin}" -f -w better-sqlite3`, [], { cwd: appRoot, stdio: 'pipe', shell: true })
    let rebuildLog = ''
    rebuildProc.stdout.on('data', d => { rebuildLog += d.toString() })
    rebuildProc.stderr.on('data', d => { rebuildLog += d.toString() })
    rebuildProc.on('error', err => { log(`[update] electron-rebuild not found or failed to start: ${err.message}`); onDone() })
    rebuildProc.on('close', rCode => {
      if (rCode !== 0) log(`[update] electron-rebuild failed (exit ${rCode}): ${rebuildLog.trim()}`)
      else log('[update] Native modules rebuilt OK')
      onDone()
    })
  })
}

/**
 * Auto-update: git pull --ff-only on launch. If new commits land, re-sync skills
 * + .mcp.json, run post-update setup, and notify the user to restart.
 * Non-blocking, never throws — failures are logged and ignored.
 *
 * NOTE: this whole git-pull model is replaced by electron-updater in Phase 6.
 * Extracted here so that swap is a single-file change.
 *
 * @param {AppContext} ctx
 * @param {object} deps
 * @param {string}   deps.appRoot         Repo root (main.js __dirname).
 * @param {Function} deps.copyDirSync     Recursive dir copy.
 * @param {Function} deps.writeMcpConfig  Writes .mcp.json from notes-claude.
 */
function checkForUpdates(ctx, { appRoot, copyDirSync, writeMcpConfig }) {
  const log = (m) => (ctx && ctx.log ? ctx.log(m) : console.log(m))

  const gitPull = spawn('git', ['pull', '--ff-only'], { cwd: appRoot, stdio: 'pipe', shell: process.platform === 'win32' })
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
    if (output === 'Already up to date.') return

    // New commits — re-sync skills immediately from updated code.
    const notesDir = ctx?.paths?.notesDir
    if (notesDir) {
      copyDirSync(path.join(appRoot, 'notes-claude'), path.join(notesDir, '.claude'))
      writeMcpConfig(notesDir, p => ctx?.platform?.hideInternal(p), log)
      log('[update] Skills re-synced from updated code')
    }

    runPostUpdateSetup(appRoot, log, () => {
      const stagingTag = ctx?.platform?.isStaging() ? ' (staging)' : ''
      if (ctx?.tray) ctx.tray.setToolTip(`AI Medical Scribe${stagingTag} — updated, restart to apply`)
      log('[update] Notifying user to restart')
      const { Notification } = require('electron')
      if (Notification.isSupported()) {
        new Notification({ title: `AI Medical Scribe${stagingTag} updated`, body: 'A new version was downloaded. Restart the app to apply it.', silent: true }).show()
      }
    })
  })

  gitPull.on('error', err => log(`[update] git not found or failed: ${err.message}`))
}

module.exports = { checkForUpdates, runPostUpdateSetup }
