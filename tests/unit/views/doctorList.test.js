'use strict'

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { setupDom, teardownDom, flush } = require('./helpers')

let renderDoctorList

before(async () => {
  setupDom({})
  ;({ renderDoctorList } = await import('../../../renderer/views/doctorList.js'))
})
after(teardownDom)

const DOCTORS = [
  { id: 1, name: 'Dr. Smith', templatePath: 'C:\\tmpl\\smith.md', specialty: 'orthopedics' },
  { id: 2, name: 'Dr. Jones', templatePath: null, specialty: null },
]

test('renders one row per doctor with name + template basename', async () => {
  const { document } = setupDom({ getDoctors: () => DOCTORS.map(d => ({ ...d })) })
  const container = document.getElementById('template-doctor-list')
  await renderDoctorList(container)
  await flush()
  const rows = container.querySelectorAll('.doctor-row')
  assert.strictEqual(rows.length, 2)
  const names = [...container.querySelectorAll('.doctor-name')].map(n => n.textContent)
  assert.deepStrictEqual(names, ['Dr. Smith', 'Dr. Jones'])
  // Smith has a template (span); Jones has a "Select Template" button.
  assert.strictEqual(container.querySelector('.doctor-template').textContent, 'smith.md')
  assert.strictEqual(container.querySelector('.doctor-select-template').textContent, 'Select Template')
  // Smith shows a specialty chip; Jones does not.
  assert.strictEqual(container.querySelectorAll('.doctor-specialty').length, 1)
  assert.strictEqual(container.querySelector('.doctor-specialty').textContent, 'Orthopedics')
})

test('empty list shows the empty placeholder', async () => {
  const { document } = setupDom({ getDoctors: () => [] })
  const container = document.getElementById('template-doctor-list')
  await renderDoctorList(container)
  await flush()
  assert.strictEqual(container.querySelector('.doctor-empty').textContent, 'No doctors added yet')
})

test('clicking ✎ swaps into edit mode (name input + specialty select)', async () => {
  const { document } = setupDom({ getDoctors: () => DOCTORS.map(d => ({ ...d })) })
  const container = document.getElementById('template-doctor-list')
  await renderDoctorList(container)
  await flush()
  const firstRow = container.querySelector('.doctor-row')
  firstRow.querySelector('.doctor-edit').click()
  assert.ok(firstRow.classList.contains('doctor-row--editing'))
  const nameInput = firstRow.querySelector('.doctor-edit-name-input')
  assert.ok(nameInput)
  assert.strictEqual(nameInput.value, 'Dr. Smith')
  const sel = firstRow.querySelector('.doctor-edit-specialty')
  assert.strictEqual(sel.value, 'orthopedics')
})

test('edit-mode Save calls ipc.updateDoctor + updateDoctorSpecialty', async () => {
  const calls = []
  const { document } = setupDom({
    getDoctors: () => [{ id: 9, name: 'Dr. Old', templatePath: 'x.md', specialty: null }],
    updateDoctor: (id, name) => { calls.push(['updateDoctor', id, name]); return { ok: true } },
    updateDoctorSpecialty: (id, sp) => { calls.push(['updateDoctorSpecialty', id, sp]); return { ok: true } },
  })
  const container = document.getElementById('template-doctor-list')
  await renderDoctorList(container)
  await flush()
  const row = container.querySelector('.doctor-row')
  row.querySelector('.doctor-edit').click()
  row.querySelector('.doctor-edit-name-input').value = 'Dr. New'
  row.querySelector('.doctor-edit-specialty').value = 'cardiology'
  row.querySelector('.doctor-edit-save').click()
  await flush()
  assert.deepStrictEqual(calls, [
    ['updateDoctor', 9, 'Dr. New'],
    ['updateDoctorSpecialty', 9, 'cardiology'],
  ])
  // Back in view mode after save.
  assert.ok(!row.classList.contains('doctor-row--editing'))
})

test('remove calls ipc.removeDoctor, re-renders, and fires onDoctorRemoved', async () => {
  let doctors = [{ id: 5, name: 'Dr. Gone', templatePath: 'g.md', specialty: null }]
  let removedCb = 0
  const { document } = setupDom({
    getDoctors: () => doctors.map(d => ({ ...d })),
    removeDoctor: (id) => { doctors = doctors.filter(d => d.id !== id) },
  })
  const container = document.getElementById('template-doctor-list')
  await renderDoctorList(container, { onDoctorRemoved: () => { removedCb++ } })
  await flush()
  container.querySelector('.doctor-remove').click()
  await flush()
  assert.strictEqual(removedCb, 1)
  assert.strictEqual(container.querySelector('.doctor-empty').textContent, 'No doctors added yet')
})
