'use strict'

const path = require('path')
const { parseSkillManifest } = require('../llm/skill-io/manifest')

/**
 * SOAP note generation engine descriptor.
 * completesCase: true — the chain marks the case complete when this engine's
 * downstream docx conversion finishes.
 */
const soap = {
  id:           'soap',
  skillId:      'generate-note',
  label:        'SOAP generation',
  jobKind:      'soap',
  stage:        'generating_note',
  completesCase: true,

  /** @param {object} cfg - readSettings() result */
  model: (cfg) => cfg.soapModel || 'claude-sonnet-4-6',
  effort: undefined,  // SOAP uses default effort

  /** No gates — SOAP always runs when the chain is invoked. */
  gates: () => [],

  /** Build the structured input for buildPrompt('generate-note', input). */
  buildInput(ctx, caseCtx) {
    const { transcriptAbsPath, templatePath } = caseCtx
    const notesDir = ctx.paths.notesDir
    const transcriptRel = path.relative(notesDir, transcriptAbsPath).replace(/\\/g, '/')
    const templateRel = templatePath
      ? path.relative(notesDir, templatePath).replace(/\\/g, '/')
      : null
    return { templateRel, transcriptRel }
  },

  /**
   * Parse the manifest from the skill's final text.
   * Returns the parsed manifest object or null on failure.
   * chain.js branches on multi_patient after this.
   */
  interpret(runResult) {
    return parseSkillManifest(runResult.text)
  },

  /** DB writes happen in chain.js after manifest branching — nothing to do here. */
  persist() {},

  render(result) {
    if (!result) return null
    return { status: result.status }
  },
}

module.exports = soap
