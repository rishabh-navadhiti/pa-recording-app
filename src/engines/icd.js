'use strict'

const path = require('path')
const { CLAUDE_RATE_LIMITED, MCP_AUTH_ERROR } = require('../llm/skill-io/markers')

const icd = {
  id:           'icd',
  skillId:      'add-icd-codes',
  label:        'ICD coding',
  jobKind:      'icd',
  stage:        'coding_icd',
  completesCase: false,

  model: (cfg) => cfg.soapModel || 'claude-sonnet-4-6',
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
   * Classify the ICD skill output.
   * Note: ICD_OK: is currently not explicitly parsed — the skill appends codes
   * to the SOAP .md in place; success is inferred from exit code 0 + no error
   * markers. ICD_SKIPPED: signals no diagnoses found (still a success, no codes
   * added). B6 migration (Phase 2 Group 9) will replace this with a manifest parse.
   */
  interpret(runResult) {
    const combined = (runResult.text || '') + '\n' + (runResult.errText || '')
    return {
      ok:          runResult.code === 0,
      skipped:     /ICD_SKIPPED/i.test(combined),
      rateLimited: CLAUDE_RATE_LIMITED.test(combined),
      mcpError:    MCP_AUTH_ERROR.test(combined),
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
