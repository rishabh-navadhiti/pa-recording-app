'use strict'

const path = require('path')
const cp   = require('child_process')

/**
 * @typedef {Object} Platform
 * @property {() => boolean} isStaging
 * @property {() => {cmd: string, version: string}|null} resolvePython
 * @property {(filePath: string) => void} hideInternal
 * @property {(notesDir: string) => void} hideNotesDirInternals
 * @property {(casesDir: string) => void} hideExistingCaseMdFiles
 * @property {(title: string, body: string) => void} notify
 */

/**
 * Create the platform adapter for the current OS.
 *
 * @param {object} [opts]
 * @param {string}   [opts.stagingMarkerPath]  Path to .staging-marker (injectable for tests).
 * @param {Function} [opts.execSync]           child_process.execSync replacement (injectable).
 * @param {Function} [opts.exec]               child_process.exec replacement (injectable).
 * @param {Function} [opts.log]                Logger for hide-error messages.
 * @returns {Platform}
 */
function createPlatform(opts = {}) {
  const {
    stagingMarkerPath = path.join(__dirname, '..', '.staging-marker'),
    execSync = cp.execSync,
    exec = cp.exec,
    log,
  } = opts

  const mod = process.platform === 'win32'
    ? require('./windows')
    : require('./macos')

  return {
    isStaging:               () => mod.isStaging(stagingMarkerPath),
    resolvePython:           () => mod.resolvePython(execSync),
    hideInternal:            (p) => mod.hideInternal(p, exec, log),
    hideNotesDirInternals:   (d) => mod.hideNotesDirInternals(d, exec, log),
    hideExistingCaseMdFiles: (d) => mod.hideExistingCaseMdFiles(d, exec, log),
    notify:                  (title, body) => mod.notify(title, body),
  }
}

module.exports = { createPlatform }
