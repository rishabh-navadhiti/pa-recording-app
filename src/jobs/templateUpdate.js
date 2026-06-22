'use strict'

const fs = require('fs')
const { parseSkillManifest } = require('../llm/skill-io/manifest')

/** @type {JobDescriptor} */
const templateUpdate = {
  id:       'template-update',
  skillId:  'update-doctor-profile',
  label:    'template-update',
  jobKind:  'template_update',
  lockType: 'update',

  model:  (cfg) => cfg.templateModel  || 'claude-opus-4-8',
  effort: (cfg) => cfg.templateEffort || 'max',

  onRunning(input, ctx, extra, { model, effort, startedAt }) {
    const job = { type: 'update', status: 'running', doctorName: input.doctorName, lastname: extra.lastname, model, effort, startedAt }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
  },

  onRateLimit(input, ctx, extra, durationMs) {
    _cleanupSamples(extra.samplesDir, ctx.log)
    _cleanupTempCorrections(extra.tempCorrectionsFile, ctx.log)
    const job = { type: 'update', status: 'failed', doctorName: input.doctorName, lastname: extra.lastname, error: 'Claude usage limit reached. Try again once the limit resets.', finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
    ctx.renderer.send('service-warning', { title: 'Claude usage limit reached', message: 'Template update could not complete — try again once the limit resets.' })
  },

  // Returns nothing → dispatcher treats as success and writes one finishEvent.
  onSuccess(runResult, input, ctx, extra, { durationMs }) {
    _cleanupSamples(extra.samplesDir, ctx.log)
    _cleanupTempCorrections(extra.tempCorrectionsFile, ctx.log)

    // Extract changes report from JSON manifest (B6) or fall back to "Updated:" text marker.
    const updateManifest = parseSkillManifest(runResult.text)
    const changesReport = (() => {
      if (updateManifest && updateManifest.skill === 'update-doctor-profile') {
        const lastNewline = runResult.text.lastIndexOf('\n')
        return lastNewline > 0 ? runResult.text.slice(0, lastNewline).trim() : null
      }
      const idx = runResult.text.indexOf('Updated:')
      return idx !== -1 ? runResult.text.slice(idx).trim() : null
    })()

    const job = { type: 'update', status: 'success', doctorName: input.doctorName, lastname: extra.lastname, templatePath: input.templatePath, durationMs, changesReport, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
    ctx.platform.notify('Template updated', `Profile for ${input.doctorName} updated.`)
  },

  onFailure(runResult, input, ctx, extra, durationMs) {
    _cleanupSamples(extra.samplesDir, ctx.log)
    _cleanupTempCorrections(extra.tempCorrectionsFile, ctx.log)
    const job = { type: 'update', status: 'failed', doctorName: input.doctorName, lastname: extra.lastname, error: `Exit ${runResult.code}`, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
    ctx.platform.notify('Template update failed', `${input.doctorName} — check app.log for details`)
  },

  onError(err, input, ctx, extra) {
    _cleanupSamples(extra.samplesDir, ctx.log)
    _cleanupTempCorrections(extra.tempCorrectionsFile, ctx.log)
    const job = { type: 'update', status: 'failed', doctorName: input.doctorName, lastname: extra.lastname, error: err.message, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
  },
}

// Delete the transient samples staging folder (<NOTES_DIR>/Templates/_staging_update/<lastname>_<ts>/).
// The original spawnTemplateUpdate deleted it on success; we clean on every
// terminal path since it is throwaway input with no value after the job ends.
function _cleanupSamples(samplesDir, log) {
  if (!samplesDir) return
  try {
    if (fs.existsSync(samplesDir)) { fs.rmSync(samplesDir, { recursive: true, force: true }); log?.(`[template-update] Samples staging deleted: ${samplesDir}`) }
  } catch (e) { log?.(`[template-update] WARNING: samples staging delete failed: ${e.message}`) }
}

// Delete the temp .md file produced by converting a .docx corrections file.
function _cleanupTempCorrections(tempFile, log) {
  if (!tempFile) return
  try { fs.unlinkSync(tempFile); log?.(`[template-update] Temp corrections .md deleted: ${tempFile}`) }
  catch (e) { log?.(`[template-update] WARNING: temp corrections cleanup failed: ${e.message}`) }
}

module.exports = templateUpdate
