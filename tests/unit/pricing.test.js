'use strict'

// Tests for src/llm/pricing.js — focus on the gpt-5.6-luna cost path, which is
// what keeps processing_events.cost_usd populating for luna notes. The provider
// emits Anthropic-shaped rawUsage keys, so calcCost/normalizeApiUsage need no
// per-provider branch — only the PRICE_TABLE row.

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { PRICE_TABLE, calcCost, normalizeApiUsage } = require('../../src/llm/pricing')

test('PRICE_TABLE has a gpt-5.6-luna row keyed by the model string', () => {
  assert.ok(PRICE_TABLE['gpt-5.6-luna'], 'luna price row must be keyed by the model id calcCost receives')
  assert.deepEqual(PRICE_TABLE['gpt-5.6-luna'], { in: 1, out: 6, cacheRead: 0.10, cacheWrite: 0 })
})

test('calcCost(gpt-5.6-luna) splits cache-read out of prompt tokens correctly', () => {
  // rawUsage as emitted by openaiApiProvider: input_tokens includes cached.
  const rawUsage = { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 400 }
  // inTokens = 1000 - 400 = 600 (@ $1/M) + 400 cacheRead (@ $0.10/M) + 300 out (@ $6/M)
  const expected = (600 * 1 + 400 * 0.10 + 300 * 6) / 1_000_000
  assert.ok(Math.abs(calcCost('gpt-5.6-luna', rawUsage) - expected) < 1e-12)
})

test('calcCost(gpt-5.6-luna) with no cache read', () => {
  const rawUsage = { input_tokens: 1000, output_tokens: 300 }
  const expected = (1000 * 1 + 300 * 6) / 1_000_000
  assert.ok(Math.abs(calcCost('gpt-5.6-luna', rawUsage) - expected) < 1e-12)
})

test('calcCost returns null for an unknown model', () => {
  assert.equal(calcCost('some-unknown-model', { input_tokens: 10, output_tokens: 10 }), null)
})

test('normalizeApiUsage(gpt-5.6-luna) produces a non-null costUsd and the normalized record', () => {
  const rawUsage = { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 400 }
  const rec = normalizeApiUsage({ model: 'gpt-5.6-luna', rawUsage, durationMs: 1234 })
  assert.equal(rec.inputTokens, 1000)
  assert.equal(rec.outputTokens, 300)
  assert.equal(rec.cacheReadTokens, 400)
  assert.equal(rec.cacheCreatedTokens, null)   // OpenAI has no cache-write concept
  assert.equal(rec.numTurns, 1)
  assert.equal(rec.durationMs, 1234)
  assert.ok(rec.costUsd > 0, 'cost_usd must populate for luna (dashboards depend on it)')
})
