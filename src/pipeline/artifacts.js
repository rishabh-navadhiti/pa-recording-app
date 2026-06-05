'use strict'

const path = require('path')
const fs   = require('fs')

// ---------------------------------------------------------------------------
// Name sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a patient or doctor name to a safe filesystem slug.
 * Returns null for empty/null input.
 */
function sanitizeName(name) {
  if (!name) return null
  const result = name.trim().toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '')
  return result || null
}

/**
 * Extract the lastname portion from a full doctor name, stripping prefixes
 * (Dr., Mr., Ms., Mrs., Prof.) and keeping only the last word.
 */
function extractLastname(fullName) {
  if (!fullName) return null
  const stripped = fullName.trim().replace(/^(dr\.?|mr\.?|ms\.?|mrs\.?|prof\.?)\s*/i, '')
  const parts = stripped.trim().split(/\s+/)
  return sanitizeName(parts[parts.length - 1])
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Convert an absolute path to a forward-slash relative path from notesDir.
 * Used everywhere skills expect a relative path in their prompts.
 */
function relForSkill(absPath, notesDir) {
  return path.relative(notesDir, absPath).replace(/\\/g, '/')
}

/**
 * Canonical paths for a CDI run given a case folder and file stem.
 */
function cdiPaths(caseDir, stem) {
  return {
    jsonPath: path.join(caseDir, `${stem}_cdi.json`),
    mdPath:   path.join(caseDir, `${stem}_cdi.md`),
    docxPath: path.join(caseDir, `${stem}_cdi.docx`),
  }
}

/**
 * Derive the file stem for a case from the SOAP note filename.
 * E.g. 'jane_doe_2026-06-04_soap_note.md' → 'jane_doe_2026-06-04'
 */
function caseStemFromSoapMd(soapMdPath) {
  return path.basename(soapMdPath).replace(/_soap_note\.md$/, '')
}

// ---------------------------------------------------------------------------
// Case folder creation
// ---------------------------------------------------------------------------

/**
 * Build (and create) a case folder under the current session directory.
 * Reads session.dir from ctx; falls back to casesDir when no session active.
 *
 * @param {string|null} sanitizedName  Slug from sanitizeName().
 * @param {AppContext}  ctx
 * @returns {{ caseDir: string, folderName: string }}
 */
function buildCaseFolder(sanitizedName, ctx) {
  const datestamp = new Date().toISOString().slice(0, 10)
  const folderName = sanitizedName
    ? `${sanitizedName}_${datestamp}`
    : `recording_${datestamp}_${new Date().toISOString().slice(11, 19).replace(/:/g, '-')}`
  const baseDir = ctx.stores.session.get().dir || ctx.paths.casesDir
  const caseDir = path.join(baseDir, folderName)
  fs.mkdirSync(caseDir, { recursive: true })
  return { caseDir, folderName }
}

/**
 * Create the session-level date folder inside casesDir.
 * Handles same-day collisions with (2), (3) suffixes.
 */
function createSessionFolder(ctx) {
  const casesDir = ctx.paths.casesDir
  const datestamp = new Date().toISOString().slice(0, 10)
  let todayCount = 0
  try {
    todayCount = fs.readdirSync(casesDir)
      .filter(n => n === datestamp || n.startsWith(`${datestamp}(`)).length
  } catch {}
  const folderName = todayCount === 0 ? datestamp : `${datestamp}(${todayCount + 1})`
  const sessionDir = path.join(casesDir, folderName)
  fs.mkdirSync(sessionDir, { recursive: true })
  return sessionDir
}

module.exports = { sanitizeName, extractLastname, relForSkill, cdiPaths, caseStemFromSoapMd, buildCaseFolder, createSessionFolder }
