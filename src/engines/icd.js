'use strict'

const path = require('path')
const { CLAUDE_RATE_LIMITED, MCP_AUTH_ERROR } = require('../llm/skill-io/markers')
const { resolveCliModel } = require('../llm/modelOptions')

const icd = {
  id:           'icd',
  skillId:      'add-icd-codes',
  label:        'ICD coding',
  jobKind:      'icd',
  stage:        'coding_icd',
  completesCase: false,

  model: (cfg) => resolveCliModel(cfg.soapModel),
  effort: undefined,

  /**
   * Gate: global enableIcd setting.
   * Returns [{reason}] if the engine should be skipped, [] if it should run.
   */
  gates(ctx) {
    if (!ctx.config.get().enableIcd) return [{ reason: 'disabled' }]
    return []
  },

  buildInput(ctx, caseCtx) {
    const soapRel = path.relative(ctx.paths.notesDir, caseCtx.soapNoteMdPath).replace(/\\/g, '/')
    return { soapRel }
  },

  /**
   * Parse the JSON manifest emitted by the add-icd-codes skill (B6 migration).
   * Falls back to ICD_SKIPPED text detection for backward compat with older
   * skill versions still in flight during a rolling deploy.
   */
  interpret(runResult) {
    const combined = (runResult.text || '') + '\n' + (runResult.errText || '')
    const rateLimited = CLAUDE_RATE_LIMITED.test(combined)
    const mcpError    = MCP_AUTH_ERROR.test(combined)

    // Try JSON manifest first (new protocol).
    const { parseSkillManifest } = require('../llm/skill-io/manifest')
    const manifest = parseSkillManifest(runResult.text)
    if (manifest && manifest.skill === 'add-icd-codes') {
      return {
        ok:          manifest.status === 'ok',
        skipped:     manifest.status === 'skipped',
        codesAdded:  manifest.codes_added ?? 0,
        rateLimited,
        mcpError,
      }
    }

    // Backward compat: older skill emits ICD_SKIPPED text marker.
    return {
      ok:          runResult.code === 0,
      skipped:     /ICD_SKIPPED/i.test(combined),
      codesAdded:  0,
      rateLimited,
      mcpError,
    }
  },

  /** ICD appends codes directly to the SOAP .md — no extra DB columns to update here. */
  persist() {},

  render(result) {
    if (!result) return null
    return { skipped: result.skipped }
  },
}

module.exports = icd
