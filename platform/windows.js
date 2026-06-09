'use strict'

const fs   = require('fs')
const path = require('path')

function isStaging(markerPath) {
  try { return fs.existsSync(markerPath) } catch { return false }
}

function resolvePython(execSyncFn) {
  for (const cmd of ['py', 'python', 'python3']) {
    try {
      const out = execSyncFn(`${cmd} --version`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
      if (/^Python\s+3\./.test(out)) return { cmd, version: out }
    } catch { /* not available — try next */ }
  }
  return null
}

function hideInternal(filePath, execFn, logFn) {
  execFn(`attrib +h "${filePath}"`, err => {
    if (err && logFn) logFn(`[hide] ${path.basename(filePath)}: ${err.message}`)
  })
}

function hideNotesDirInternals(notesDir, execFn, logFn) {
  if (!fs.existsSync(notesDir)) return
  try {
    fs.readdirSync(notesDir, { withFileTypes: true })
      .filter(e => e.name !== 'Cases')
      .forEach(e => hideInternal(path.join(notesDir, e.name), execFn, logFn))
  } catch {}
}

function hideExistingCaseMdFiles(casesDir, execFn, logFn) {
  if (!fs.existsSync(casesDir)) return
  try {
    // Two-level: casesDir/<session>/<case>/
    const sessions = fs.readdirSync(casesDir, { withFileTypes: true }).filter(e => e.isDirectory())
    for (const session of sessions) {
      const sessionPath = path.join(casesDir, session.name)
      try {
        const cases = fs.readdirSync(sessionPath, { withFileTypes: true }).filter(e => e.isDirectory())
        for (const c of cases) {
          const caseDir = path.join(sessionPath, c.name)
          try {
            fs.readdirSync(caseDir)
              .filter(f => f.endsWith('.md') || f.endsWith('_cdi.json'))
              .forEach(f => hideInternal(path.join(caseDir, f), execFn, logFn))
          } catch {}
        }
      } catch {}
    }
  } catch {}
}

function notify(title, body) {
  try {
    const { Notification } = require('electron')
    if (Notification.isSupported()) new Notification({ title, body, silent: false }).show()
  } catch { /* no Electron context — swallow */ }
}

module.exports = { isStaging, resolvePython, hideInternal, hideNotesDirInternals, hideExistingCaseMdFiles, notify }
