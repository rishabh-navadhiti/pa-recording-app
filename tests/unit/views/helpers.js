'use strict'

// Shared jsdom harness for the renderer view tests. Loads the REAL
// renderer/index.html so the views query the same element IDs they will at
// runtime — no hand-maintained HTML fragments to drift.

const fs = require('node:fs')
const path = require('node:path')
const { JSDOM } = require('jsdom')

const INDEX_HTML = path.join(__dirname, '..', '..', '..', 'renderer', 'index.html')

/**
 * Build a jsdom document from the real index.html and install it + a mock
 * window.api on the globals the views read. Returns { dom, document, calls }.
 *
 * @param {object} api  Mock window.api methods. Each call is also recorded in
 *                      `calls` as [name, args].
 */
function setupDom(api = {}) {
  const html = fs.readFileSync(INDEX_HTML, 'utf8')
  const dom = new JSDOM(html, { runScripts: 'outside-only' })

  const calls = []
  // Wrap each provided method so tests can assert it was called, while still
  // returning the test's value.
  const wrapped = {}
  for (const [name, fn] of Object.entries(api)) {
    wrapped[name] = (...args) => {
      calls.push([name, args])
      return typeof fn === 'function' ? fn(...args) : fn
    }
  }

  global.window = dom.window
  global.document = dom.window.document
  global.window.api = wrapped
  // jsdom doesn't implement confirm; default to true so confirmAction proceeds.
  global.window.confirm = () => true
  global.confirm = global.window.confirm

  return { dom, document: dom.window.document, calls, api: wrapped }
}

function teardownDom() {
  delete global.window
  delete global.document
  delete global.confirm
}

// Drain pending microtasks (await ipc) so assertions see post-await DOM.
function flush() {
  return new Promise(r => setTimeout(r, 0))
}

module.exports = { setupDom, teardownDom, flush, INDEX_HTML }
