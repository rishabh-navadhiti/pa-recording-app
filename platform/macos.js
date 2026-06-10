'use strict'

// macOS platform stubs. isStaging and resolvePython work the same way as
// Windows (file-check and exec probing). Hide functions are no-ops until
// Phase 7 defines the mac "hide internals" convention (B9).

function isStaging(markerPath) {
  const fs = require('fs')
  try { return fs.existsSync(markerPath) } catch { return false }
}

function resolvePython(execSyncFn) {
  for (const cmd of ['python3', 'python']) {
    try {
      const out = execSyncFn(`${cmd} --version`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
      if (/^Python\s+3\./.test(out)) return { cmd, version: out }
    } catch { /* try next */ }
  }
  return null
}

// macOS has no attrib +h. Phase 7 will decide the convention (dot-prefix /
// hidden subfolder / nothing). For now, no-op so mac dev machines see all files.
function hideInternal(_filePath, _execFn, _logFn) {}
function hideNotesDirInternals(_notesDir, _execFn, _logFn) {}
function hideExistingCaseMdFiles(_casesDir, _execFn, _logFn) {}

function notify(title, body) {
  try {
    const { Notification } = require('electron')
    if (Notification.isSupported()) new Notification({ title, body, silent: false }).show()
  } catch { /* no Electron context */ }
}

module.exports = { isStaging, resolvePython, hideInternal, hideNotesDirInternals, hideExistingCaseMdFiles, notify }
