'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { buildSingleCallNoteGen } = require('../../src/llm/skill-io/singleCall')

const BASE = {
  skillText: '---\nname: generate-note-api\n---\nSYSTEM BODY',
  templateText: 'TEMPLATE BODY',
  transcriptText: 'TRANSCRIPT BODY',
  caseDir: '/notes/Cases/jane_2026-06-24',
  soapNoteMdPath: '/notes/Cases/jane_2026-06-24/jane_2026-06-24_soap_note.md',
  doctorLastname: 'sabbag',
}

test('buildSingleCallNoteGen omits PRE-CHART CONTEXT when none given', () => {
  const { user } = buildSingleCallNoteGen({ ...BASE })
  assert.ok(!user.includes('PRE-CHART CONTEXT'), 'should not inject the block')
})

test('buildSingleCallNoteGen omits PRE-CHART CONTEXT when blank/whitespace', () => {
  const { user } = buildSingleCallNoteGen({ ...BASE, prechartText: '   \n  ' })
  assert.ok(!user.includes('PRE-CHART CONTEXT'))
})

test('buildSingleCallNoteGen injects PRE-CHART CONTEXT before the template', () => {
  const { user } = buildSingleCallNoteGen({ ...BASE, prechartText: 'Prior ACL repair 2021.' })
  assert.ok(user.includes('PRE-CHART CONTEXT'), 'block header present')
  assert.ok(user.includes('Prior ACL repair 2021.'), 'context text present')
  // ordering: INJECTED FACTS → PRE-CHART CONTEXT → DOCTOR TEMPLATE → TRANSCRIPT
  const iFacts   = user.indexOf('INJECTED FACTS')
  const prechart = user.indexOf('PRE-CHART CONTEXT')
  const template = user.indexOf('DOCTOR TEMPLATE')
  const txt      = user.indexOf('TRANSCRIPT')
  assert.ok(iFacts < prechart && prechart < template && template < txt,
    `unexpected ordering: facts=${iFacts} prechart=${prechart} template=${template} txt=${txt}`)
})

test('buildSingleCallNoteGen keeps system = skill body sans frontmatter', () => {
  const { system } = buildSingleCallNoteGen({ ...BASE, prechartText: 'x' })
  assert.strictEqual(system.trim(), 'SYSTEM BODY')
})
