'use strict'

const fs   = require('fs')
const path = require('path')
const { parseSkillManifest } = require('../llm/skill-io/manifest')
const { CLAUDE_RATE_LIMITED } = require('../llm/skill-io/markers')
const { buildSingleCallEngineJson, parseJsonResponse } = require('../llm/skill-io/singleCall')
const { normalizeApiUsage } = require('../llm/pricing')

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
   * API-only LLM runner (replaces buildPrompt + ctx.llm.runSkill in runEngine for
   * this engine). Node reads the note + transcript + MDM pack, makes ONE Anthropic
   * Messages-API call, parses the returned JSON object, writes <stem>_em.json, and
   * returns a normalized result whose `text` IS the synthesized run manifest (the
   * same shape interpret() parses). Pinned to Anthropic — provider is always ctx.api.
   *
   * @param {object} input                buildInput() result: { caseDir, specialty, standardsDir }
   * @param {AppContext} ctx
   * @param {CaseContext} caseCtx
   * @param {{ model: string, provider: object }} opts
   * @returns {Promise<{ code, text, errText, usage, statusCode?, isRateLimit? }>}
   */
  async runLlm(input, ctx, caseCtx, { model, provider }) {
    const { log } = ctx
    const { caseDir, specialty, standardsDir } = input
    const tag   = caseCtx?.caseTag ? `[${caseCtx.caseTag}] ` : ''
    const label = 'em-score:api'

    const fileStem = resolveFileStem(caseDir)
    const jsonPath = path.join(caseDir, `${fileStem}_em.json`)

    // ---- Read inputs (Node, not the model) --------------------------------
    let noteText = '', transcriptText = '', emPackText = '', skillText = ''
    try {
      const notePath = findSoapNote(caseDir)
      if (!notePath) { log(`${tag}[${label}] ERROR: SOAP note not found in ${caseDir}`); return { code: 1, errText: 'note_not_found' } }
      noteText = fs.readFileSync(notePath, 'utf8')

      const txPath = findTranscript(caseDir)
      if (txPath) transcriptText = fs.readFileSync(txPath, 'utf8')

      const emPackPath = path.join(standardsDir, 'em_mdm_2021.md')
      if (!fs.existsSync(emPackPath)) { log(`${tag}[${label}] ERROR: em_mdm_2021.md not found: ${emPackPath}`); return { code: 1, errText: `em_mdm_2021.md standards pack not found: ${emPackPath}` } }
      emPackText = fs.readFileSync(emPackPath, 'utf8')

      skillText = fs.readFileSync(path.join(ctx.paths.claudeDir, 'skills', 'em-score-api', 'SKILL.md'), 'utf8')
    } catch (e) {
      log(`${tag}[${label}] [DEV-ALERT] read inputs failed: ${e.message}`)
      return { code: 1, errText: `read inputs: ${e.message}` }
    }

    const { system, user } = buildSingleCallEngineJson({
      skillText,
      instruction: 'Score the AMA 2021 office/outpatient E/M level for this note.',
      injectedFacts: [
        `case_dir: ${caseDir}`,
        `Patient: ${stripDateSuffix(fileStem) || '(read from note)'}`,
        `Doctor: ${caseCtx?.doctor?.name || '(read from note)'}`,
        `Date of Service: ${dateFromCaseTag(caseCtx?.caseTag) || '(read from note)'}`,
        `Specialty: ${specialty || '(none)'}`,
      ],
      contextBlocks: [
        { title: 'SOAP NOTE', body: noteText },
        { title: 'TRANSCRIPT (optional cross-reference — may carry total visit time or data reviewed)', body: transcriptText },
        { title: 'MDM FRAMEWORK PACK (em_mdm_2021.md — score against these tables)', body: emPackText },
      ],
      closer: 'Output the _em.json JSON object now — raw JSON only, no prose, no code fences.',
    })

    const r = await provider.runSingleCall({ system, user, model, tag, label })
    const usage = normalizeApiUsage({ model, rawUsage: r.rawUsage, durationMs: r.durationMs })

    if (!r.ok) {
      log(`${tag}[${label}] [DEV-ALERT] API call failed: ${r.errText}`)
      return { code: 1, errText: r.errText, statusCode: r.statusCode, isRateLimit: r.statusCode === 429 || r.statusCode === 529, usage }
    }

    const parsed = parseJsonResponse(r.text)
    if (!parsed) {
      try { fs.writeFileSync(path.join(caseDir, `${fileStem}_em.raw.txt`), r.text || '', 'utf8') } catch {}
      log(`${tag}[${label}] [DEV-ALERT] JSON parse failed — wrote _em.raw.txt`)
      return { code: 1, errText: 'json parse failed', usage }
    }

    try {
      fs.writeFileSync(jsonPath, JSON.stringify(parsed, null, 2), 'utf8')
      log(`${tag}[${label}] wrote ${jsonPath}`)
    } catch (e) {
      log(`${tag}[${label}] [DEV-ALERT] write failed: ${e.message}`)
      return { code: 1, errText: `write failed: ${e.message}`, usage }
    }

    return { code: 0, text: JSON.stringify(manifestFromEmObject(parsed, jsonPath)), errText: '', usage }
  },

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
 * Resolve the case file stem — anchored on the existing *_soap_note.md if present,
 * else the case-dir basename. Shared by runLlm (output path) and the disk fallback
 * so they always agree on <stem>_em.json.
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

/** Absolute path of the case transcript (transcript.md or *_transcript.md), or null. */
function findTranscript(caseDir) {
  try {
    const f = fs.readdirSync(caseDir).find(x => x === 'transcript.md' || x.endsWith('_transcript.md'))
    return f ? path.join(caseDir, f) : null
  } catch { return null }
}

/** Strip a trailing _YYYY-MM-DD[...] date suffix from a file/case stem. */
function stripDateSuffix(stem) {
  return stem ? stem.replace(/_\d{4}-\d{2}-\d{2}.*$/, '') : stem
}

/** MM/DD/YYYY from a caseTag containing a YYYY-MM-DD, or null. */
function dateFromCaseTag(caseTag) {
  const m = caseTag ? caseTag.match(/(\d{4})-(\d{2})-(\d{2})/) : null
  return m ? `${m[2]}/${m[3]}/${m[1]}` : null
}

/**
 * Build the engine run manifest from a parsed _em.json object. A `skipped_reason`
 * in the JSON (note isn't a scorable office E/M) maps to status 'skipped' with the
 * level fields nulled; otherwise status 'ok'. Used by both runLlm (in-memory) and
 * synthesizeEmFromDisk (on-disk recovery).
 */
function manifestFromEmObject(obj, jsonPath) {
  const skipped = !!(obj && obj.skipped_reason)
  return {
    schema_version:       1,
    skill:                'em-score',
    status:               skipped ? 'skipped' : 'ok',
    json_path:            jsonPath,
    predicted_em_level:   skipped ? null : (obj?.predicted_em_level   ?? null),
    predicted_complexity: skipped ? null : (obj?.predicted_complexity ?? null),
    downcode_risk:        skipped ? null : (obj?.downcode_risk        ?? null),
    skipped_reason:       skipped ? obj.skipped_reason : null,
    error:                null,
  }
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
  const jsonOnDisk = path.join(caseDir, `${resolveFileStem(caseDir)}_em.json`)
  if (!fs.existsSync(jsonOnDisk)) return null
  try {
    const full = JSON.parse(fs.readFileSync(jsonOnDisk, 'utf8'))
    if (!full) {
      log(`[em-score] fallback: _em.json present but malformed`)
      return null
    }
    return manifestFromEmObject(full, jsonOnDisk)
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
