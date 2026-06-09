'use strict'

const { getDb } = require('./init')

/**
 * Thin try/catch wrapper for DB operations that must not crash the pipeline.
 * Logs on failure, returns `fallback` (default: null).
 *
 * @param {string}   label    - tag included in the error log line
 * @param {Function} fn       - receives the live db instance; its return value is returned
 * @param {*}        fallback - returned when fn throws or db is null (default: null)
 */
function withDb(label, fn, fallback = null) {
  const db = getDb()
  if (!db) return fallback
  try {
    return fn(db)
  } catch (e) {
    console.error(`[db] ${label} failed: ${e.message}`)
    return fallback
  }
}

module.exports = { withDb }
