// Pre-chart capture — a sub-view of the Record tab. Reachable while RECORDING/
// PAUSED (button in the action row), and from BOTH patient-name forms (the
// post-recording form and the upload form), so the scribe can add context for
// the current recording / upload before naming it. The scribe can type and
// attach .md/.txt/.docx/.pdf documents.
//
// This is a pure show/hide OVERLAY: open() records whichever sibling controls
// are currently visible, hides them, and shows itself; close() hides itself and
// restores exactly that set. It never triggers a record-state re-render — so the
// recording TIMER is never reset and keeps counting while this screen is up
// (the #indicator / #status-label / #timer row lives outside the hidden
// controls, so the recording status also stays visible).
//
// The captured context is the source of truth in the main process
// (recorderController): we save on every change and re-pull on open, so it
// survives window hide/show and a mid-recording state push. At stop-recording /
// process-audio-file it is combined into <caseDir>/prechart.md and fed into note
// generation.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'
import { renderFileList } from '../components/fileListField.js'

export function createPrechartCapture() {
  let view, textEl, filesEl, btnAdd, btnBack, btnDone
  let files = []

  // Sibling controls that open() may hide and close() restores. Whichever are
  // visible at open time are recorded in `_hidden` and re-shown on close.
  let siblings = []
  let _hidden = []
  // Optional callback invoked on close (e.g. resume a paused auto-save countdown).
  let _onClose = null

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function renderFiles() {
    renderFileList({ container: filesEl, files, onChange: save })
  }

  // Push the current context to main (cheap; fire-and-forget).
  function save() {
    ipc.savePrechartContext(textEl ? textEl.value : '', files)
  }

  function close() {
    save()
    if (view) setVisible(view, false)
    _hidden.forEach(el => setVisible(el, true))
    _hidden = []
    const cb = _onClose
    _onClose = null
    if (cb) cb()
  }

  return {
    mount(root) {
      view    = root.querySelector('#prechart-capture-view')
      textEl  = root.querySelector('#prechart-capture-text')
      filesEl = root.querySelector('#prechart-capture-files')
      btnAdd  = root.querySelector('#btn-prechart-capture-add-files')
      btnBack = root.querySelector('#btn-prechart-capture-back')
      btnDone = root.querySelector('#btn-prechart-capture-done')

      // The controls open() hides to make room for the capture screen. Any that
      // are currently visible get restored on close.
      siblings = [
        root.querySelector('#action-buttons'),
        root.querySelector('#view-status-bar'),
        root.querySelector('#patient-form'),
        root.querySelector('#upload-form'),
      ].filter(Boolean)

      on(textEl, 'input', save)
      on(btnBack, 'click', close)
      on(btnDone, 'click', close)

      on(btnAdd, 'click', async () => {
        btnAdd.disabled = true
        try {
          const paths = await ipc.browsePrechartFiles()
          if (Array.isArray(paths) && paths.length > 0) {
            const set = new Set(files)
            paths.forEach(p => set.add(p))
            files = Array.from(set)
            renderFiles()
            save()
          }
        } finally {
          btnAdd.disabled = false
        }
      })
    },

    // Open the capture screen: repopulate from main, hide whatever controls are
    // currently visible (recording buttons OR a name form), show the sub-view.
    // The timer is never touched. `onClose` (optional) runs when the screen is
    // dismissed — used by the name form to resume its auto-save countdown.
    async open({ onClose } = {}) {
      if (!view) return
      _onClose = onClose || null
      try {
        const cur = await ipc.getPrechartContext()
        if (textEl) textEl.value = (cur && cur.text) || ''
        files = (cur && Array.isArray(cur.files)) ? cur.files.slice() : []
      } catch {
        if (textEl) textEl.value = ''
        files = []
      }
      renderFiles()
      _hidden = siblings.filter(el => !el.classList.contains('hidden'))
      _hidden.forEach(el => setVisible(el, false))
      setVisible(view, true)
    },

    close,

    update() { /* state-independent */ },

    unmount() {
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },
  }
}
