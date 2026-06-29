'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { buildSingleCallNoteGen, buildSingleCallEngineJson, parseJsonResponse } = require('../../src/llm/skill-io/singleCall')

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

// ---- buildSingleCallEngineJson (em-score / patient-summary) ----------------

test('buildSingleCallEngineJson: system = skill body sans frontmatter', () => {
  const { system } = buildSingleCallEngineJson({
    skillText: '---\nname: em-score-api\n---\nENGINE SYSTEM', instruction: 'Score it.', closer: 'Done.',
  })
  assert.strictEqual(system.trim(), 'ENGINE SYSTEM')
})

test('buildSingleCallEngineJson: facts, blocks, and closer appear in order', () => {
  const { user } = buildSingleCallEngineJson({
    skillText: 'SYS',
    instruction: 'Score the level.',
    injectedFacts: ['Patient: jane', 'Doctor: smith'],
    contextBlocks: [{ title: 'SOAP NOTE', body: 'note body' }, { title: 'MDM PACK', body: 'pack body' }],
    closer: 'Output the JSON now.',
  })
  assert.ok(user.startsWith('Score the level.'))
  assert.ok(user.includes('- Patient: jane') && user.includes('- Doctor: smith'))
  const note = user.indexOf('SOAP NOTE')
  const pack = user.indexOf('MDM PACK')
  const closer = user.indexOf('Output the JSON now.')
  assert.ok(note < pack && pack < closer, `order: note=${note} pack=${pack} closer=${closer}`)
  assert.ok(user.includes('note body') && user.includes('pack body'))
})

test('buildSingleCallEngineJson: skips empty/whitespace context blocks', () => {
  const { user } = buildSingleCallEngineJson({
    skillText: 'SYS', instruction: 'go', closer: 'end',
    contextBlocks: [{ title: 'TRANSCRIPT', body: '   ' }, { title: 'SOAP NOTE', body: 'x' }],
  })
  assert.ok(!user.includes('TRANSCRIPT'), 'empty block omitted')
  assert.ok(user.includes('SOAP NOTE'), 'non-empty block kept')
})

// ---- parseJsonResponse -----------------------------------------------------

test('parseJsonResponse: raw JSON object', () => {
  assert.deepStrictEqual(parseJsonResponse('{"a":1,"b":"x"}'), { a: 1, b: 'x' })
})

test('parseJsonResponse: strips a ```json fence', () => {
  assert.deepStrictEqual(parseJsonResponse('```json\n{"a":1}\n```'), { a: 1 })
})

test('parseJsonResponse: recovers an object wrapped in prose', () => {
  assert.deepStrictEqual(parseJsonResponse('Here you go:\n{"a":1}\nthanks'), { a: 1 })
})

test('parseJsonResponse: returns null on non-JSON', () => {
  assert.strictEqual(parseJsonResponse('not json at all'), null)
  assert.strictEqual(parseJsonResponse(''), null)
})
