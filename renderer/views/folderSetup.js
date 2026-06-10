// First-launch folder setup — extracted verbatim from renderer.js lines
// 1048-1082. Shown when no notes dir is configured; hides all main content
// (header, tabs, tab bar) until the user picks a folder.
//
// The original toggled the main-content elements with inline `.style.display`.
// We now use setVisible (the `.hidden` class) — same observable effect
// (display:none vs visible) since these elements carry no other hidden state.
//
// After a successful selection the original re-ran initConfigWarnings +
// getState→render + registerAppListeners; that bootstrap belongs to the router,
// so it's delivered via the onSelected(path) callback.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'

// IDs of the main-content blocks hidden during folder setup. Resolved from the
// document root at mount/show time (some live outside #tab-record).
const MAIN_CONTENT_IDS = ['header-row', 'tab-record', 'tab-templates', 'tab-prechart', 'tab-bar']

export function createFolderSetup() {
  let folderSetup, btnBrowseNotesDirNew, btnBrowseNotesDirExisting, rootEl
  let onSelectedCb = null

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function mainContentEls() {
    return MAIN_CONTENT_IDS.map(id => rootEl.querySelector('#' + id)).filter(Boolean)
  }

  function show() {
    setVisible(folderSetup, true)
    mainContentEls().forEach(el => setVisible(el, false))
  }

  function hide() {
    setVisible(folderSetup, false)
    mainContentEls().forEach(el => setVisible(el, true))
  }

  async function handleNotesDirSelection(mode) {
    const res = await ipc.changeNotesDir(mode)
    if (res.ok) {
      hide()
      if (onSelectedCb) await onSelectedCb(res.path)
    }
  }

  return {
    mount(root, ctx = {}) {
      rootEl = root
      onSelectedCb = ctx.onNotesDirSelected || null
      folderSetup               = root.querySelector('#folder-setup')
      btnBrowseNotesDirNew      = root.querySelector('#btn-browse-notes-dir-new')
      btnBrowseNotesDirExisting = root.querySelector('#btn-browse-notes-dir-existing')

      on(btnBrowseNotesDirNew, 'click', () => handleNotesDirSelection('new'))
      on(btnBrowseNotesDirExisting, 'click', () => handleNotesDirSelection('existing'))
    },

    update() { /* state-independent */ },

    unmount() {
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },

    show,
    hide,
  }
}
