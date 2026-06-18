'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { extractUsage, logSkillStream } = require('../../src/llm/usage')

// ---- extractUsage ----------------------------------------------------------

test('extractUsage returns empty object for null', () => {
  assert.deepStrictEqual(extractUsage(null), {})
  assert.deepStrictEqual(extractUsage(undefined), {})
})

test('extractUsage maps all fields from a full result event', () => {
  const ev = {
    usage: {
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    },
    total_cost_usd: 0.0042,
    num_turns: 3,
    duration_ms: 1234,
  }
  const result = extractUsage(ev)
  assert.strictEqual(result.inputTokens, 100)
  assert.strictEqual(result.outputTokens, 200)
  assert.strictEqual(result.cacheReadTokens, 50)
  assert.strictEqual(result.cacheCreatedTokens, 10)
  assert.strictEqual(result.costUsd, 0.0042)
  assert.strictEqual(result.numTurns, 3)
  assert.strictEqual(result.durationMs, 1234)
})

test('extractUsage returns nulls for missing sub-fields', () => {
  const ev = { usage: {}, total_cost_usd: 0.001 }
  const result = extractUsage(ev)
  assert.strictEqual(result.inputTokens, null)
  assert.strictEqual(result.outputTokens, null)
  assert.strictEqual(result.costUsd, 0.001)
})

test('extractUsage with no usage field at all', () => {
  const ev = { total_cost_usd: 0.002, num_turns: 1, duration_ms: 500 }
  const result = extractUsage(ev)
  assert.strictEqual(result.inputTokens, null)
  assert.strictEqual(result.costUsd, 0.002)
})

// ---- logSkillStream --------------------------------------------------------

test('logSkillStream logs (no result event) when null', () => {
  const lines = []
  logSkillStream((msg) => lines.push(msg), '[case] ', 'soap', null)
  assert.ok(lines[0].includes('no result event captured'))
})

test('logSkillStream logs JSON-stringified event', () => {
  const lines = []
  const ev = { type: 'result', result: 'SOAP note...', usage: { input_tokens: 50 } }
  logSkillStream((msg) => lines.push(msg), '[case] ', 'soap', ev)
  assert.ok(lines[0].includes('[stream]'))
  assert.ok(lines[0].includes('"result"'))
})
