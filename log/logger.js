'use strict'

const fs = require('fs')

// Patterns whose matches are redacted before writing to disk.
// Goal: strip case-folder slugs (the highest-density PII in app.log) so
// patient names don't persist in a plaintext log file beside clinical notes.
// Doctor-name redaction requires the live doctors list and is added in Phase 3
// when the logger has access to the DB layer.
const PII_PATTERNS = [
  // Case folder slug: name_name_YYYY-MM-DD or name_YYYY-MM-DD
  /\b[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)+_\d{4}-\d{2}-\d{2}\b/gi,
]

function redact(text) {
  if (!text) return text
  let out = String(text)
  for (const pat of PII_PATTERNS) out = out.replace(pat, '[case]')
  return out
}

/**
 * Create a logger instance.
 *
 * @param {string|null} logFilePath  Absolute path to app.log.
 *   Pass null for a stdout-only bootstrap logger (used before paths are known).
 * @returns {{ log: Function, info: Function, warn: Function, error: Function, redact: Function }}
 */
function createLogger(logFilePath) {
  function write(level, msg) {
    const line = `[${new Date().toISOString()}] [${level}] ${redact(msg)}\n`
    process.stdout.write(line)
    if (logFilePath) {
      try { fs.appendFileSync(logFilePath, line) } catch (_) {}
    }
  }

  return {
    log:    (msg) => write('INFO', msg),
    info:   (msg) => write('INFO', msg),
    warn:   (msg) => write('WARN', msg),
    error:  (msg) => write('ERROR', msg),
    redact,
  }
}

// A stdout-only bootstrap logger used before paths are known.
// Replaced by a real logger once the notes dir is available.
const bootstrapLogger = createLogger(null)

module.exports = { createLogger, bootstrapLogger, redact }
