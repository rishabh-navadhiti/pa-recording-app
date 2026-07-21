'use strict'

// Per-million-token pricing (USD). Source: Anthropic pricing page, June 2026.
// Sonnet 5 row added 2026-07-21 from platform.claude.com/docs/en/about-claude/pricing.
const PRICE_TABLE = {
  'claude-sonnet-4-6':         { in: 3,    out: 15,  cacheRead: 0.30, cacheWrite: 3.75  },
  'claude-opus-4-8':           { in: 15,   out: 75,  cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-haiku-4-5-20251001': { in: 0.80, out: 4,   cacheRead: 0.08, cacheWrite: 1     },
  // Sonnet 5 introductory pricing (in effect through 2026-08-31). Standard pricing
  // from 2026-09-01 is $3 in / $15 out / $0.30 read / $3.75 write — update then.
  'claude-sonnet-5':           { in: 2,    out: 10,  cacheRead: 0.20, cacheWrite: 2.50  },
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
