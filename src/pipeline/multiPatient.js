'use strict'

const fs   = require('fs')
const path = require('path')

/**
 * Plan child-case targets from a multi-patient SOAP manifest.
 * PURE — no filesystem I/O; suitable for unit testing with an injected existsFn.
 *
 * For each manifest case that is ok and whose soap_note_md exists on disk,
 * computes a collision-safe child folder name and target directory.
 *
 * @param {object[]}  cases         manifest.cases array
 * @param {string}    sessionDir    Parent directory where child folders will go.
 * @param {string}    datestamp     'YYYY-MM-DD' string for folder names.
 * @param {Function}  sanitizeName  sanitizeName(name) → slug string | null
 * @param {Function}  [existsFn]    fs.existsSync replacement (injectable for tests)
 * @returns {Array<{i, c, slug, folderName, targetDir}>}
 */
function planChildCases(cases, sessionDir, datestamp, sanitizeName, existsFn = fs.existsSync) {
  const slugsUsed = new Set()
  const planned   = []

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]
    if (c.status === 'failed' || !c.soap_note_md || !existsFn(c.soap_note_md)) continue

    let baseSlug = sanitizeName(c.patient_name) || `unknown_${i + 1}`
    let slug = baseSlug; let n = 2
    while (slugsUsed.has(slug)) { slug = `${baseSlug}_${n}`; n++ }
    slugsUsed.add(slug)

    let folderName = `${slug}_${datestamp}`
    let targetDir  = path.join(sessionDir, folderName)
    let suffix = 2
    while (existsFn(targetDir)) {
      folderName = `${slug}_${datestamp}_${suffix}`
      targetDir  = path.join(sessionDir, folderName)
      suffix++
    }

    planned.push({ i, c, slug, folderName, targetDir })
  }

  return planned
}

/**
 * Materialize a single planned child case on disk.
 * Returns { ok, childCaseId, childSoapMd } — ok:false means skip this child.
 *
 * @param {object}   p            A planned child from planChildCases.
 * @param {object}   opts
 * @param {string}   opts.parentMp3Path
 * @param {string}   opts.parentTranscript
 * @param {string}   opts.parentTranscriptDocx
 * @param {string}   opts.parentRecordedAt
 * @param {string}   opts.parentDoctorId
 * @param {AppContext} opts.ctx
 */
function materializeChild(p, opts) {
  const { parentMp3Path, parentTranscript, parentTranscriptDocx, parentRecordedAt, parentDoctorId, ctx } = opts
  const { log, platform, stores } = ctx
  const { i, c, slug, folderName, targetDir } = p
  const labelName = c.patient_name || `unknown_${i + 1}`
  const tag = ''

  try { fs.mkdirSync(targetDir, { recursive: true }) }
  catch (e) {
    log(`${tag}[soap] case ${i + 1} (${labelName}): mkdir failed: ${e.message}`)
    stores.recordings.updatePatientStatus(null, folderName, 'failed')
    return { ok: false }
  }

  // Copy MP3
  let childMp3 = null
  if (parentMp3Path && fs.existsSync(parentMp3Path)) {
    childMp3 = path.join(targetDir, `${slug}.mp3`)
    try { fs.copyFileSync(parentMp3Path, childMp3) }
    catch (e) { log(`[soap] case ${i + 1}: mp3 copy failed: ${e.message}`); childMp3 = null }
  }

  // Copy transcript.md + transcript.docx
  try {
    if (fs.existsSync(parentTranscript)) fs.copyFileSync(parentTranscript, path.join(targetDir, 'transcript.md'))
  } catch (e) { log(`[soap] case ${i + 1}: transcript.md copy failed: ${e.message}`) }

  let transcriptDocxOk = false
  const childTranscriptDocx = path.join(targetDir, 'transcript.docx')
  try {
    if (fs.existsSync(parentTranscriptDocx)) { fs.copyFileSync(parentTranscriptDocx, childTranscriptDocx); transcriptDocxOk = true }
  } catch (e) { log(`[soap] case ${i + 1}: transcript.docx copy failed: ${e.message}`) }

  // Copy SOAP .md
  const childSoapMd = path.join(targetDir, `${folderName}_soap_note.md`)
  try { fs.copyFileSync(c.soap_note_md, childSoapMd) }
  catch (e) {
    log(`[soap] case ${i + 1}: soap .md copy failed: ${e.message}`)
    return { ok: false }
  }

  // Hide audit .md
  platform.hideInternal(c.soap_note_md)

  // Insert DB row
  let childCaseId = null
  try {
    const { dbCases } = requireDb()
    const sessionId = stores.session.get().sessionId
    childCaseId = dbCases.createCase({
      patientName: c.patient_name || null,
      doctorId:    parentDoctorId,
      sessionId:   sessionId || null,
      caseDir:     targetDir,
      source:      'recording',
      mp3Path:     childMp3 || null,
      recordedAt:  parentRecordedAt,
    })
    if (childCaseId) {
      dbCases.updateCasePaths(childCaseId, {
        status:               'converting',
        soap_note_path:       childSoapMd,
        transcript_path:      fs.existsSync(path.join(targetDir, 'transcript.md')) ? path.join(targetDir, 'transcript.md') : null,
        transcript_docx_path: transcriptDocxOk ? childTranscriptDocx : null,
      })
    }
  } catch (e) { log(`[db] createCase(child ${i + 1}) failed: ${e.message}`) }

  return { ok: true, childCaseId, childSoapMd }
}

let _db = null
function requireDb() {
  if (!_db) _db = { dbCases: require('../../db/cases') }
  return _db
}

module.exports = { planChildCases, materializeChild }
