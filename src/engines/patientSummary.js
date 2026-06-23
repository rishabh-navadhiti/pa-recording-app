'use strict'

const fs   = require('fs')
const path = require('path')
const { parseSkillManifest } = require('../llm/skill-io/manifest')
const { CLAUDE_RATE_LIMITED } = require('../llm/skill-io/markers')

const patientSummary = {
  id:           'patient-summary',
  skillId:      'patient-summary',
  label:        'Patient summary',
  jobKind:      'patient_summary',
  stage:        'patient_summary',
  completesCase: false,

  model: () =>  'claude-sonnet-4-6',
  effort: 'high',

  /**
   * Single gate — the global enablePatientSummary setting.
   * Returns [{reason}] if the engine should be skipped, [] if it should run.
   */
  gates(ctx) {
    if (!ctx.config.get().enablePatientSummary) return [{ reason: 'disabled' }]
    return []
  },

  buildInput(ctx, caseCtx) {
    return { caseDir: caseCtx.caseDir }
  },

  /**
   * Interpret the patient-summary skill output.
   *
   * LOAD-BEARING: when parseSkillManifest returns null (e.g. the run was cut
   * short by a 429 before the manifest line arrived), falls back to reading
   * the on-disk <stem>_patient_summary.json that the skill already wrote. This
   * filesystem fallback is the reliability layer for rate-limited runs — do not
   * remove.
   *
   * @param {RunSkillResult} runResult
   * @param {AppContext}     ctx
   * @param {CaseContext}    caseCtx
   * @returns {{ manifest, recovered, rateLimited, skippedReason }}
   */
  interpret(runResult, ctx, caseCtx) {
    const combined    = (runResult.text || '') + '\n' + (runResult.errText || '')
    const rateLimited = CLAUDE_RATE_LIMITED.test(combined)
    const log = ctx.log

    // Try manifest from the skill's output text first.
    let manifest = parseSkillManifest(runResult.text)

    const manifestValid = manifest && manifest.schema_version === 1 &&
      manifest.skill === 'patient-summary' && manifest.status

    if (manifestValid && manifest.status === 'ok') {
      return { manifest, recovered: false, rateLimited, skippedReason: null }
    }

    if (manifestValid && manifest.status === 'skipped') {
      return {
        manifest: null, recovered: false, rateLimited,
        skippedReason: manifest.skipped_reason || 'skill reported skipped'
      }
    }

    // Manifest missing or status=failed — try the filesystem fallback.
    const synthesized = synthesizePatientSummaryFromDisk(caseCtx.caseDir, log)
    if (synthesized) {
      return { manifest: synthesized, recovered: true, rateLimited, skippedReason: null }
    }

    // Genuinely failed.
    return { manifest: null, recovered: false, rateLimited, skippedReason: null }
  },

  /**
   * Write the patient-summary result to the generic engine_outputs index.
   * Called by engineRunner after interpret(); result is the interpret() return value.
   */
  persist(result, ctx, caseCtx, eventId) {
    const { caseId, caseTag } = caseCtx
    if (!caseId) return
    const tag = caseTag ? `[${caseTag}] ` : ''
    const log = ctx.log
    const { dbEngineOutputs } = requireDb()

    const m = result && result.manifest
    const status = m ? 'ok' : ((result && result.skippedReason) ? 'skipped' : 'failed')
    const summaryJson = {
      reading_level: m?.reading_level ?? null,
    }

    try {
      dbEngineOutputs.insertOutput({
        caseId,
        engine:      'patient-summary',
        status,
        jsonPath:    m?.json_path || null,
        summaryJson,
        eventId,
      })
      if (m) {
        log(`${tag}[patient-summary] success: reading level ${m.reading_level ?? '?'}`)
      }
    } catch (e) {
      log(`${tag}[patient-summary] output insert failed: ${e.message}`)
    }
  },

  render(result) {
    return { readingLevel: result?.manifest?.reading_level ?? null }
  },
}

/**
 * Synthesize a patient-summary manifest from the on-disk _patient_summary.json
 * when the model's manifest line was missing or unparseable (e.g. a 429
 * truncated the run). Returns null if the file doesn't exist or has the wrong
 * shape.
 *
 * Mirrors synthesizeManifestFromDisk in src/engines/cdi.js — the load-bearing
 * reliability layer for rate-limited runs.
 *
 * @param {string}   caseDir
 * @param {Function} log
 * @returns {object|null}
 */
function synthesizePatientSummaryFromDisk(caseDir, log) {
  let fileStem = path.basename(caseDir)
  try {
    const soapMd = fs.readdirSync(caseDir).find(f => f.endsWith('_soap_note.md'))
    if (soapMd) fileStem = soapMd.replace(/_soap_note\.md$/, '')
  } catch {}
  const jsonOnDisk = path.join(caseDir, `${fileStem}_patient_summary.json`)

  if (!fs.existsSync(jsonOnDisk)) return null
  try {
    const full = JSON.parse(fs.readFileSync(jsonOnDisk, 'utf8'))
    if (!full) {
      log(`[patient-summary] fallback: _patient_summary.json present but malformed`)
      return null
    }
    return {
      schema_version: 1,
      skill:          'patient-summary',
      status:         'ok',
      json_path:      jsonOnDisk,
      reading_level:  full.reading_level ?? null,
      skipped_reason: null,
      error:          null,
    }
  } catch (e) {
    log(`[patient-summary] fallback parse failed: ${e.message}`)
    return null
  }
}

// Lazy-require DB modules — keeps patientSummary.js testable without a real DB.
let _db = null
function requireDb() {
  if (!_db) {
    _db = {
      dbEngineOutputs: require('../../db/engine_outputs'),
    }
  }
  return _db
}

module.exports = patientSummary
module.exports.synthesizePatientSummaryFromDisk = synthesizePatientSummaryFromDisk
