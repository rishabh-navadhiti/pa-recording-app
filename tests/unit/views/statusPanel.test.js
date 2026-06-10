'use strict'

const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const { JSDOM } = require('jsdom')

before(() => {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="recording-list"></div></body>')
  global.window = dom.window      // no .api → statusPanel bootstrap stays inert
  global.document = dom.window.document
})

async function load() {
  return import('../../../renderer/statusPanel.js')
}

test('renderRecordings shows empty state', async () => {
  const { renderRecordings } = await load()
  renderRecordings([])
  assert.match(document.getElementById('recording-list').textContent, /No recordings this session/)
})

test('renderRecordings renders a single-patient completed case with Open button', async () => {
  const { renderRecordings } = await load()
  renderRecordings([{
    caseTag: 'jane_doe_2026-06-05', displayName: 'Jane Doe',
    status: 'completed', statusLabel: 'Completed', soapDocxPath: '/notes/jane.docx',
  }])
  const list = document.getElementById('recording-list')
  assert.match(list.textContent, /Jane Doe/)
  assert.match(list.textContent, /Completed/)
  const openBtn = list.querySelector('.open-btn')
  assert.ok(openBtn, 'Open button present for completed case')
})

test('renderRecordings renders multi-patient hierarchy with count badge', async () => {
  const { renderRecordings } = await load()
  renderRecordings([{
    caseTag: 'rec_2026-06-05', displayName: 'Recording',
    status: 'completed', statusLabel: 'Completed',
    patients: [
      { name: 'A', status: 'completed', statusLabel: 'Completed', soapDocxPath: '/a.docx' },
      { name: 'B', status: 'converting', statusLabel: 'Converting...' },
    ],
  }])
  const list = document.getElementById('recording-list')
  assert.strictEqual(list.querySelector('.patient-count').textContent, '2')
  assert.strictEqual(list.querySelectorAll('.patient-row').length, 2)
})

test('renderRecordings shows CDI badge + button from flat cdi* fields', async () => {
  const { renderRecordings } = await load()
  renderRecordings([{
    caseTag: 'c', displayName: 'X', status: 'completed', statusLabel: 'Completed',
    soapDocxPath: '/x.docx', cdiDocxPath: '/x_cdi.docx', cdiFlagCount: 3,
    cdiQualityScore: 80, cdiClinicianApprovalRequired: true,
  }])
  const list = document.getElementById('recording-list')
  assert.ok(list.querySelector('.cdi-approval-badge'), 'approval badge shown')
  const cdiBtn = list.querySelector('.open-btn--cdi')
  assert.ok(cdiBtn, 'CDI button shown')
  assert.match(cdiBtn.title, /3 flags · quality 80\/100/)
})
