'use strict'

/**
 * Provider interface — every LLM provider implements this shape.
 *
 * @typedef {Object} RunSkillOpts
 * @property {string}   prompt      The prompt string to pass as `claude -p <prompt>`.
 * @property {string}   [model]     Model ID override.
 * @property {string}   [effort]    'low'|'high'|'max' — maps to CLAUDE_CODE_EFFORT_LEVEL env.
 * @property {string}   [tag]       Log prefix tag, e.g. '[jane_doe_2026-06-04] '.
 * @property {string}   [label]     Step label for log lines, e.g. 'soap', 'icd'.
 * @property {object}   [env]       Extra environment variables for the subprocess.
 *
 * @typedef {Object} RunSkillResult
 * @property {number}      code         Exit code (0 = success).
 * @property {string}      text         The model's final response text.
 * @property {object|null} resultEvent  Full parsed stream-json result event (usage, cost, etc.).
 * @property {string}      errText      Combined stderr from the subprocess.
 *
 * @typedef {Object} LlmProvider
 * @property {(opts: RunSkillOpts) => Promise<RunSkillResult>} runSkill
 *   Run a skill prompt and return the result. Always resolves (never rejects) —
 *   spawn errors are surfaced via `code: null` and `errText`.
 */

// This file is a typedef-only module. Implementations live alongside it:
//   claudeCliProvider.js — current production impl (claude -p, stream-json)
//   (future: agentSdkProvider.js, <vendor>Provider.js)

module.exports = {}
