'use strict'

const path = require('path')

/**
 * Build the canonical paths object from a resolved notes directory.
 *
 * @param {string} notesDir  Absolute path to ~/Documents/AI Medical Notes (or user-chosen).
 * @returns {Readonly<{
 *   notesDir: string,
 *   casesDir: string,
 *   templatesDir: string,
 *   logFile: string,
 *   claudeDir: string,
 *   mcpJsonPath: string,
 *   templateJobStatePath: string,
 *   settingsPath: string,
 *   doctorBackupPath: string,
 * }>}
 */
function createPaths(notesDir) {
  return Object.freeze({
    notesDir,
    casesDir:             path.join(notesDir, 'Cases'),
    templatesDir:         path.join(notesDir, 'Templates'),
    logFile:              path.join(notesDir, 'app.log'),
    claudeDir:            path.join(notesDir, '.claude'),
    mcpJsonPath:          path.join(notesDir, '.mcp.json'),
    templateJobStatePath: path.join(notesDir, '.template_job.json'),
    settingsPath:         path.join(notesDir, 'settings.json'),
    doctorBackupPath:     path.join(notesDir, 'settings.doctors.backup.json'),
  })
}

module.exports = { createPaths }
