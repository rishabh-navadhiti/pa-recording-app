'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const {
  CLAUDE_RATE_LIMITED,
  ELEVENLABS_RATE_LIMITED,
  MCP_AUTH_ERROR,
  ELEVENLABS_AUTH_ERROR,
  DURATION_SECONDS,
  BACKUP_OK,
} = require('../../src/llm/skill-io/markers')

// ---- CLAUDE_RATE_LIMITED ---------------------------------------------------

test('CLAUDE_RATE_LIMITED matches rate.limit', () => {
  assert.ok(CLAUDE_RATE_LIMITED.test('Claude AI usage limit reached'))
  assert.ok(CLAUDE_RATE_LIMITED.test('RateLimitError: too many requests'))
  assert.ok(CLAUDE_RATE_LIMITED.test('overloaded — try again later'))
  assert.ok(CLAUDE_RATE_LIMITED.test('usage limit exceeded for this session'))
})

test('CLAUDE_RATE_LIMITED does not fire on unrelated text', () => {
  assert.ok(!CLAUDE_RATE_LIMITED.test('Patient has limited mobility'))
  assert.ok(!CLAUDE_RATE_LIMITED.test('The rate of recovery is good'))
  assert.ok(!CLAUDE_RATE_LIMITED.test('429 Unauthorized'))  // that is ElevenLabs
})

// ---- ELEVENLABS_RATE_LIMITED -----------------------------------------------

test('ELEVENLABS_RATE_LIMITED matches quota/429 patterns', () => {
  assert.ok(ELEVENLABS_RATE_LIMITED.test('429 Too Many Requests'))
  assert.ok(ELEVENLABS_RATE_LIMITED.test('quota.exceeded for this month'))
  assert.ok(ELEVENLABS_RATE_LIMITED.test('insufficient credit — add more'))
})

test('ELEVENLABS_RATE_LIMITED does not fire on Claude rate-limit text', () => {
  assert.ok(!ELEVENLABS_RATE_LIMITED.test('Claude AI usage limit reached'))
  assert.ok(!ELEVENLABS_RATE_LIMITED.test('RateLimitError'))
})

// ---- MCP_AUTH_ERROR --------------------------------------------------------

test('MCP_AUTH_ERROR matches connector auth failures', () => {
  assert.ok(MCP_AUTH_ERROR.test('Needs authentication to proceed'))
  assert.ok(MCP_AUTH_ERROR.test('MCP connection failed: refused'))
  assert.ok(MCP_AUTH_ERROR.test('MCP connect error'))
})

test('MCP_AUTH_ERROR does not fire on clinical 401 mention', () => {
  // A clinical note might say "401(k)" or "ICD-10 code 401.X" — should not trigger
  assert.ok(!MCP_AUTH_ERROR.test('The patient has a 401k retirement account'))
})

test('MCP_AUTH_ERROR fires on bare 401 (HTTP context)', () => {
  // A bare "401" in a non-clinical context (HTTP error from the connector) should fire
  assert.ok(MCP_AUTH_ERROR.test('HTTP 401'))
})

// ---- ELEVENLABS_AUTH_ERROR -------------------------------------------------

test('ELEVENLABS_AUTH_ERROR matches 401 / invalid key', () => {
  assert.ok(ELEVENLABS_AUTH_ERROR.test('401 Unauthorized'))
  assert.ok(ELEVENLABS_AUTH_ERROR.test('invalid.api.key provided'))
})

// ---- DURATION_SECONDS ------------------------------------------------------

test('DURATION_SECONDS extracts float', () => {
  const m = 'DURATION_SECONDS: 42.345'.match(DURATION_SECONDS)
  assert.ok(m, 'should match')
  assert.strictEqual(parseFloat(m[1]), 42.345)
})

test('DURATION_SECONDS does not match partial text', () => {
  assert.ok(!DURATION_SECONDS.test('duration: 42'))
  assert.ok(!DURATION_SECONDS.test('SECONDS: 42'))
})

// ---- BACKUP_OK -------------------------------------------------------------

test('BACKUP_OK extracts path', () => {
  const m = 'BACKUP_OK: /notes/Cases/jane_2026-06-04/backup.md'.match(BACKUP_OK)
  assert.ok(m, 'should match')
  assert.ok(m[1].endsWith('backup.md'))
})
