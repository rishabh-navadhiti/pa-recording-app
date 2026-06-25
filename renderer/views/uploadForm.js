// Upload-audio patient-name form — extracted verbatim from renderer.js
// lines 397-424. No countdown (unlike the recording patient form).
//
// Shown after the user picks an audio file in SESSION_ACTIVE. The original
// inlined this inside render()'s SESSION_ACTIVE case, so it needs two callbacks
// from its owner (recordView):
//   - clearActionButtons(): the original did `actionButtons.innerHTML = ''` to
//     prevent double-submits while naming.
//   - onClose(): the original called `render(STATE.SESSION_ACTIVE)` to restore
//     the action buttons when the form is dismissed.
//
// Save/Skip/Enter were wired via `.onclick` in the original; here they're
// attached once in mount() and read the per-show `filePath` + callbacks from a
// closure.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'

export function createUploadForm() {
  let uploadForm, uploadPatientInput, btnUploadSaveName, btnUploadSkipName, btnUploadClose, btnUploadPrechart
  let onPrechartCb = null

  // Per-show state.
  let currentFilePath = null
  let onCloseCb = null
  let submitted = false

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function submitUpload(name) {
    if (submitted) return
    submitted = true
    setVisible(uploadForm, false)
    ipc.processAudioFile(currentFilePath, name)
  }

  // clearActionButtons is invoked by the caller before show(); kept here for
  // API parity with the original which cleared inside showUploadForm.
  function show(filePath, { clearActionButtons, onClose } = {}) {
    currentFilePath = filePath
    onCloseCb = onClose || null
    submitted = false
    // Hide action buttons while naming — prevent double-submits
    if (clearActionButtons) clearActionButtons()
    setVisible(uploadForm, true)
    uploadPatientInput.value = ''
    uploadPatientInput.focus()
  }

  return {
    mount(root, ctx = {}) {
      onPrechartCb       = ctx.onPrechart || null
      uploadForm         = root.querySelector('#upload-form')
      uploadPatientInput = root.querySelector('#upload-patient-input')
      btnUploadSaveName  = root.querySelector('#btn-upload-save-name')
      btnUploadSkipName  = root.querySelector('#btn-upload-skip-name')
      btnUploadClose     = root.querySelector('#btn-upload-close')
      btnUploadPrechart  = root.querySelector('#btn-upload-prechart')

      on(btnUploadSaveName, 'click', () => submitUpload(uploadPatientInput.value || null))
      on(btnUploadSkipName, 'click', () => submitUpload(null))
      on(btnUploadPrechart, 'click', () => { if (!submitted && onPrechartCb) onPrechartCb() })

      on(btnUploadClose, 'click', () => {
        setVisible(uploadForm, false)
        if (onCloseCb) onCloseCb()
      })

      on(uploadPatientInput, 'keydown', (e) => {
        if (e.key === 'Enter') btnUploadSaveName.click()
      })
    },

    update() { /* state-independent */ },

    unmount() {
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },

    show,
  }
}
