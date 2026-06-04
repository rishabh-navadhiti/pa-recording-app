'use strict'

const fs   = require('fs')
const path = require('path')
const cp   = require('child_process')

// Authoritative MCP config — written to <NOTES_DIR>/.mcp.json on every skills
// sync so `claude -p` (cwd: NOTES_DIR) always sees the ICD-10 connector.
// Kept here (not in notes-claude/.mcp.json) as the single JS source so both
// the sync and any future validation share the same object.
const MCP_CONFIG = Object.freeze({
  mcpServers: {
    icd10: {
      type: 'http',
      url: 'https://hcls.mcp.claude.com/icd10_codes/mcp'
    }
  }
})

/**
 * Write .mcp.json to notesDir, using the fast-path content-equality check
 * to avoid Windows EPERM on hidden files during every launch.
 *
 * @param {string} notesDir
 * @param {Function} [hideFile]  Platform hide helper — no-op when omitted.
 * @param {Function} [log]       Logger — console.error fallback when omitted.
 */
function writeMcpConfig(notesDir, hideFile, log) {
  if (!notesDir) return
  const _log  = log  || ((msg) => console.error(msg))
  const _hide = hideFile || (() => {})

  const target  = path.join(notesDir, '.mcp.json')
  const desired = JSON.stringify(MCP_CONFIG, null, 2) + '\n'

  // Fast path: skip write if content already matches — avoids EPERM on
  // hidden files on Windows during every subsequent launch.
  try {
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === desired) return
  } catch { /* fall through */ }

  // Clear hidden attribute before writing on Windows.
  if (process.platform === 'win32' && fs.existsSync(target)) {
    try { cp.execSync(`attrib -h "${target}"`) } catch { /* best effort */ }
  }
  try {
    fs.writeFileSync(target, desired)
    _hide(target)
  } catch (err) {
    _log(`[mcp] failed to write .mcp.json: ${err.message}`)
  }
}

module.exports = { writeMcpConfig, MCP_CONFIG }
