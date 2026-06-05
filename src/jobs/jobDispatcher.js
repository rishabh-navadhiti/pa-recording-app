'use strict'

const { buildPrompt }       = require('../llm/skill-io/prompts')
const { extractUsage, logSkillStream } = require('../llm/usage')
const { CLAUDE_RATE_LIMITED } = require('../llm/skill-io/markers')

/**
 * Shared executor for background jobs (template-create, template-update, prechart).
 * Mirrors engineRunner.js but for the job layer.
 *
 * Owns the single-flight lock lifecycle:
 *   - acquires ctx.stores.jobs before the LLM call (so isRunning() is true)
 *   - registers an abort-proc so cancel-template-creation can SIGTERM the run
 *   - releases the lock in a finally (descriptors never touch the lock)
 *
 * Replaces the three `spawnClaude({onClose, onError})` callback patterns with
 * a single Promise-based `ctx.llm.runSkill(...)` call — the last `shell:true`
 * spawn in the codebase dies here.
 *
 * Fire-and-forget: the IPC handler checks isRunning() then calls runJob without
 * awaiting; the lock is acquired synchronously before the first await so there
 * is no race.
 *
 * @param {object}     descriptor  Job descriptor (see src/jobs/*.js)
 * @param {object}     input       Structured input for buildPrompt
 * @param {AppContext} ctx
 * @param {object}     [extra]     Per-call context (caseDir, caseId, doctorId, lastname, ...)
 */
async function runJob(descriptor, input, ctx, extra = {}) {
  const { log } = ctx
  const settings = ctx.config.get()
  const model    = descriptor.model(settings)
  const effort   = descriptor.effort(settings)
  const label    = descriptor.label || descriptor.id

  const startMs = Date.now()
  const startedAt = new Date().toISOString()

  // --- Acquire the single-flight lock synchronously (before any await) ------
  // The abort-proc lets cancel-template-creation SIGTERM the in-flight run via
  // jobRunner.cancel() → proc.kill() → ac.abort() → child SIGTERM.
  const ac = new AbortController()
  ctx.stores.jobs.start(descriptor.lockType, { kill: () => ac.abort() }, null)

  // Broadcast 'running' so the UI shows progress immediately.
  descriptor.onRunning?.(input, ctx, extra, { model, effort, startedAt: startMs })

  // Start the DB event and register its id on the lock (for cancel's finishEvent).
  let eventId = null
  try {
    const { dbEvents } = requireDb()
    eventId = dbEvents.startEvent({
      caseId:          extra.caseId || null,
      jobKind:         descriptor.jobKind,
      relatedDoctorId: extra.doctorId || null,
      modelUsed:       model,
      effort,
      startedAt,
    })
    ctx.stores.jobs.setEventId(eventId)
  } catch (e) { log(`[db] startEvent(${descriptor.id}) failed: ${e.message}`) }

  let runResult
  try {
    const prompt = buildPrompt(descriptor.skillId, input)
    runResult = await ctx.llm.runSkill({ prompt, model, effort, label, signal: ac.signal })
  } catch (err) {
    _finishEventSafe(eventId, 'failed', Date.now() - startMs, err.message, ctx)
    descriptor.onError?.(err, input, ctx, extra, eventId)
    ctx.stores.jobs.clear()
    return
  }

  try {
    const { code, text: resultText, resultEvent, errText } = runResult
    const durationMs = Date.now() - startMs
    logSkillStream(log, '', label, resultEvent)

    if (CLAUDE_RATE_LIMITED.test(resultText + errText)) {
      _finishEventSafe(eventId, 'rate_limited', durationMs, 'Claude usage limit reached', ctx, { resultEvent })
      descriptor.onRateLimit?.(input, ctx, extra, durationMs)
    } else if (code === 0) {
      _finishEventSafe(eventId, 'success', durationMs, null, ctx, { resultEvent })
      descriptor.onSuccess?.(runResult, input, ctx, extra, { eventId, durationMs })
    } else {
      _finishEventSafe(eventId, 'failed', durationMs, errText.slice(0, 1024), ctx, { resultEvent })
      descriptor.onFailure?.(runResult, input, ctx, extra, durationMs)
    }
  } finally {
    // Dispatcher owns the lock — release it once the run is fully handled.
    ctx.stores.jobs.clear()
  }
}

function _finishEventSafe(eventId, status, durationMs, errMsg, ctx, extraFields = {}) {
  if (eventId == null) return
  try {
    const { dbEvents } = requireDb()
    dbEvents.finishEvent(eventId, {
      status,
      durationMs,
      errorMessage: errMsg || null,
      finishedAt: new Date().toISOString(),
      ...(extraFields.resultEvent ? extractUsage(extraFields.resultEvent) : {}),
    })
  } catch (e) { ctx.log?.(`[db] finishEvent failed: ${e.message}`) }
}

let _db = null
function requireDb() {
  if (!_db) _db = { dbEvents: require('../../db/events') }
  return _db
}

module.exports = { runJob }
