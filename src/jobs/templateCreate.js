'use strict'

const fs = require('fs')
const path = require('path')

/** @type {JobDescriptor} */
const templateCreate = {
  id:       'template-create',
  skillId:  'create-doctor-profile',
  label:    'template',
  jobKind:  'template_create',
  lockType: 'create',

  model:  (cfg) => cfg.templateModel  || 'claude-opus-4-8',
  effort: (cfg) => cfg.templateEffort || 'max',

  onRunning(input, ctx, extra, { model, effort, startedAt }) {
    ctx.jobState.save({ type: 'create', status: 'running', doctorName: input.doctorName, lastname: input.lastname, model, effort, startedAt })
    ctx.renderer.send('template-job-status', { type: 'create', status: 'running', doctorName: input.doctorName, lastname: input.lastname, model, effort, startedAt })
    ctx.sendStatus('template-job-status', { type: 'create', status: 'running', doctorName: input.doctorName, lastname: input.lastname, model, effort, startedAt })
  },

  onRateLimit(input, ctx, extra, durationMs) {
    const job = { type: 'create', status: 'failed', doctorName: input.doctorName, lastname: input.lastname, error: 'Claude usage limit reached. Try again once the limit resets.', finishedAt: Date.now() }
    ctx.jobState.save(job);    ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
    // Prominent toast in addition to the in-banner failed state (parity with original).
    ctx.renderer.send('service-warning', { title: 'Claude usage limit reached', message: 'Template creation could not complete — try again once the limit resets.' })
  },

  // Returns { ok, error? } so the dispatcher can set the event status and write
  // exactly one finishEvent. Does NOT call finishEvent itself.
  onSuccess(runResult, input, ctx, extra, { durationMs }) {
    const { log } = ctx
    const { doctorName, lastname } = input
    const expectedPath = path.join(ctx.paths.templatesDir, `${lastname}.md`)

    if (!fs.existsSync(expectedPath)) {
      const job = { type: 'create', status: 'failed', doctorName, lastname, error: 'Template file not found', finishedAt: Date.now() }
      ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
      ctx.platform.notify('Template creation failed', `${doctorName} — check app.log for details`)
      return { ok: false, error: `Template file not found at ${expectedPath}` }
    }

    try {
      const { dbDoctors } = requireDb()
      const existing = dbDoctors.getDoctorByLastname(lastname)
      const doctorId = existing ? existing.id : String(Date.now())
      dbDoctors.upsertDoctor({ id: doctorId, name: doctorName.trim(), lastname, templatePath: expectedPath })
      log(`[template] Doctor registered: ${doctorName} (${expectedPath})`)
    } catch (e) { log(`[template] WARNING: failed to register doctor: ${e.message}`) }

    // Delete staging folder
    try { if (extra.stagingDir) { fs.rmSync(extra.stagingDir, { recursive: true, force: true }); log(`[template] Staging deleted: ${extra.stagingDir}`) } } catch (e) { log(`[template] WARNING: staging delete failed: ${e.message}`) }

    const job = { type: 'create', status: 'success', doctorName, lastname, templatePath: expectedPath, durationMs, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
    ctx.platform.notify('Template ready', `Profile for ${doctorName} saved.`)
    return { ok: true }
  },

  onFailure(runResult, input, ctx, extra, durationMs) {
    const job = { type: 'create', status: 'failed', doctorName: input.doctorName, lastname: input.lastname, error: runResult.code === 0 ? `Template file not found` : `Exit ${runResult.code}`, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
    ctx.platform.notify('Template creation failed', `${input.doctorName} — check app.log for details`)
  },

  onError(err, input, ctx, extra) {
    const job = { type: 'create', status: 'failed', doctorName: input.doctorName, lastname: input.lastname, error: err.code === 'ENOENT' ? 'Claude CLI not installed.' : err.message, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
  },
}

let _db = null
function requireDb() {
  if (!_db) _db = { dbDoctors: require('../../db/doctors') }
  return _db
}

module.exports = templateCreate
