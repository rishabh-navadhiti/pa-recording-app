'use strict'

const fs   = require('fs')
const path = require('path')
const { parseSkillManifest } = require('../llm/skill-io/manifest')
const { CLAUDE_RATE_LIMITED } = require('../llm/skill-io/markers')
const { buildSingleCallEngineJson, parseJsonResponse } = require('../llm/skill-io/singleCall')
const { normalizeApiUsage } = require('../llm/pricing')
const { resolveCliModel } = require('../llm/modelOptions')

const patientSummary = {
  id:           'patient-summary',
  skillId:      'patient-summary',
  label:        'Patient summary',
  jobKind:      'patient_summary',
  stage:        'patient_summary',
  completesCase: false,

  model: (cfg) => resolveCliModel(cfg.soapModel),
  effort: 'high',

  /**
   * API-only LLM runner (replaces buildPrompt + ctx.llm.runSkill in runEngine for
   * this engine). Node reads the SOAP note, makes ONE Anthropic Messages-API call,
   * parses the returned JSON object, writes <stem>_patient_summary.json, and returns
   * a normalized result whose `text` IS the synthesized run manifest. Pinned to
   * Anthropic — provider is always ctx.api.
   *
   * @param {object} input                buildInput() result: { caseDir }
   * @param {AppContext} ctx
   * @param {CaseContext} caseCtx
   * @param {{ model: string, provider: object }} opts
   * @returns {Promise<{ code, text, errText, usage, statusCode?, isRateLimit? }>}
   */
  async runLlm(input, ctx, caseCtx, { model, provider }) {
    const { log } = ctx
    const { caseDir } = input
    const tag   = caseCtx?.caseTag ? `[${caseCtx.caseTag}] ` : ''
    const label = 'patient-summary:api'

    const fileStem = resolveFileStem(caseDir)
    const jsonPath = path.join(caseDir, `${fileStem}_patient_summary.json`)

    // ---- Read inputs (Node, not the model) --------------------------------
    let noteText = '', skillText = ''
    try {
      const notePath = findSoapNote(caseDir)
      if (!notePath) { log(`${tag}[${label}] ERROR: SOAP note not found in ${caseDir}`); return { code: 1, errText: 'note_not_found' } }
      noteText = fs.readFileSync(notePath, 'utf8')
      skillText = fs.readFileSync(path.join(ctx.paths.claudeDir, 'skills', 'patient-summary-api', 'SKILL.md'), 'utf8')
    } catch (e) {
      log(`${tag}[${label}] [DEV-ALERT] read inputs failed: ${e.message}`)
      return { code: 1, errText: `read inputs: ${e.message}` }
    }

    const { system, user } = buildSingleCallEngineJson({
      skillText,
      instruction: 'Write the plain-language patient summary for this note.',
      injectedFacts: [
        `case_dir: ${caseDir}`,
        `Patient: ${stripDateSuffix(fileStem) || '(read from note)'}`,
        `Doctor: ${caseCtx?.doctor?.name || '(read from note)'}`,
      ],
      contextBlocks: [
        { title: 'SOAP NOTE', body: noteText },
      ],
      closer: 'Output the _patient_summary.json JSON object now — raw JSON only, no prose, no code fences.',
    })

    const r = await provider.runSingleCall({ system, user, model, tag, label })
    const usage = normalizeApiUsage({ model, rawUsage: r.rawUsage, durationMs: r.durationMs })

    if (!r.ok) {
      log(`${tag}[${label}] [DEV-ALERT] API call failed: ${r.errText}`)
      return { code: 1, errText: r.errText, statusCode: r.statusCode, isRateLimit: r.statusCode === 429 || r.statusCode === 529, usage }
    }

    const parsed = parseJsonResponse(r.text)
    if (!parsed) {
      try { fs.writeFileSync(path.join(caseDir, `${fileStem}_patient_summary.raw.txt`), r.text || '', 'utf8') } catch {}
      log(`${tag}[${label}] [DEV-ALERT] JSON parse failed — wrote _patient_summary.raw.txt`)
      return { code: 1, errText: 'json parse failed', usage }
    }

    try {
      fs.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2), 'utf8')
      log(`${tag}[${label}] wrote ${jsonPath}`)
    } catch (e) {
      log(`${tag}[${label}] [DEV-ALERT] write failed: ${e.message}`)
      return { code: 1, errText: `write failed: ${e.message}`, usage }
    }

    return { code: 0, text: JSON.stringify(manifestFromPsObject(parsed, jsonPath)), errText: '', usage }
  },

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
  const jsonOnDisk = path.join(caseDir, `${resolveFileStem(caseDir)}_patient_summary.json`)
  if (!fs.existsSync(jsonOnDisk)) return null
  try {
    const full = JSON.parse(fs.readFileSync(jsonOnDisk, 'utf8'))
    if (!full) {
      log(`[patient-summary] fallback: _patient_summary.json present but malformed`)
      return null
    }
    return manifestFromPsObject(full, jsonOnDisk)
  } catch (e) {
    log(`[patient-summary] fallback parse failed: ${e.message}`)
    return null
  }
}

/**
 * Resolve the case file stem — anchored on the existing *_soap_note.md if present,
 * else the case-dir basename. Shared by runLlm (output path) and the disk fallback.
 */
function resolveFileStem(caseDir) {
  let fileStem = path.basename(caseDir)
  try {
    const soapMd = fs.readdirSync(caseDir).find(f => f.endsWith('_soap_note.md'))
    if (soapMd) fileStem = soapMd.replace(/_soap_note\.md$/, '')
  } catch {}
  return fileStem
}

/** Absolute path of the case's SOAP note (excludes backups), or null. */
function findSoapNote(caseDir) {
  try {
    const f = fs.readdirSync(caseDir).find(x => x.endsWith('_soap_note.md') && !/_soap_note_backup_/.test(x))
    return f ? path.join(caseDir, f) : null
  } catch { return null }
}

/** Strip a trailing _YYYY-MM-DD[...] date suffix from a file/case stem. */
function stripDateSuffix(stem) {
  return stem ? stem.replace(/_\d{4}-\d{2}-\d{2}.*$/, '') : stem
}

/**
 * Build the engine run manifest from a parsed _patient_summary.json object.
 * patient-summary has no skip path — a real note always yields a summary, so
 * status is always 'ok' here (the toggle gate fires earlier in runEngine when off).
 * Used by both runLlm (in-memory) and synthesizePatientSummaryFromDisk (recovery).
 */
function manifestFromPsObject(obj, jsonPath) {
  return {
    schema_version: 1,
    skill:          'patient-summary',
    status:         'ok',
    json_path:      jsonPath,
    reading_level:  obj?.reading_level ?? 'grade 6',
    skipped_reason: null,
    error:          null,
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
