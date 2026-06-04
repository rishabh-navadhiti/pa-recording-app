'use strict'

// Drift tests for src/shared/ constants vs their copies in renderer/renderer.js.
// renderer.js is a browser script (no module.exports), so we read it as text
// and extract the literal values with regex. When Phase 4 wires renderer.js
// to import from src/shared/ directly, these regex-based assertions can be
// replaced with a simple require() check.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const { STATE } = require('../../src/shared/state')
const { STATUS_LABELS } = require('../../src/shared/pipeline-status')
const { DOCTOR_SPECIALTIES } = require('../../src/shared/specialties')
const { CHANNELS } = require('../../src/shared/ipc-channels')

const rendererSrc = fs.readFileSync(
  path.join(__dirname, '../../renderer/renderer.js'), 'utf8'
)

// Extract key:'value' pairs from a `const NAME = { ... }` block in a JS file.
function extractObjectLiteral(src, name) {
  const match = src.match(new RegExp(`const ${name}\\s*=\\s*\\{([^}]+)\\}`, 'ms'))
  if (!match) return null
  const pairs = {}
  for (const [, k, v] of match[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)) {
    pairs[k] = v
  }
  return pairs
}

// Extract [{value:'x', label:'y'}, ...] from a `const NAME = [ ... ]` block.
function extractArrayLiteral(src, name) {
  const match = src.match(new RegExp(`const ${name}\\s*=\\s*\\[([^\\]]+)\\]`, 'ms'))
  if (!match) return null
  const items = []
  for (const [, v, l] of match[1].matchAll(/value\s*:\s*'([^']+)'[^}]+label\s*:\s*'([^']+)'/g)) {
    items.push({ value: v, label: l })
  }
  return items
}

// ---- STATE drift ----

test('shared STATE values match the renderer.js STATE literal', () => {
  const rendererState = extractObjectLiteral(rendererSrc, 'STATE')
  assert.ok(rendererState, 'STATE should be found in renderer.js')

  // Every key in shared STATE must be in renderer.js with the same value.
  for (const [key, value] of Object.entries(STATE)) {
    assert.strictEqual(
      rendererState[key],
      value,
      `STATE.${key} differs: shared='${value}' renderer='${rendererState[key]}'`
    )
  }

  // Every key in renderer.js STATE must be in the shared STATE.
  for (const key of Object.keys(rendererState)) {
    assert.ok(
      key in STATE,
      `renderer.js STATE has key '${key}' not present in src/shared/state.js`
    )
  }
})

// ---- DOCTOR_SPECIALTIES drift ----

test('shared DOCTOR_SPECIALTIES values match the renderer.js literal', () => {
  const rendererSpecialties = extractArrayLiteral(rendererSrc, 'DOCTOR_SPECIALTIES')
  assert.ok(rendererSpecialties, 'DOCTOR_SPECIALTIES should be found in renderer.js')

  assert.strictEqual(
    rendererSpecialties.length,
    DOCTOR_SPECIALTIES.length,
    'DOCTOR_SPECIALTIES length mismatch between shared and renderer.js'
  )

  for (let i = 0; i < DOCTOR_SPECIALTIES.length; i++) {
    assert.strictEqual(
      rendererSpecialties[i].value,
      DOCTOR_SPECIALTIES[i].value,
      `DOCTOR_SPECIALTIES[${i}].value mismatch`
    )
    assert.strictEqual(
      rendererSpecialties[i].label,
      DOCTOR_SPECIALTIES[i].label,
      `DOCTOR_SPECIALTIES[${i}].label mismatch`
    )
  }
})

// ---- CHANNELS completeness ----

test('CHANNELS map contains all channel strings from preload.js', () => {
  const preloadSrc = fs.readFileSync(
    path.join(__dirname, '../../preload.js'), 'utf8'
  )
  // Extract all 'channel-name' string literals from ipcRenderer.invoke/on calls.
  const channelStrings = new Set()
  for (const [, ch] of preloadSrc.matchAll(/ipcRenderer\.(?:invoke|on)\s*\(\s*'([^']+)'/g)) {
    channelStrings.add(ch)
  }

  const channelValues = new Set(Object.values(CHANNELS))

  for (const ch of channelStrings) {
    assert.ok(
      channelValues.has(ch),
      `preload.js channel '${ch}' is not present in src/shared/ipc-channels.js CHANNELS map`
    )
  }
})

// ---- src/shared/state.js structural check ----

test('shared STATE has exactly the 5 expected values', () => {
  const expected = ['IDLE', 'SESSION_ACTIVE', 'RECORDING', 'PAUSED', 'PROCESSING']
  for (const key of expected) {
    assert.strictEqual(STATE[key], key, `STATE.${key} should equal '${key}'`)
  }
  assert.strictEqual(Object.keys(STATE).length, expected.length, 'STATE should have exactly 5 keys')
})
