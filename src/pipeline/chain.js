'use strict'

const fs   = require('fs')
const path = require('path')

const { runEngine } = require('../engines/engineRunner')
const icd = require('../engines/icd')
const cdi = require('../engines/cdi')
const { spawnDocxConversion } = require('./docx')
const { planChildCases, materializeChild } = require('./multiPatient')

// ---- Single-patient post-SOAP chain ----------------------------------------

/**
 * Run the per-case post-processing chain after SOAP generation:
 *   ICD coding → CDI review → docx(soap) → docx(cdi)
 *
 * Best-effort: each step resolves cleanly on failure; the chain always
 * continues. docx conversion is a fixed post-step, NOT an engine.
 *
 * @param {AppContext}  ctx
 * @param {CaseContext} caseCtx  Must include: caseId, caseTag, soapNoteMdPath,
 *                               patientFolderName, doctor, caseDir.
 * @param {Function}    spawnDocx  spawnDocxConversion(mdPath, caseTag, folder, caseId)
 */
async function runCaseChain(ctx, caseCtx) {
  const { caseTag, caseId, soapNoteMdPath, patientFolderName } = caseCtx

  // ICD → CDI (sequential: CDI needs ICD codes in the note)
  await runEngine(icd, ctx, caseCtx)
  const cdiResult = await runEngine(cdi, ctx, caseCtx)

  // Status update → converting
  if (patientFolderName) {
    ctx.stores.recordings.updatePatientStatus(caseTag, patientFolderName, 'converting')
  } else if (caseTag) {
    ctx.stores.recordings.updateStatus(caseTag, 'converting')
  }

  // Docx: SOAP (soap.completesCase → this marks the case 'completed')
  spawnDocxConversion(soapNoteMdPath, caseTag, patientFolderName || null, caseId, ctx)

  // Docx: CDI (if CDI produced a .md — does NOT change case status)
  const cdiMdPath = cdiResult?.manifest?.md_path || null
  if (cdiMdPath && fs.existsSync(cdiMdPath)) {
    spawnDocxConversion(cdiMdPath, caseTag, patientFolderName || null, caseId, ctx)
  }
}

// ---- Multi-patient post-SOAP chain -----------------------------------------

/**
 * Run the multi-patient post-SOAP chain.
 * For each planned child case: materialize the folder, run ICD → CDI → docx
 * sequentially (one child at a time — MCP/quota reasons).
 *
 * @param {AppContext} ctx
 * @param {object}     opts
 * @param {string}     opts.caseTag
 * @param {string}     opts.parentCaseId
 * @param {object}     opts.manifest        Parsed SOAP manifest (multi_patient: true)
 * @param {string}     opts.recordingFolder  Absolute path to the recording folder
 * @param {object}     opts.doctor           Doctor record for the session
 * @param {Function}   spawnDocx
 */
async function runMultiPatientChain(ctx, opts) {
  const { caseTag, parentCaseId, manifest, recordingFolder, doctor } = opts
  const tag = caseTag ? `[${caseTag}] ` : ''
  const log = ctx.log
  const { dbCases, dbSessions } = requireDb()

  log(`${tag}[soap] Multi-patient manifest: ${manifest.cases.length} cases declared`)

  const sessionDir = path.dirname(recordingFolder)
  const datestamp  = new Date().toISOString().slice(0, 10)

  // Inherit parent DB fields.
  let parentRecordedAt = new Date().toISOString()
  let parentDoctorId   = ctx.stores.session.get().doctorId
  let parentMp3Path    = null
  try {
    const row = dbCases.getCaseRow(parentCaseId)
    if (row) {
      parentRecordedAt = row.recorded_at || parentRecordedAt
      parentDoctorId   = row.doctor_id   || parentDoctorId
      parentMp3Path    = row.mp3_path    || null
    }
  } catch (e) { log(`[db] getCaseRow(parent) failed: ${e.message}`) }

  if (!parentMp3Path) {
    try {
      const found = fs.readdirSync(recordingFolder).find(f => f.toLowerCase().endsWith('.mp3'))
      if (found) parentMp3Path = path.join(recordingFolder, found)
    } catch {}
  }

  // Sanitize helper — imported lazily to avoid circular dependency on main.js.
  const sanitizeName = requireSanitizeName()

  const planned = planChildCases(manifest.cases, sessionDir, datestamp, sanitizeName)

  // Publish the full patient list to the status UI BEFORE any per-child await.
  const patientsUi = planned.map(p => ({
    name: p.c.patient_name || p.slug.replace(/_/g, ' '),
    folderName: p.folderName,
    status: 'queued'
  }))
  if (caseTag) ctx.stores.recordings.setPatients(caseTag, patientsUi)

  const parentTranscript     = path.join(recordingFolder, 'transcript.md')
  const parentTranscriptDocx = path.join(recordingFolder, 'transcript.docx')

  let childrenCreated = 0

  for (const p of planned) {
    const { i, c, slug, folderName, targetDir } = p
    const labelName = c.patient_name || `unknown_${i + 1}`

    try { fs.mkdirSync(targetDir, { recursive: true }) }
    catch (e) {
      log(`${tag}[soap] case ${i + 1} (${labelName}): mkdir failed: ${e.message}`)
      ctx.stores.recordings.updatePatientStatus(caseTag, folderName, 'failed')
      continue
    }

    // Copy MP3
    let childMp3 = null
    if (parentMp3Path && fs.existsSync(parentMp3Path)) {
      childMp3 = path.join(targetDir, `${slug}.mp3`)
      try { fs.copyFileSync(parentMp3Path, childMp3) }
      catch (e) { log(`${tag}[soap] case ${i + 1}: mp3 copy failed: ${e.message}`); childMp3 = null }
    }

    // Copy transcript.md + transcript.docx
    try { if (fs.existsSync(parentTranscript)) fs.copyFileSync(parentTranscript, path.join(targetDir, 'transcript.md')) }
    catch (e) { log(`${tag}[soap] case ${i + 1}: transcript.md copy failed: ${e.message}`) }

    let transcriptDocxOk = false
    const childTranscriptDocx = path.join(targetDir, 'transcript.docx')
    try {
      if (fs.existsSync(parentTranscriptDocx)) { fs.copyFileSync(parentTranscriptDocx, childTranscriptDocx); transcriptDocxOk = true }
    } catch (e) { log(`${tag}[soap] case ${i + 1}: transcript.docx copy failed: ${e.message}`) }

    // Copy SOAP .md → child folder with child-folder naming
    const childSoapMd = path.join(targetDir, `${folderName}_soap_note.md`)
    try { fs.copyFileSync(c.soap_note_md, childSoapMd) }
    catch (e) {
      log(`${tag}[soap] case ${i + 1}: soap .md copy failed: ${e.message}`)
      ctx.stores.recordings.updatePatientStatus(caseTag, folderName, 'failed')
      continue
    }

    // Hide the audit .md (recording folder) on Windows
    ctx.platform.hideInternal(c.soap_note_md)

    // Insert child cases row
    let childCaseId = null
    try {
      childCaseId = dbCases.createCase({
        patientName:  c.patient_name || null,
        doctorId:     parentDoctorId,
        sessionId:    ctx.stores.session.get().sessionId,
        caseDir:      targetDir,
        source:       'recording',
        mp3Path:      childMp3 || null,
        recordedAt:   parentRecordedAt,
      })
      if (childCaseId) {
        dbCases.updateCasePaths(childCaseId, {
          status:               'converting',
          soap_note_path:       childSoapMd,
          transcript_path:      fs.existsSync(path.join(targetDir, 'transcript.md')) ? path.join(targetDir, 'transcript.md') : null,
          transcript_docx_path: transcriptDocxOk ? childTranscriptDocx : null,
        })
      }
    } catch (e) { log(`${tag}[db] createCase(child ${i + 1}) failed: ${e.message}`) }

    childrenCreated++

    // Per-child caseCtx for the engine runner
    const childCaseCtx = {
      caseId:            childCaseId,
      caseTag,
      patientFolderName: folderName,
      doctor,
      soapNoteMdPath:    childSoapMd,
      caseDir:           targetDir,
    }

    // ICD → CDI → docx (sequential across children — MCP/quota reasons)
    await runCaseChain(ctx, childCaseCtx)
  }

  // Mark parent as audit row (completed, soap_note_path=NULL)
  try {
    dbCases.updateCasePaths(parentCaseId, {
      status:         'completed',
      soap_note_path: null,
      completed_at:   new Date().toISOString(),
    })
    dbSessions.bumpSessionCounters(ctx.stores.session.get().sessionId, { failed: false })
  } catch (e) { log(`[db] parent audit-row update failed: ${e.message}`) }

  if (caseTag) ctx.stores.recordings.updateStatus(caseTag, 'completed')
  log(`${tag}[soap] multi-patient complete: ${childrenCreated}/${planned.length} children created`)
}

// Lazy-require to avoid circular deps.
let _db = null
function requireDb() {
  if (!_db) {
    _db = {
      dbCases:    require('../../db/cases'),
      dbSessions: require('../../db/sessions'),
    }
  }
  return _db
}

let _sanitize = null
function requireSanitizeName() {
  if (!_sanitize) {
    // The sanitizeName function is in main.js — import it lazily via a small
    // inline version here so chain.js has no dependency on main.js.
    _sanitize = function sanitizeName(name) {
      if (!name) return null
      return name.trim().toLowerCase().replace(/\s+/g, '_')
    }
  }
  return _sanitize
}

module.exports = { runCaseChain, runMultiPatientChain, planChildCases }
