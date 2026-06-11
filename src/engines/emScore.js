'use strict'

const fs   = require('fs')
const path = require('path')
const { parseSkillManifest } = require('../llm/skill-io/manifest')
const { CLAUDE_RATE_LIMITED } = require('../llm/skill-io/markers')

const emScore = {
  id:           'em-score',
  skillId:      'em-score',
  label:        'E/M scoring',
  jobKind:      'em_score',
  stage:        'scoring_em',
  completesCase: false,

  model: (cfg) => cfg.soapModel || 'claude-sonnet-4-6',
  effort: 'high',

  /**
   * Single gate — the global enableEmScore setting.
   * No specialty gate: E/M scoring works for any note (CPT/AMA rules).
   * Returns [{reason}] if the engine should be skipped, [] if it should run.
   */
  gates(ctx) {
    if (!ctx.config.get().enableEmScore) return [{ reason: 'disabled' }]
    return []
  },

  buildInput(ctx, caseCtx) {
    const standardsDir = path.join(ctx.paths.notesDir, '.claude', 'standards')
    return {
      caseDir:      caseCtx.caseDir,
      specialty:    (caseCtx.doctor?.specialty || '').toLowerCase(),
      standardsDir,
    }
  },

  /**
   * Interpret the em-score skill output.
   *
   * LOAD-BEARING: when parseSkillManifest returns null (e.g. the run was cut
   * short by a 429 before the manifest line arrived), falls back to reading
   * the on-disk <stem>_em.json that the skill already wrote. This filesystem
   * fallback is the reliability layer for rate-limited runs — do not remove.
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
      manifest.skill === 'em-score' && manifest.status

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
    const synthesized = synthesizeEmFromDisk(caseCtx.caseDir, log)
    if (synthesized) {
      return { manifest: synthesized, recovered: true, rateLimited, skippedReason: null }
    }

    // Genuinely failed.
    return { manifest: null, recovered: false, rateLimited, skippedReason: null }
  },

  /**
   * Write the em-score result to the generic engine_outputs index.
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
      predicted_em_level:  m?.predicted_em_level  ?? null,
      predicted_complexity: m?.predicted_complexity ?? null,
      downcode_risk:       m?.downcode_risk       ?? null,
    }

    try {
      dbEngineOutputs.insertOutput({
        caseId,
        engine:      'em-score',
        status,
        jsonPath:    m?.json_path || null,
        summaryJson,
        eventId,
      })
      if (m) {
        log(`${tag}[em-score] success: level ${m.predicted_em_level ?? '?'} · ${m.predicted_complexity ?? '?'} complexity · downcode risk ${m.downcode_risk ?? '?'}`)
      }
    } catch (e) {
      log(`${tag}[em-score] output insert failed: ${e.message}`)
    }
  },

  render(result) {
    return { emLevel: result?.manifest?.predicted_em_level ?? null }
  },
}

/**
 * Synthesize an em-score manifest from the on-disk _em.json when the model's
 * manifest line was missing or unparseable (e.g. a 429 truncated the run).
 * Returns null if the file doesn't exist or has the wrong shape.
 *
 * Mirrors synthesizeManifestFromDisk in src/engines/cdi.js — the load-bearing
 * reliability layer for rate-limited runs.
 *
 * @param {string}   caseDir
 * @param {Function} log
 * @returns {object|null}
 */
function synthesizeEmFromDisk(caseDir, log) {
  let fileStem = path.basename(caseDir)
  try {
    const soapMd = fs.readdirSync(caseDir).find(f => f.endsWith('_soap_note.md'))
    if (soapMd) fileStem = soapMd.replace(/_soap_note\.md$/, '')
  } catch {}
  const jsonOnDisk = path.join(caseDir, `${fileStem}_em.json`)

  if (!fs.existsSync(jsonOnDisk)) return null
  try {
    const full = JSON.parse(fs.readFileSync(jsonOnDisk, 'utf8'))
    if (!full) {
      log(`[em-score] fallback: _em.json present but malformed`)
      return null
    }
    return {
      schema_version:       1,
      skill:                'em-score',
      status:               'ok',
      json_path:            jsonOnDisk,
      predicted_em_level:   full.predicted_em_level   ?? null,
      predicted_complexity: full.predicted_complexity ?? null,
      downcode_risk:        full.downcode_risk        ?? null,
      skipped_reason:       null,
      error:                null,
    }
  } catch (e) {
    log(`[em-score] fallback parse failed: ${e.message}`)
    return null
  }
}

// Lazy-require DB modules — keeps emScore.js testable without a real DB.
let _db = null
function requireDb() {
  if (!_db) {
    _db = {
      dbEngineOutputs: require('../../db/engine_outputs'),
    }
  }
  return _db
}

module.exports = emScore
module.exports.synthesizeEmFromDisk = synthesizeEmFromDisk
