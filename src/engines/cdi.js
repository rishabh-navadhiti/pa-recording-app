'use strict'

const fs   = require('fs')
const path = require('path')
const { parseSkillManifest } = require('../llm/skill-io/manifest')
const { CLAUDE_RATE_LIMITED } = require('../llm/skill-io/markers')

const cdi = {
  id:           'cdi',
  skillId:      'cdi-review',
  label:        'CDI review',
  jobKind:      'cdi',
  stage:        'running_cdi',
  completesCase: false,

  model: (cfg) => cfg.soapModel || 'claude-sonnet-4-6',
  effort: 'high',

  /**
   * Three gates — all must pass for the CDI skill to run.
   * Returns [{reason}] on the first failing gate, [] if all pass.
   */
  gates(ctx, caseCtx) {
    if (!ctx.config.get().enableCdi) {
      return [{ reason: 'disabled' }]
    }
    const specialty = (caseCtx.doctor?.specialty || '').toLowerCase()
    if (!specialty) {
      return [{ reason: `specialty not set for ${caseCtx.doctor?.name || 'this doctor'}` }]
    }
    const specialtyFile = path.join(ctx.paths.notesDir, '.claude', 'standards', 'specialties', `${specialty}.md`)
    if (!fs.existsSync(specialtyFile)) {
      return [{ reason: `unsupported specialty '${specialty}' — no standards file at specialties/${specialty}.md` }]
    }
    return []
  },

  buildInput(ctx, caseCtx) {
    const standardsDir = path.join(ctx.paths.notesDir, '.claude', 'standards')
    return {
      caseDir:      caseCtx.caseDir,
      specialty:    (caseCtx.doctor?.specialty || '').toLowerCase(),
      mode:         ctx.config.get().cdiMode || 'balanced',
      doctor:       caseCtx.doctor?.name || '',
      standardsDir,
    }
  },

  /**
   * Interpret the CDI skill output.
   *
   * LOAD-BEARING: when parseSkillManifest returns null (e.g. the run was cut
   * short by a 429 before the manifest line arrived), falls back to reading
   * the on-disk <case>_cdi.json that the skill already wrote. This filesystem
   * fallback is the reliability layer for rate-limited CDI runs — do not remove.
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
    let recovered = false

    const manifestValid = manifest && manifest.schema_version === 1 &&
      manifest.skill === 'cdi-review' && manifest.status

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
    const synthesized = synthesizeManifestFromDisk(caseCtx.caseDir, log)
    if (synthesized) {
      recovered = true
      return { manifest: synthesized, recovered: true, rateLimited, skippedReason: null }
    }

    // Genuinely failed.
    return { manifest: null, recovered: false, rateLimited, skippedReason: null }
  },

  /** DB and UI writes are handled by engineRunner using the interpret() result. */
  persist() {},

  render(result) {
    if (!result || !result.manifest) return null
    const m = result.manifest
    return {
      cdiFlagCount:                 m.flag_count ?? 0,
      cdiQualityScore:              m.quality_score ?? null,
      cdiClinicianApprovalRequired: !!m.clinician_approval_required,
    }
  },
}

/**
 * Synthesize a CDI manifest from the on-disk _cdi.json when the model's
 * manifest line was missing or unparseable (e.g. a 429 truncated the run).
 * Returns null if the file doesn't exist or has the wrong shape.
 *
 * This is the load-bearing reliability layer — preserved verbatim from
 * the original spawnCdiReview implementation.
 *
 * @param {string}   caseDir
 * @param {Function} log
 * @returns {object|null}
 */
function synthesizeManifestFromDisk(caseDir, log) {
  let fileStem = path.basename(caseDir)
  try {
    const soapMd = fs.readdirSync(caseDir).find(f => f.endsWith('_soap_note.md'))
    if (soapMd) fileStem = soapMd.replace(/_soap_note\.md$/, '')
  } catch {}
  const jsonOnDisk = path.join(caseDir, `${fileStem}_cdi.json`)
  const mdOnDisk   = path.join(caseDir, `${fileStem}_cdi.md`)

  if (!fs.existsSync(jsonOnDisk)) return null
  try {
    const full = JSON.parse(fs.readFileSync(jsonOnDisk, 'utf8'))
    if (!full || !full.summary || !Array.isArray(full.flags)) {
      log(`[cdi] fallback: _cdi.json present but malformed (missing summary/flags)`)
      return null
    }
    const s = full.summary
    return {
      schema_version: 1,
      skill:          'cdi-review',
      status:         'ok',
      json_path:      jsonOnDisk,
      md_path:        fs.existsSync(mdOnDisk) ? mdOnDisk : null,
      flag_count:     full.flags.length,
      flag_counts:    s.flag_counts || { critical: 0, warning: 0, suggestion: 0, opportunity: 0 },
      quality_score:                s.overall_quality_score  != null ? s.overall_quality_score : null,
      medical_necessity_status:     s.medical_necessity_status || null,
      claim_defense_readiness:      s.claim_defense_readiness  || null,
      clinician_approval_required:  !!s.clinician_approval_required,
      icd_validated:                !!full.code_validation,
      skipped_reason:               null,
      error:                        null,
    }
  } catch (e) {
    log(`[cdi] fallback parse failed: ${e.message}`)
    return null
  }
}

module.exports = cdi
module.exports.synthesizeManifestFromDisk = synthesizeManifestFromDisk
