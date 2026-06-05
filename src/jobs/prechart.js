'use strict'

const fs   = require('fs')
const path = require('path')
const { parseSkillManifest } = require('../llm/skill-io/manifest')

/** @type {JobDescriptor} */
const prechart = {
  id:       'prechart',
  skillId:  'edit-note',
  label:    'prechart',
  jobKind:  'prechart',
  lockType: 'prechart',

  model:  (cfg) => cfg.soapModel || 'claude-sonnet-4-6',
  effort: () => 'high',

  onRunning(input, ctx, extra, { startedAt }) {
    const job = { type: 'prechart', status: 'running', doctorName: extra.patientLabel, caseDir: input.caseDir, startedAt }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
  },

  onRateLimit(input, ctx, extra) {
    if (extra.combinedAttachmentPath) _cleanup(extra.combinedAttachmentPath, extra.patientLabel, ctx.log)
    const job = { type: 'prechart', status: 'failed', doctorName: extra.patientLabel, caseDir: input.caseDir, error: 'Claude usage limit reached. Try again once the limit resets.', finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
    ctx.renderer.send('service-warning', { title: 'Claude usage limit reached', message: 'Pre-chart could not complete — try again once the limit resets.' })
  },

  onSuccess(runResult, input, ctx, extra, { durationMs }) {
    if (extra.combinedAttachmentPath) _cleanup(extra.combinedAttachmentPath, extra.patientLabel, ctx.log)
    const { log, platform } = ctx
    const { caseDir } = input
    const { patientLabel, caseId } = extra

    // Parse backup_path from JSON manifest or fall back to BACKUP_OK: marker / filesystem glob
    let backupPath = null
    const manifest = parseSkillManifest(runResult.text)
    if (manifest?.skill === 'edit-note' && manifest.backup_path) {
      backupPath = manifest.backup_path
    } else if (/BACKUP_OK:\s*(.+)/.test(runResult.text)) {
      backupPath = runResult.text.match(/BACKUP_OK:\s*(.+)/)[1].trim()
    } else {
      try {
        const backups = fs.readdirSync(caseDir)
          .filter(f => /_soap_note_backup_/.test(f) && f.endsWith('.md'))
          .map(f => ({ f, mt: fs.statSync(path.join(caseDir, f)).mtimeMs }))
          .sort((a, b) => b.mt - a.mt)
        if (backups.length > 0) backupPath = path.join(caseDir, backups[0].f)
      } catch {}
    }

    try { if (caseId) requireDb().dbCases.bumpCaseRevision(caseId) } catch (e) { log(`[db] prechart bumpRevision: ${e.message}`) }

    // Re-run ICD coding + docx on the updated note
    const { runEngine, icdEngine, spawnDocxConversionFn, findExistingSoapNoteFn } = extra
    const updatedNote = findExistingSoapNoteFn(caseDir)
    if (updatedNote) {
      runEngine(icdEngine, ctx, { caseId, caseTag: null, patientFolderName: null, soapNoteMdPath: updatedNote, caseDir, doctor: null })
        .then(() => spawnDocxConversionFn(updatedNote, null, null, caseId))
    } else {
      log(`[prechart][${patientLabel}] WARNING: soap note not found in ${caseDir}`)
    }

    // Hide backup .md files
    try {
      fs.readdirSync(caseDir).filter(f => f.endsWith('.md'))
        .forEach(f => platform.hideInternal(path.join(caseDir, f)))
    } catch {}

    const job = { type: 'prechart', status: 'success', doctorName: patientLabel, caseDir, durationMs, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
    platform.notify('Pre-chart applied', `${patientLabel}'s note has been updated.`)

    // Persist the backup path into the processing_events row (the dispatcher
    // writes the single finishEvent; we contribute backupPath as an event field).
    return { eventFields: { backupPath } }
  },

  onFailure(runResult, input, ctx, extra, durationMs) {
    if (extra.combinedAttachmentPath) _cleanup(extra.combinedAttachmentPath, extra.patientLabel, ctx.log)
    const job = { type: 'prechart', status: 'failed', doctorName: extra.patientLabel, caseDir: input.caseDir, error: `Exit ${runResult.code}`, durationMs, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
  },

  onError(err, input, ctx, extra) {
    if (extra.combinedAttachmentPath) _cleanup(extra.combinedAttachmentPath, extra.patientLabel, ctx.log)
    const job = { type: 'prechart', status: 'failed', doctorName: extra.patientLabel, caseDir: input.caseDir, error: err.message, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
  },
}

function _cleanup(attachmentPath, label, log) {
  try { fs.unlinkSync(attachmentPath); log?.(`[prechart][${label}] cleaned up temp attachment`) }
  catch (e) { log?.(`[prechart][${label}] WARNING: attachment cleanup failed: ${e.message}`) }
}

let _db = null
function requireDb() {
  if (!_db) _db = { dbCases: require('../../db/cases') }
  return _db
}

module.exports = prechart
