'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const { buildPrompt } = require('../../src/llm/skill-io/prompts')

// ---- generate-note ---------------------------------------------------------

test('generate-note with template', () => {
  const p = buildPrompt('generate-note', {
    templateRel: 'Templates/sabbag.md',
    transcriptRel: 'Cases/2026-06-04/jane_doe_2026-06-04/transcript.md',
  })
  assert.match(p, /generate a note using template "Templates\/sabbag\.md"/)
  assert.match(p, /and transcript "Cases\//)
})

test('generate-note without template', () => {
  const p = buildPrompt('generate-note', { transcriptRel: 'Cases/x/transcript.md' })
  assert.ok(!p.includes('template'), 'should not mention template when absent')
  assert.match(p, /generate a note using transcript/)
})

// ---- add-icd-codes ---------------------------------------------------------

test('add-icd-codes builds correct format', () => {
  const p = buildPrompt('add-icd-codes', { soapRel: 'Cases/2026-06-04/jane/jane_soap_note.md' })
  assert.strictEqual(p, 'add ICD codes. Soap note: "Cases/2026-06-04/jane/jane_soap_note.md".')
})

// ---- cdi-review ------------------------------------------------------------

test('cdi-review includes all required fields', () => {
  const p = buildPrompt('cdi-review', {
    caseDir: '/notes/Cases/2026-06-04/jane',
    specialty: 'orthopedics',
    mode: 'balanced',
    doctor: 'Dr. Sabbag',
    standardsDir: '/notes/.claude/standards',
  })
  assert.match(p, /review cdi/)
  assert.match(p, /Specialty: orthopedics/)
  assert.match(p, /Mode: balanced/)
  assert.match(p, /Doctor: Dr\. Sabbag/)
  assert.match(p, /Standards: \/notes\//)
})

// ---- create-doctor-profile -------------------------------------------------

test('create-doctor-profile builds correct format', () => {
  const p = buildPrompt('create-doctor-profile', {
    doctorName: 'Dr. Jane Sabbag',
    stagingRel: 'Templates/_staging/sabbag',
  })
  assert.match(p, /create a doctor profile for "Dr\. Jane Sabbag"/)
  assert.match(p, /from source folder "Templates\/_staging\/sabbag"/)
})

// ---- update-doctor-profile -------------------------------------------------

test('update-doctor-profile with corrections only', () => {
  const p = buildPrompt('update-doctor-profile', {
    doctorName: 'Sabbag',
    templatePath: '/notes/Templates/sabbag.md',
    corrections: 'Add more detail to assessment',
  })
  assert.match(p, /Doctor: Sabbag/)
  assert.match(p, /Corrections: Add more detail/)
  assert.ok(!p.includes('CorrectionsFile'))
  assert.ok(!p.includes('Samples'))
})

test('update-doctor-profile with corrections file + samples', () => {
  const p = buildPrompt('update-doctor-profile', {
    doctorName: 'Sabbag',
    templatePath: '/notes/Templates/sabbag.md',
    corrections: 'See file',
    correctionsFile: '/tmp/corrections.txt',
    sampleFiles: ['/notes/sample1.md', '/notes/sample2.md'],
  })
  assert.match(p, /CorrectionsFile: \/tmp\/corrections\.txt/)
  assert.match(p, /Samples: \/notes\/sample1\.md, \/notes\/sample2\.md/)
})

// ---- edit-note -------------------------------------------------------------

test('edit-note builds correct format', () => {
  const p = buildPrompt('edit-note', {
    caseDir: '/notes/Cases/2026-06-04/jane',
    templatePath: '/notes/Templates/sabbag.md',
    attachmentPath: '/tmp/prechart.md',
    instructions: 'Update the plan section',
  })
  assert.match(p, /edit note/)
  assert.match(p, /Attachment: \/tmp\/prechart\.md/)
  assert.match(p, /Instructions: Update the plan/)
})

test('edit-note with empty attachment', () => {
  const p = buildPrompt('edit-note', {
    caseDir: '/notes/Cases/x',
    templatePath: '/notes/Templates/t.md',
    attachmentPath: '',
    instructions: 'fix it',
  })
  assert.match(p, /Attachment: \./)
})

// ---- unknown skill ---------------------------------------------------------

test('buildPrompt throws for unknown skillId', () => {
  assert.throws(() => buildPrompt('nonexistent-skill', {}), /Unknown skillId/)
})
