'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { isCostiganDoctor, extractChecklistJson } = require('../../src/jobs/costiganChecklist')

test('isCostiganDoctor matches by lastname, case-insensitive', () => {
  assert.equal(isCostiganDoctor({ lastname: 'Costigan' }), true)
  assert.equal(isCostiganDoctor({ name: 'William M. Costigan, M.D.' }), true)
  assert.equal(isCostiganDoctor({ name: 'Dr. Sabbag' }), false)
  assert.equal(isCostiganDoctor(null), false)
})

test('extractChecklistJson tolerates code fences and leading prose', () => {
  assert.deepEqual(extractChecklistJson('```json\n{"summary":{"overall_status":"no_procedure"}}\n```'), { summary: { overall_status: 'no_procedure' } })
  assert.deepEqual(extractChecklistJson('Here is the result:\n{"a":1}'), { a: 1 })
  assert.equal(extractChecklistJson('not json at all'), null)
})
