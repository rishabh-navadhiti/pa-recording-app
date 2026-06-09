'use strict'

const { test, before } = require('node:test')
const assert = require('node:assert/strict')
const { JSDOM } = require('jsdom')

// Set up a jsdom document so the DOM-building components work under node:test.
before(() => {
  const dom = new JSDOM('<!DOCTYPE html><body></body>')
  global.window = dom.window
  global.document = dom.window.document
})

// ---- timer.formatTime (pure) ----

test('formatTime renders MM:SS under an hour', async () => {
  const { formatTime } = await import('../../renderer/components/timer.js')
  assert.strictEqual(formatTime(0), '00:00')
  assert.strictEqual(formatTime(5), '00:05')
  assert.strictEqual(formatTime(65), '01:05')
  assert.strictEqual(formatTime(599), '09:59')
})

test('formatTime switches to HH:MM:SS at an hour', async () => {
  const { formatTime } = await import('../../renderer/components/timer.js')
  assert.strictEqual(formatTime(3600), '01:00:00')
  assert.strictEqual(formatTime(3661), '01:01:01')
})

// ---- visible ----

test('setVisible toggles the .hidden class', async () => {
  const { setVisible } = await import('../../renderer/components/visible.js')
  const el = document.createElement('div')
  setVisible(el, false)
  assert.ok(el.classList.contains('hidden'))
  setVisible(el, true)
  assert.ok(!el.classList.contains('hidden'))
})

// ---- fileListField ----

test('renderFileList shows empty text when no files', async () => {
  const { renderFileList } = await import('../../renderer/components/fileListField.js')
  const container = document.createElement('div')
  renderFileList({ container, files: [], emptyText: 'Nothing here' })
  assert.strictEqual(container.textContent, 'Nothing here')
  assert.ok(container.classList.contains('create-template-files-empty'))
})

test('renderFileList renders one row per file with basename', async () => {
  const { renderFileList } = await import('../../renderer/components/fileListField.js')
  const container = document.createElement('div')
  renderFileList({ container, files: ['C:\\notes\\a.md', '/tmp/b.pdf'] })
  const rows = container.querySelectorAll('.create-template-file-row')
  assert.strictEqual(rows.length, 2)
  const names = [...container.querySelectorAll('.create-template-file-name')].map(n => n.textContent)
  assert.deepStrictEqual(names, ['a.md', 'b.pdf'])
})

test('renderFileList remove button splices the array and fires onChange', async () => {
  const { renderFileList } = await import('../../renderer/components/fileListField.js')
  const container = document.createElement('div')
  const files = ['a.md', 'b.md', 'c.md']
  let changed = 0
  renderFileList({ container, files, onChange: () => { changed++ } })
  // Click the remove button on the middle row.
  const removeBtns = container.querySelectorAll('.create-template-file-remove')
  removeBtns[1].click()
  assert.deepStrictEqual(files, ['a.md', 'c.md'])
  assert.strictEqual(changed, 1)
  // Re-rendered: 2 rows remain.
  assert.strictEqual(container.querySelectorAll('.create-template-file-row').length, 2)
})

// ---- button ----

test('makeButton creates a button with label + variant class', async () => {
  const { makeButton } = await import('../../renderer/components/button.js')
  const btn = makeButton('Save', null, 'danger')
  assert.strictEqual(btn.textContent, 'Save')
  assert.ok(btn.classList.contains('danger'))
})

test('makeButton disables during async onClick then re-enables', async () => {
  const { makeButton } = await import('../../renderer/components/button.js')
  let resolveFn
  const btn = makeButton('Go', () => new Promise(r => { resolveFn = r }))
  btn.click()
  assert.strictEqual(btn.disabled, true, 'disabled while running')
  resolveFn()
  await new Promise(r => setTimeout(r, 0))
  assert.strictEqual(btn.disabled, false, 're-enabled after')
})
