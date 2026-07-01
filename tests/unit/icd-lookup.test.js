'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const lookup = require('../../src/icd/lookup')

// These exercise the bundled FY2026 codeset (data/icd/icd10cm_fy2026.db) through
// better-sqlite3. Skipped (not failed) if the DB or native module can't open, so the
// suite stays green in environments without the committed DB.
const DB_OK = lookup.isAvailable()
const opts = { skip: DB_OK ? false : 'local ICD-10 codeset not available' }

test('validate: a billable leaf exists + is billable, with the right description', opts, () => {
  const v = lookup.validate('M54.50')
  assert.strictEqual(v.exists, true)
  assert.strictEqual(v.billable, true)
  assert.match(v.short, /low back pain/i)
})

test('validate: a category header exists but is NOT billable', opts, () => {
  const v = lookup.validate('M19.07')
  assert.strictEqual(v.exists, true)
  assert.strictEqual(v.billable, false)
})

test('validate: a nonexistent code returns exists=false', opts, () => {
  assert.strictEqual(lookup.validate('M99.999').exists, false)
})

test('validate: accepts dotless input and normalizes it', opts, () => {
  const v = lookup.validate('M5450')
  assert.strictEqual(v.code, 'M54.50')
  assert.strictEqual(v.billable, true)
})

test('hasMoreSpecificBillableChild: false for De Quervain M65.4 (no laterality children)', opts, () => {
  assert.strictEqual(lookup.hasMoreSpecificBillableChild('M65.4'), false)
})

test('hasMoreSpecificBillableChild: true for the osteophyte header M25.77', opts, () => {
  assert.strictEqual(lookup.hasMoreSpecificBillableChild('M25.77'), true)
})

test('search: description search finds the expected billable code', opts, () => {
  const results = lookup.search('low back pain unspecified')
  assert.ok(results.some(r => r.code === 'M54.50'), 'M54.50 should be among the results')
})
