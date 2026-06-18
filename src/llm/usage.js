'use strict'

/**
 * Extract token + cost fields from a Claude stream-json `result` event
 * for DB writes. Returns an empty object when `ev` is null/undefined so
 * callers can safely spread: `...extractUsage(resultEvent)`.
 *
 * @param {object|null} ev  The parsed stream-json result event.
 * @returns {{ inputTokens, outputTokens, cacheReadTokens, cacheCreatedTokens,
 *             costUsd, numTurns, durationMs }}
 */
function extractUsage(ev) {
  if (!ev) return {}
  const u = ev.usage || {}
  return {
    inputTokens:        u.input_tokens               ?? null,
    outputTokens:       u.output_tokens              ?? null,
    cacheReadTokens:    u.cache_read_input_tokens    ?? null,
    cacheCreatedTokens: u.cache_creation_input_tokens ?? null,
    costUsd:            ev.total_cost_usd            ?? null,
    numTurns:           ev.num_turns                 ?? null,
    durationMs:         ev.duration_ms               ?? null,
  }
}

/**
 * Log a skill's final stream-json `result` event as one grep-able line.
 * The event contains the model text, usage, cost, num_turns, duration, etc.
 *
 * @param {Function} logFn     Logger function (ctx.log or log shim).
 * @param {string}   tag       Case tag prefix, e.g. '[jane_doe_2026-06-04] '
 * @param {string}   kind      Step label, e.g. 'soap', 'icd', 'cdi'
 * @param {object|null} resultEvent  Parsed result event from stream-json output.
 */
function logSkillStream(logFn, tag, kind, resultEvent) {
  if (!resultEvent) {
    logFn(`${tag}[${kind}][stream] (no result event captured)`)
    return
  }
  try {
    logFn(`${tag}[${kind}][stream] ${JSON.stringify(resultEvent)}`)
  } catch (e) {
    logFn(`${tag}[${kind}][stream] (stringify failed: ${e.message})`)
  }
}

module.exports = { extractUsage, logSkillStream }
