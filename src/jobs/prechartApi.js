'use strict'

const fs   = require('fs')
const path = require('path')
const { parseSkillManifest }       = require('../llm/skill-io/manifest')
const { buildSingleCallNoteEdit, splitNoteAndManifest } = require('../llm/skill-io/singleCall')
const { resolveOption }            = require('../llm/modelOptions')
const { normalizeApiUsage }        = require('../llm/pricing')
const { runCostiganChecklist }     = require('./costiganChecklist')

const SKILL_PATH = path.join(__dirname, '../../notes-claude/skills/edit-note-api/SKILL.md')

/** @type {JobDescriptor} */
const prechartApi = {
  id:       'prechart',
  skillId:  null,   // no CLI skill — uses runLlm hook
  label:    'prechart',
  jobKind:  'prechart',
  lockType: 'prechart',

  model:  (cfg) => resolveOption(cfg.soapModel)?.model || 'claude-sonnet-4-6',
  effort: () => 'high',

  // API-based LLM runner — replaces buildPrompt + ctx.llm.runSkill in jobDispatcher.
  // Returns a normalized {code, text, errText, resultEvent, isRateLimit} result.
  async runLlm(input, ctx, { model }) {
    const { log } = ctx
    const { caseDir, templatePath, attachmentPath, instructions } = input
    const cfg = ctx.config.get()
    const opt = resolveOption(cfg.soapModel)
    const provider = (opt?.provider === 'openai') ? ctx.openai : ctx.api

    // Find existing soap note (glob: *_soap_note.md, exclude backups)
    let existingNotePath = null
    try {
      const files = fs.readdirSync(caseDir)
      const match = files.find(f => f.endsWith('_soap_note.md') && !/_soap_note_backup_/.test(f))
      if (match) existingNotePath = path.join(caseDir, match)
    } catch (e) {
      const msg = `Cannot read case folder: ${e.message}`
      log(`[prechart][edit-note:api] ERROR ${msg}`)
      return { code: 1, text: '', errText: msg }
    }
    if (!existingNotePath) {
      const msg = `No existing soap note found in ${caseDir}`
      log(`[prechart][edit-note:api] ERROR ${msg}`)
      return { code: 1, text: '', errText: msg }
    }

    // Read source files
    let templateText = ''
    let existingNoteText = ''
    let transcriptText = ''
    let attachmentText = ''
    try {
      if (templatePath && fs.existsSync(templatePath)) templateText = fs.readFileSync(templatePath, 'utf8')
      existingNoteText = fs.readFileSync(existingNotePath, 'utf8')
      const files = fs.readdirSync(caseDir)
      const txFile = files.find(f => f === 'transcript.md' || f.endsWith('_transcript.md'))
      if (txFile) transcriptText = fs.readFileSync(path.join(caseDir, txFile), 'utf8')
      if (attachmentPath && fs.existsSync(attachmentPath)) attachmentText = fs.readFileSync(attachmentPath, 'utf8')
    } catch (e) {
      const msg = `File read error: ${e.message}`
      log(`[prechart][edit-note:api] ERROR ${msg}`)
      return { code: 1, text: '', errText: msg }
    }

    // Read skill file
    let skillText = ''
    try {
      skillText = fs.readFileSync(SKILL_PATH, 'utf8')
    } catch (e) {
      const msg = `edit-note-api skill not found: ${e.message}`
      log(`[prechart][edit-note:api] ERROR ${msg}`)
      return { code: 1, text: '', errText: msg }
    }

    // Create backup before calling the API
    const stem = path.basename(existingNotePath, '_soap_note.md')
    const ts   = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15)
    const backupPath = path.join(caseDir, `${stem}_soap_note_backup_${ts}.md`)
    try {
      fs.copyFileSync(existingNotePath, backupPath)
      log(`[prechart][edit-note:api] backup created: ${backupPath}`)
    } catch (e) {
      const msg = `Backup failed: ${e.message}`
      log(`[prechart][edit-note:api] ERROR ${msg}`)
      return { code: 1, text: '', errText: msg }
    }

    // Build API messages
    const { system, user } = buildSingleCallNoteEdit({
      skillText, templateText, existingNoteText, transcriptText,
      attachmentText, instructions, existingNotePath, backupPath,
    })

    // Call the API
    const result = await provider.runSingleCall({ system, user, model, tag: '[prechart]', label: 'edit-note:api' })

    if (!result.ok) {
      const msg = result.errText || 'API error'
      log(`[prechart][edit-note:api] [DEV-ALERT] API failed: ${msg}`)
      return {
        code:        1,
        text:        '',
        errText:     msg,
        statusCode:  result.statusCode,   // preserved for onFailure's auth/rate messaging
        resultEvent: null,
        usage:       normalizeApiUsage({ model, rawUsage: result.rawUsage, durationMs: result.durationMs }),
        isRateLimit: result.statusCode === 429 || result.statusCode === 529,
      }
    }

    // Split the note body from the model's response (last JSON object = manifest)
    const { noteBody } = splitNoteAndManifest(result.text)
    log(`[prechart][edit-note:api] note body length: ${(noteBody || result.text).length} chars, writing to ${existingNotePath}`)

    // On Windows, fs.writeFileSync (CREATE_ALWAYS + FILE_ATTRIBUTE_NORMAL) fails with EPERM
    // on existing files that have the hidden attribute (attrib +h) set by the app.
    // Strip it first; onSuccess re-hides all .md files via platform.hideInternal.
    if (process.platform === 'win32') {
      try { require('child_process').execFileSync('attrib', ['-h', existingNotePath], { stdio: 'ignore' }) } catch {}
    }

    // Write the updated note to disk
    try {
      fs.writeFileSync(existingNotePath, noteBody || result.text, 'utf8')
    } catch (e) {
      const msg = `Write failed: ${e.message}`
      log(`[prechart][edit-note:api] ERROR ${msg}`)
      // The API call succeeded (tokens were spent) — still record usage on the failed row.
      return { code: 1, text: '', errText: msg, usage: normalizeApiUsage({ model, rawUsage: result.rawUsage, durationMs: result.durationMs }) }
    }

    log(`[prechart][edit-note:api] note written successfully`)

    // Return a synthetic result whose text IS the manifest (same shape onSuccess expects)
    const manifest = {
      schema_version: 1,
      skill:          'edit-note',
      status:         'ok',
      backup_path:    backupPath,
      note_path:      existingNotePath,
      warnings:       [],
    }
    return {
      code:        0,
      text:        JSON.stringify(manifest),
      errText:     '',
      // Normalized usage record — the dispatcher writes these token/cost/duration
      // columns to processing_events (extractUsage cannot read the API shape).
      usage:       normalizeApiUsage({ model, rawUsage: result.rawUsage, durationMs: result.durationMs }),
    }
  },

  onRunning(input, ctx, extra, { startedAt }) {
    const job = { type: 'prechart', status: 'running', doctorName: extra.patientLabel, caseDir: input.caseDir, startedAt }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
  },

  onRateLimit(input, ctx, extra) {
    if (extra.combinedAttachmentPath) _cleanup(extra.combinedAttachmentPath, extra.patientLabel, ctx.log)
    const job = { type: 'prechart', status: 'failed', doctorName: extra.patientLabel, caseDir: input.caseDir, error: 'API rate limit reached. Try again once the limit resets.', finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
    ctx.renderer.send('service-warning', { title: 'API rate limit reached', message: 'Pre-chart could not complete — try again once the limit resets.' })
  },

  onSuccess(runResult, input, ctx, extra, { durationMs }) {
    if (extra.combinedAttachmentPath) _cleanup(extra.combinedAttachmentPath, extra.patientLabel, ctx.log)
    const { log, platform } = ctx
    const { caseDir } = input
    const { patientLabel, caseId } = extra

    // Parse backup_path from JSON manifest or fall back to filesystem glob
    let backupPath = null
    const manifest = parseSkillManifest(runResult.text)
    if (manifest?.skill === 'edit-note' && manifest.backup_path) {
      backupPath = manifest.backup_path
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

    // Costigan procedure checklist (opt-in, Costigan-only) — single API call on the final note + pasted chart.
    if (ctx.config.get().enableCostiganCdi && extra.doctor) {
      runCostiganChecklist({ caseDir, doctor: extra.doctor, chartText: input.chartText, caseId, ctx })
        .catch(e => log(`[costigan] run error: ${e.message}`))
    }

    const job = { type: 'prechart', status: 'success', doctorName: patientLabel, caseDir, durationMs, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
    platform.notify('Pre-chart applied', `${patientLabel}'s note has been updated.`)

    return { eventFields: { backupPath } }
  },

  onFailure(runResult, input, ctx, extra, durationMs) {
    if (extra.combinedAttachmentPath) _cleanup(extra.combinedAttachmentPath, extra.patientLabel, ctx.log)
    _rehideNotes(input.caseDir, ctx)   // un-hidden before the write attempt on Windows; re-hide on failure
    const error = runResult.errText || `Exit ${runResult.code}`
    ctx.log?.(`[prechart][edit-note:api] job failed: ${error}`)

    // Surface the real reason to the scribe (auth vs generic), mirroring the SOAP API path.
    const opt = resolveOption(ctx.config.get().soapModel)
    const providerName = (opt?.provider === 'openai') ? 'OpenAI' : 'Anthropic'
    const keyEnvName   = providerName === 'OpenAI' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
    const isAuthError  = !!(error.includes(`${keyEnvName} not set`) || runResult.statusCode === 401)
    ctx.renderer.send('service-warning', isAuthError
      ? { title: 'Anthropic API key missing or invalid', message: 'Set your Anthropic API key in Settings → Advanced.' }
      : { title: 'Pre-chart failed', message: `The note could not be updated. ${error.slice(0, 200)}` })

    const job = { type: 'prechart', status: 'failed', doctorName: extra.patientLabel, caseDir: input.caseDir, error, durationMs, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
  },

  onError(err, input, ctx, extra) {
    if (extra.combinedAttachmentPath) _cleanup(extra.combinedAttachmentPath, extra.patientLabel, ctx.log)
    _rehideNotes(input.caseDir, ctx)   // re-hide in case the write un-hid the note before throwing
    const job = { type: 'prechart', status: 'failed', doctorName: extra.patientLabel, caseDir: input.caseDir, error: err.message, finishedAt: Date.now() }
    ctx.jobState.save(job); ctx.renderer.send('template-job-status', job); ctx.sendStatus('template-job-status', job)
  },
}

// Re-hide every .md in the case folder (no-op on macOS). On Windows runLlm strips
// `attrib -h` from the note before writing; onSuccess re-hides, so the failure
// paths must re-hide too or the note is left visible to the user.
function _rehideNotes(caseDir, ctx) {
  try {
    fs.readdirSync(caseDir).filter(f => f.endsWith('.md'))
      .forEach(f => ctx.platform?.hideInternal(path.join(caseDir, f)))
  } catch {}
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

module.exports = prechartApi
