'use strict'

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
    const job = { type: 'update', status: 'failed', doctorName: input.doctorName, lastname: extra.lastname, error: 'Claude usage limit reached. Try again once the limit resets.', finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
  },

  onSuccess(runResult, input, ctx, extra, { durationMs }) {

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
    const job = { type: 'update', status: 'failed', doctorName: input.doctorName, lastname: extra.lastname, error: `Exit ${runResult.code}`, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
    ctx.platform.notify('Template update failed', `${input.doctorName} — check app.log for details`)
  },

  onError(err, input, ctx, extra) {
    const job = { type: 'update', status: 'failed', doctorName: input.doctorName, lastname: extra.lastname, error: err.message, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
  },
}

module.exports = templateUpdate
