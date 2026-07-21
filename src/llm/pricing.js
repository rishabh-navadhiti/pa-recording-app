'use strict'

// Per-million-token pricing (USD). Anthropic rows: Anthropic pricing page, June 2026.
// OpenAI rows: OpenAI pricing (gpt-5.6-luna, per the luna handoff). OpenAI has no
// cache-write concept, so cacheWrite is 0. calcCost reads Anthropic-shaped rawUsage
// keys, which openaiApiProvider maps into (input_tokens/output_tokens/
// cache_read_input_tokens), so no per-provider calcCost branch is needed.
const PRICE_TABLE = {
  'claude-sonnet-4-6':         { in: 3,    out: 15,  cacheRead: 0.30, cacheWrite: 3.75  },
  'claude-opus-4-8':           { in: 15,   out: 75,  cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-haiku-4-5-20251001': { in: 0.80, out: 4,   cacheRead: 0.08, cacheWrite: 1     },
  'gpt-5.6-luna':              { in: 1,    out: 6,   cacheRead: 0.10, cacheWrite: 0     },
}

function calcCost(model, rawUsage) {
  const price = PRICE_TABLE[model]
  if (!price || !rawUsage) return null
  const cacheRead  = rawUsage.cache_read_input_tokens     || 0
  const cacheWrite = rawUsage.cache_creation_input_tokens || 0
  const inTokens   = (rawUsage.input_tokens || 0) - cacheRead - cacheWrite
  const outTokens  = rawUsage.output_tokens || 0
  return (
    (inTokens   * price.in        / 1_000_000) +
    (cacheRead  * price.cacheRead / 1_000_000) +
    (cacheWrite * price.cacheWrite / 1_000_000) +
    (outTokens  * price.out       / 1_000_000)
  )
}

// Convert a raw Anthropic Messages API usage object to the normalized record
// shape shared with the CLI provider (see src/llm/usage.js extractUsage).
function normalizeApiUsage({ model, rawUsage, durationMs }) {
  if (!rawUsage) return {}
  return {
    inputTokens:        rawUsage.input_tokens               ?? null,
    outputTokens:       rawUsage.output_tokens              ?? null,
    cacheReadTokens:    rawUsage.cache_read_input_tokens    ?? null,
    cacheCreatedTokens: rawUsage.cache_creation_input_tokens ?? null,
    costUsd:            calcCost(model, rawUsage),
    numTurns:           1,
    durationMs:         durationMs ?? null,
  }
}

module.exports = { PRICE_TABLE, calcCost, normalizeApiUsage }
