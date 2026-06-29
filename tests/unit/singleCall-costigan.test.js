'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { buildSingleCallCostiganCdi } = require('../../src/llm/skill-io/singleCall')

const skillText = '---\nname: cdi-costigan-api\n---\nANALYTICAL FRAMEWORK BODY\n'
const packsText = '<!-- pack: esi -->\nESI PACK CONTENT'

test('system prompt = stripped skill + packs section', () => {
  const { system } = buildSingleCallCostiganCdi({
    skillText, packsText, noteText: 'NOTE', chartText: 'CHART',
    patientName: 'Jane Doe', dateOfService: '06/26/2026', doctorName: 'William Costigan',
  })
  assert.ok(system.startsWith('ANALYTICAL FRAMEWORK BODY'))      // frontmatter stripped
  assert.ok(system.includes('# PROCEDURE RUBRIC PACKS'))
  assert.ok(system.includes('ESI PACK CONTENT'))
})

test('user message carries facts, note, and chart', () => {
  const { user } = buildSingleCallCostiganCdi({
    skillText, packsText, noteText: 'THE NOTE BODY', chartText: 'THE CHART BODY',
    patientName: 'Jane Doe', dateOfService: '06/26/2026', doctorName: 'William Costigan',
  })
  assert.ok(user.includes('Patient: Jane Doe'))
  assert.ok(user.includes('Date of Service: 06/26/2026'))
  assert.ok(user.includes('THE NOTE BODY'))
  assert.ok(user.includes('THE CHART BODY'))
  assert.ok(/Output ONLY the checklist JSON/i.test(user))
})

test('absent chart yields an explicit sentinel, not empty', () => {
  const { user } = buildSingleCallCostiganCdi({
    skillText, packsText, noteText: 'NOTE', chartText: '',
    patientName: 'Jane Doe', dateOfService: '', doctorName: 'William Costigan',
  })
  assert.ok(/not provided/i.test(user))
  assert.ok(/SOAP note alone/i.test(user))
})
