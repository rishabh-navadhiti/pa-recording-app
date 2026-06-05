'use strict'

const path = require('path')
const { spawn } = require('child_process')

/**
 * Convert a Markdown file to .docx via python/md_to_docx.py.
 *
 * Classifies the .md as 'soap', 'cdi', or 'transcript' by checking the case
 * DB row first (authoritative), then falling back to filename suffix heuristic.
 *
 * - soap:       marks case completed, fires notify, updates soap_docx_path
 * - cdi:        updates cdi_docx_path only (does NOT change case status)
 * - transcript: updates transcript_docx_path only
 *
 * @param {string}     mdPath
 * @param {string}     caseTag
 * @param {string|null} patientFolderName  Non-null for multi-patient children.
 * @param {string|null} caseId
 * @param {AppContext}  ctx
 */
function spawnDocxConversion(mdPath, caseTag, patientFolderName, caseId, ctx) {
  const { log, python, platform, stores } = ctx
  const tag = caseTag ? `[${caseTag}] ` : ''
  log(`${tag}[docx] Converting: ${mdPath}`)

  // ---- classify kind -------------------------------------------------------
  const base = path.basename(mdPath)
  let docxKind = null
  if (caseId) {
    const { dbCases } = requireDb()
    try {
      const row = dbCases.getCaseRow(caseId)
      if (row) {
        if (mdPath === row.cdi_md_path)          docxKind = 'cdi'
        else if (mdPath === row.transcript_path)  docxKind = 'transcript'
        else if (mdPath === row.soap_note_path)   docxKind = 'soap'
      }
    } catch (e) { log(`${tag}[docx] getCaseRow lookup failed: ${e.message}`) }
  }
  if (!docxKind) {
    const fallback = base === 'transcript.md' ? 'transcript' : base.endsWith('_cdi.md') ? 'cdi' : 'soap'
    if (caseId) log(`${tag}[docx] WARNING: falling back to filename heuristic → ${fallback}`)
    docxKind = fallback
  }

  // ---- spawn ---------------------------------------------------------------
  const wallStart = Date.now()
  const { dbEvents, dbCases, dbSessions } = requireDb()
  let eventId = null
  try { eventId = dbEvents.startEvent({ caseId, jobKind: 'docx', startedAt: new Date().toISOString() }) }
  catch (e) { log(`[db] startEvent(docx) failed: ${e.message}`) }

  const appRoot = path.join(__dirname, '..', '..')
  const proc = spawn(python, [path.join(appRoot, 'python', 'md_to_docx.py'), mdPath], { cwd: appRoot, stdio: 'pipe' })

  proc.stdout.on('data', d => log(`${tag}[docx] Saved: ${d.toString().trim()}`))
  proc.stderr.on('data', d => log(`${tag}[docx ERR] ${d.toString().trim()}`))

  proc.on('close', code => {
    log(`${tag}[docx] exited ${code}`)
    const durationMs = Date.now() - wallStart
    const docxPath = mdPath.replace(/\.md$/, '.docx')
    if (code === 0) platform.hideInternal(mdPath)

    if (docxKind === 'soap') {
      if (code === 0) {
        try {
          dbEvents.finishEvent(eventId, { status: 'success', durationMs, finishedAt: new Date().toISOString() })
          dbCases.updateCasePaths(caseId, { status: 'completed', soap_docx_path: docxPath, completed_at: new Date().toISOString() })
          const sessionId = stores.session.get().sessionId
          if (sessionId) dbSessions.bumpSessionCounters(sessionId, { failed: false })
        } catch (e) { log(`[db] docx soap success update failed: ${e.message}`) }

        stores.recordings.setDocxPath(caseTag, docxPath)
        if (patientFolderName) {
          const entry = stores.recordings.getAll().find(r => r.caseTag === caseTag)
          const patient = entry?.patients?.find(p => p.folderName === patientFolderName)
          platform.notify('SOAP note ready', patient?.name || patientFolderName.replace(/_/g, ' '))
          stores.recordings.updatePatientStatus(caseTag, patientFolderName, 'completed')
        } else if (caseTag) {
          const entry = stores.recordings.getAll().find(r => r.caseTag === caseTag)
          platform.notify('SOAP note ready', entry?.displayName || caseTag)
          stores.recordings.updateStatus(caseTag, 'completed')
        }
      } else {
        try {
          dbEvents.finishEvent(eventId, { status: 'failed', durationMs, finishedAt: new Date().toISOString() })
          dbCases.setCaseStatus(caseId, 'failed')
          const sessionId = stores.session.get().sessionId
          if (sessionId) dbSessions.bumpSessionCounters(sessionId, { failed: true })
        } catch (e) { log(`[db] docx soap failure update failed: ${e.message}`) }
        if (patientFolderName) stores.recordings.updatePatientStatus(caseTag, patientFolderName, 'failed')
        else if (caseTag)      stores.recordings.updateStatus(caseTag, 'failed')
      }

    } else if (docxKind === 'cdi') {
      try {
        dbEvents.finishEvent(eventId, { status: code === 0 ? 'success' : 'failed', durationMs, finishedAt: new Date().toISOString() })
        if (code === 0) dbCases.updateCaseCdi(caseId, { cdi_docx_path: docxPath })
      } catch (e) { log(`[db] docx cdi update failed: ${e.message}`) }
      if (code === 0) {
        const cdiUi = { cdiDocxPath: docxPath }
        if (patientFolderName) stores.recordings.setPatientCdi(caseTag, patientFolderName, cdiUi)
        else if (caseTag)      stores.recordings.setCdi(caseTag, cdiUi)
      }

    } else {
      try {
        dbEvents.finishEvent(eventId, { status: code === 0 ? 'success' : 'failed', durationMs, finishedAt: new Date().toISOString() })
        if (code === 0) dbCases.updateCasePaths(caseId, { transcript_docx_path: docxPath })
      } catch (e) { log(`[db] docx transcript update failed: ${e.message}`) }
    }
  })

  proc.on('error', err => log(`${tag}[docx ERR] failed to spawn md_to_docx: ${err.message}`))
}

let _db = null
function requireDb() {
  if (!_db) _db = {
    dbEvents:   require('../../db/events'),
    dbCases:    require('../../db/cases'),
    dbSessions: require('../../db/sessions'),
  }
  return _db
}

module.exports = { spawnDocxConversion }
