'use strict'

const fs   = require('fs')
const path = require('path')
const { parseSkillManifest } = require('../llm/skill-io/manifest')
const { CLAUDE_RATE_LIMITED } = require('../llm/skill-io/markers')
const { buildSingleCallEngineJson, parseJsonResponse } = require('../llm/skill-io/singleCall')
const { normalizeApiUsage } = require('../llm/pricing')
const { resolveCliModel } = require('../llm/modelOptions')
const lookup = require('../icd/lookup')
const coder  = require('../icd/coder')

/**
 * ICD-10 coding engine — API + LOCAL codeset (no `claude -p`, no MCP connector).
 *
 * Phase A: one Anthropic Messages-API call (add-icd-codes-api skill) proposes billable
 *          diagnosis candidates from the SOAP note (no tools).
 * Phase B: src/icd/coder.js cross-checks every candidate against the bundled FY2026
 *          codeset (src/icd/lookup.js) — validates existence/billable/description and
 *          re-resolves or flags anything that doesn't verify.
 * Phase C: appends (or replaces, on a pre-chart re-run) the `## ICD-10-CM Codes` table
 *          in the SOAP .md and writes a structured <stem>_icd.json.
 *
 * Runs via runEngine's API path (it exposes `runLlm`, like em-score/patient-summary) —
 * same gates/telemetry/service-warning wrapping as every other engine, so the chain and
 * both pre-chart re-run call sites invoke it unchanged. The agentic `add-icd-codes` skill
 * is retired (kept on disk for reference only) and is no longer invoked by any code path.
 */
const icd = {
  id:            'icd',
  skillId:       'add-icd-codes-api',
  label:         'ICD coding',
  jobKind:       'icd',
  stage:         'coding_icd',
  completesCase: false,

  // Unused on the API path (runEngine pins API engines to the resolved Anthropic model),
  // kept for descriptor-shape parity with the other engines.
  model: (cfg) => resolveCliModel(cfg.soapModel),
  effort: undefined,

  /** Gate: global enableIcd setting. */
  gates(ctx) {
    if (!ctx.config.get().enableIcd) return [{ reason: 'disabled' }]
    return []
  },

  buildInput(ctx, caseCtx) {
    return { soapNoteMdPath: caseCtx.soapNoteMdPath || null, caseDir: caseCtx.caseDir }
  },

  /**
   * API-only LLM runner (Phase A) + Node-side validation/write (Phases B/C).
   * Returns a normalized result whose `text` IS the synthesized run manifest.
   * Pinned to Anthropic — provider is always ctx.api.
   *
   * @param {{soapNoteMdPath:string|null, caseDir:string}} input
   * @param {AppContext} ctx
   * @param {CaseContext} caseCtx
   * @param {{ model:string, provider:object }} opts
   * @returns {Promise<{code, text, errText, usage, statusCode?, isRateLimit?}>}
   */
  async runLlm(input, ctx, caseCtx, { model, provider }) {
    const { log } = ctx
    const tag   = caseCtx?.caseTag ? `[${caseCtx.caseTag}] ` : ''
    const label = 'icd:api'

    // ---- Resolve the note + guard the codeset -----------------------------
    const notePath = (input.soapNoteMdPath && fs.existsSync(input.soapNoteMdPath))
      ? input.soapNoteMdPath
      : findSoapNote(input.caseDir)
    if (!notePath) { log(`${tag}[${label}] ERROR: SOAP note not found (caseDir=${input.caseDir})`); return { code: 1, errText: 'note_not_found' } }
    if (!lookup.isAvailable()) {
      log(`${tag}[${label}] [DEV-ALERT] local ICD-10 codeset unavailable at ${lookup.DB_PATH} — note left without codes`)
      return { code: 1, errText: 'icd_db_unavailable' }
    }

    const stem = path.basename(notePath).replace(/_soap_note\.md$/, '')

    // ---- Read inputs (Node, not the model) --------------------------------
    let noteText, skillText
    try {
      noteText  = fs.readFileSync(notePath, 'utf8')
      skillText = fs.readFileSync(path.join(ctx.paths.claudeDir, 'skills', 'add-icd-codes-api', 'SKILL.md'), 'utf8')
    } catch (e) {
      log(`${tag}[${label}] [DEV-ALERT] read inputs failed: ${e.message}`)
      return { code: 1, errText: `read inputs: ${e.message}` }
    }

    // ---- Phase A: propose candidates (single API call, no tools) ----------
    const { system, user } = buildSingleCallEngineJson({
      skillText,
      instruction: 'Propose the billable ICD-10-CM diagnosis candidates for THIS encounter. A local validator will verify every code against the FY2026 codeset, so give your best-supported code AND accurate search terms.',
      injectedFacts: [
        `Patient: ${stripDateSuffix(stem) || '(read from note)'}`,
        `Date of Service: ${dateFromCaseTag(caseCtx?.caseTag) || '(read from note)'}`,
      ],
      contextBlocks: [{ title: 'SOAP NOTE', body: noteText }],
      closer: 'Output the candidates JSON now — raw JSON only, no prose, no code fences.',
    })

    const r     = await provider.runSingleCall({ system, user, model, tag, label })
    const usage = normalizeApiUsage({ model, rawUsage: r.rawUsage, durationMs: r.durationMs })

    if (!r.ok) {
      log(`${tag}[${label}] [DEV-ALERT] API call failed: ${r.errText}`)
      return { code: 1, errText: r.errText, statusCode: r.statusCode, isRateLimit: r.statusCode === 429 || r.statusCode === 529, usage }
    }

    const parsed     = parseJsonResponse(r.text)
    const candidates = parsed && Array.isArray(parsed.candidates) ? parsed.candidates : null
    if (!candidates) {
      try { fs.writeFileSync(path.join(input.caseDir, `${stem}_icd.raw.txt`), r.text || '', 'utf8') } catch {}
      log(`${tag}[${label}] [DEV-ALERT] JSON parse failed — wrote ${stem}_icd.raw.txt`)
      return { code: 1, errText: 'json parse failed', usage }
    }

    // ---- Phase B: cross-check against the local codeset -------------------
    const { accepted: accepted0, flagged, codesAdded } = coder.crossCheck(candidates, lookup)
    // Float the model's first-listed (primary) diagnosis to row 1 of the table.
    const accepted = coder.orderByFirstListed(accepted0, parsed.first_listed)

    // ---- Phase C: write the table into the note (+ structured JSON) -------
    let status = 'ok'
    try {
      if (codesAdded > 0 || flagged.length) {
        const block = coder.buildCodesTable(accepted, flagged)
        fs.writeFileSync(notePath, coder.replaceOrAppendCodesSection(noteText, block), 'utf8')
      } else {
        status = 'skipped'   // genuinely no codeable diagnosis
      }
      const icdJsonPath = path.join(input.caseDir, `${stem}_icd.json`)
      fs.writeFileSync(icdJsonPath, JSON.stringify({
        meta: { generated_at: new Date().toISOString(), soap_note_path: notePath, model },
        accepted, flagged, candidates,
      }, null, 2), 'utf8')
      try { ctx.platform?.hideInternal?.(icdJsonPath) } catch {}
    } catch (e) {
      log(`${tag}[${label}] [DEV-ALERT] write failed: ${e.message}`)
      return { code: 1, errText: `write failed: ${e.message}`, usage }
    }

    log(`${tag}[${label}] ${status}: ${codesAdded} code(s) appended${flagged.length ? `, ${flagged.length} flagged for manual review` : ''} -> ${notePath}`)
    const manifest = { schema_version: 1, skill: 'add-icd-codes', status, codes_added: codesAdded, flagged: flagged.length, soap_note_path: notePath }
    return { code: 0, text: JSON.stringify(manifest), errText: '', usage }
  },

  /** Parse the synthesized manifest from runLlm's text. */
  interpret(runResult) {
    const combined    = (runResult.text || '') + '\n' + (runResult.errText || '')
    const rateLimited = !!runResult.isRateLimit || CLAUDE_RATE_LIMITED.test(combined)
    const manifest    = parseSkillManifest(runResult.text)
    if (manifest && manifest.skill === 'add-icd-codes') {
      return {
        ok:         manifest.status === 'ok',
        skipped:    manifest.status === 'skipped',
        codesAdded: manifest.codes_added ?? 0,
        flagged:    manifest.flagged ?? 0,
        rateLimited,
      }
    }
    return { ok: runResult.code === 0, skipped: false, codesAdded: 0, flagged: 0, rateLimited }
  },

  /** ICD writes the code table into the SOAP .md + a <stem>_icd.json — no DB columns. */
  persist() {},

  render(result) {
    if (!result) return null
    return { skipped: result.skipped, codesAdded: result.codesAdded }
  },
}

/** Absolute path of the case's SOAP note (excludes backups), or null. */
function findSoapNote(caseDir) {
  try {
    const f = fs.readdirSync(caseDir).find(x => x.endsWith('_soap_note.md') && !/_soap_note_backup_/.test(x))
    return f ? path.join(caseDir, f) : null
  } catch { return null }
}

/** Strip a trailing _YYYY-MM-DD[...] date suffix from a stem and de-underscore it. */
function stripDateSuffix(stem) {
  return stem ? stem.replace(/_\d{4}-\d{2}-\d{2}.*$/, '').replace(/_/g, ' ') : stem
}

/** MM/DD/YYYY from a caseTag containing a YYYY-MM-DD, or null. */
function dateFromCaseTag(caseTag) {
  const m = caseTag ? caseTag.match(/(\d{4})-(\d{2})-(\d{2})/) : null
  return m ? `${m[2]}/${m[3]}/${m[1]}` : null
}

module.exports = icd
