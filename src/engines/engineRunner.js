'use strict'

const { buildPrompt } = require('../llm/skill-io/prompts')
const { extractUsage, logSkillStream } = require('../llm/usage')
const { CLAUDE_RATE_LIMITED, MCP_AUTH_ERROR } = require('../llm/skill-io/markers')
const { engineModel } = require('../llm/modelOptions')

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

  // Engines exposing runLlm run API-only (single Anthropic Messages-API call);
  // the rest run agentically via ctx.llm.runSkill.
  const isApiEngine = !!engine.runLlm

  // All post-SOAP engines (ICD / CDI / em-score / patient-summary) are pinned to a
  // fixed model, decoupled from the note-gen selection: they are analysis/coding
  // steps, not note generation, so a newer note-gen model (e.g. Sonnet 5) must not
  // silently move them onto it. This is the single choke point — engine.model() is
  // intentionally NOT consulted (see modelOptions.engineModel()).
  const effectiveModel = engineModel()

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
        modelUsed:       effectiveModel,
        effort:          engine.effort || null,
        startedAt,
      })
    }
  } catch (e) { log(`${tag}[db] startEvent(${engine.id}) failed: ${e.message}`) }

  // ---- 4. Run the skill ---------------------------------------------------
  let runResult
  try {
    if (isApiEngine) {
      // API-only: single Anthropic Messages-API call. Node reads inputs + writes
      // the output file; runResult.text IS the synthesized run manifest.
      runResult = await engine.runLlm(engine.buildInput(ctx, caseCtx), ctx, caseCtx, {
        model:    effectiveModel,
        provider: ctx.api,
      })
    } else {
      const prompt = buildPrompt(engine.skillId, engine.buildInput(ctx, caseCtx))
      runResult = await ctx.llm.runSkill({
        prompt,
        model:  effectiveModel,
        effort: engine.effort,
        tag,
        label:  engine.id,
      })
    }
  } catch (err) {
    log(`${tag}[${engine.id}] spawn error: ${err.message}`)
    finishEventSafe(eventId, 'failed', Date.now() - wallStart, err.message)
    reportStage(ctx, caseCtx, engine.stage, 'failed')
    return null
  }

  // CLI runs carry a stream-json result event; API runs don't.
  if (runResult.resultEvent) logSkillStream(log, tag, engine.id, runResult.resultEvent)

  // ---- 5. Classify output -------------------------------------------------
  const combined = (runResult.text || '') + '\n' + (runResult.errText || '')
  // API runs flag rate limits via runResult.isRateLimit (HTTP 429/529); CLI runs
  // surface it as text matched by the regex.
  const isRateLimited = !!runResult.isRateLimit || CLAUDE_RATE_LIMITED.test(combined)
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
      // API runs carry a normalized `usage` object; CLI runs carry a stream-json
      // result event extractUsage() reads. Both yield the same column set.
      const usageFields = runResult.usage || extractUsage(runResult.resultEvent)
      dbEvents.finishEvent(eventId, {
        status: eventStatus,
        ...usageFields,
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
  } else if (isApiEngine && runResult.code !== 0 &&
             (runResult.statusCode === 401 || /ANTHROPIC_API_KEY not set/.test(runResult.errText || ''))) {
    // API-only engines need an Anthropic key even on the agentic SOAP option.
    ctx.renderer.send('service-warning', {
      title:   'Anthropic API key missing or invalid',
      message: `${engine.label} could not run — set your Anthropic API key in Settings → Advanced.`
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
