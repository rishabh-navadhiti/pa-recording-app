'use strict'

const { buildPrompt } = require('../llm/skill-io/prompts')
const { extractUsage, logSkillStream } = require('../llm/usage')
const { CLAUDE_RATE_LIMITED, MCP_AUTH_ERROR } = require('../llm/skill-io/markers')

/**
 * Run a single engine against one case.
 *
 * Shared boilerplate across all engines:
 *   gates check → status update → startEvent → runSkill → interpret →
 *   persist → finishEvent → service-warning → return result
 *
 * Engines are best-effort: a failure returns null and the chain continues.
 *
 * @param {object}   engine   Engine descriptor (see src/engines/*.js)
 * @param {AppContext} ctx    Application context (paths, config, llm, db, ...)
 * @param {CaseContext} caseCtx  Per-case fields (caseDir, caseId, caseTag, doctor, ...)
 * @returns {Promise<object|null>}  interpret() result or null on skip/failure
 */
async function runEngine(engine, ctx, caseCtx) {
  const { log } = ctx
  const { caseId, caseTag, patientFolderName } = caseCtx
  const tag   = caseTag ? `[${caseTag}] ` : ''

  // ---- 1. Gates -----------------------------------------------------------
  const skips = engine.gates(ctx, caseCtx)
  if (skips.length) {
    const reason = skips[0].reason || 'gate condition not met'
    log(`${tag}[${engine.id}] SKIPPED: ${reason}`)
    reportStage(ctx, caseCtx, engine.stage, 'skipped')
    return null
  }

  // ---- 2. Status update → running ----------------------------------------
  reportStage(ctx, caseCtx, engine.stage, engine.stage)

  // ---- 3. DB event start --------------------------------------------------
  const startedAt = new Date().toISOString()
  const wallStart = Date.now()
  let eventId = null
  try {
    const db = ctx.db
    if (db) {
      const { dbEvents } = requireDb()
      eventId = dbEvents.startEvent({
        caseId,
        jobKind:         engine.jobKind,
        relatedDoctorId: caseCtx.doctor?.id || null,
        modelUsed:       engine.model(ctx.config.get()),
        effort:          engine.effort || null,
        startedAt,
      })
    }
  } catch (e) { log(`${tag}[db] startEvent(${engine.id}) failed: ${e.message}`) }

  // ---- 4. Run the skill ---------------------------------------------------
  let runResult
  try {
    const prompt = buildPrompt(engine.skillId, engine.buildInput(ctx, caseCtx))
    runResult = await ctx.llm.runSkill({
      prompt,
      model:  engine.model(ctx.config.get()),
      effort: engine.effort,
      tag,
      label:  engine.id,
    })
  } catch (err) {
    log(`${tag}[${engine.id}] spawn error: ${err.message}`)
    finishEventSafe(eventId, 'failed', Date.now() - wallStart, err.message)
    reportStage(ctx, caseCtx, engine.stage, 'failed')
    return null
  }

  logSkillStream(log, tag, engine.id, runResult.resultEvent)

  // ---- 5. Classify output -------------------------------------------------
  const combined = (runResult.text || '') + '\n' + (runResult.errText || '')
  const isRateLimited = CLAUDE_RATE_LIMITED.test(combined)
  const isMcpError    = MCP_AUTH_ERROR.test(combined)

  // ---- 6. Interpret -------------------------------------------------------
  let result = null
  try {
    result = engine.interpret(runResult, ctx, caseCtx)
  } catch (err) {
    log(`${tag}[${engine.id}] interpret error: ${err.message}`)
  }

  // ---- 7. DB event finish -------------------------------------------------
  const durationMs = Date.now() - wallStart
  let eventStatus = 'success'
  if (isRateLimited) eventStatus = 'rate_limited'
  else if (runResult.code !== 0 || !result) eventStatus = 'failed'

  try {
    const db = ctx.db
    if (db && eventId != null) {
      const { dbEvents } = requireDb()
      dbEvents.finishEvent(eventId, {
        status: eventStatus,
        ...extractUsage(runResult.resultEvent),
        durationMs,
        errorMessage: runResult.code !== 0 ? (runResult.errText || '').slice(0, 1024) : null,
        finishedAt: new Date().toISOString(),
      })
    }
  } catch (e) { log(`${tag}[db] finishEvent(${engine.id}) failed: ${e.message}`) }

  // ---- 8. Persist (engine-specific DB writes) -----------------------------
  try {
    engine.persist(result, ctx, caseCtx, eventId)
  } catch (e) { log(`${tag}[${engine.id}] persist error: ${e.message}`) }

  // ---- 9. Service-warning surface -----------------------------------------
  if (isMcpError && engine.id === 'icd') {
    ctx.renderer.send('service-warning', {
      title:   'ICD-10 connector unavailable',
      message: 'Could not look up ICD-10 codes — the note was generated without codes. Check that you are logged in to Claude (`claude login`) and that the ICD-10 connector is enabled.'
    })
  } else if (isRateLimited) {
    const labels = { icd: 'ICD codes', cdi: 'CDI review', soap: 'SOAP note' }
    ctx.renderer.send('service-warning', {
      title:   'Claude usage limit reached',
      message: `${labels[engine.id] || engine.label} could not complete — try again once the limit resets.`
    })
  }

  // ---- 10. Stage complete -------------------------------------------------
  reportStage(ctx, caseCtx, engine.stage, runResult.code === 0 ? 'completed' : 'failed')

  return result

  function finishEventSafe(evId, status, durMs, errMsg) {
    try {
      if (evId != null) {
        const { dbEvents } = requireDb()
        dbEvents.finishEvent(evId, { status, durationMs: durMs, errorMessage: errMsg, finishedAt: new Date().toISOString() })
      }
    } catch (_) {}
  }
}

/** Update the recordings store status for single- or multi-patient runs. */
function reportStage(ctx, caseCtx, _stage, status) {
  const { caseTag, patientFolderName } = caseCtx
  if (!caseTag) return
  if (patientFolderName) {
    ctx.stores.recordings.updatePatientStatus(caseTag, patientFolderName, status)
  } else {
    ctx.stores.recordings.updateStatus(caseTag, status)
  }
}

// Lazy-require DB modules to avoid circular deps and to allow the engine
// runner to be unit-tested without a real DB (inject a fake ctx.db).
let _db = null
function requireDb() {
  if (!_db) {
    _db = {
      dbEvents: require('../../db/events'),
    }
  }
  return _db
}

module.exports = { runEngine, reportStage }
