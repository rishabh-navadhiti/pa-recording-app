// Patient-name form with the 30s auto-save countdown — extracted verbatim from
// renderer.js lines 345-391.
//
// Shown via the router when main pushes `onShowPatientForm`. Submitting (Save /
// Skip / Enter / Escape / the 30s timeout) resolves the awaited patient-name
// promise in main via ipc.submitPatientName(name|null).
//
// The original wired Save/Skip via `.onclick` reassignment inside show(); here
// we attach once in mount() and keep the per-show countdown/submitted state in
// a closure that the handlers read. This removes the closure-leak smell while
// preserving identical behaviour and the 30s duration.

import { ipc } from '../ipc/client.js'
import { setVisible } from '../components/visible.js'

const AUTOSAVE_SECS = 30

export function createPatientForm() {
  let patientForm, patientInput, btnSaveName, btnSkipName, btnPrechart, formCountdown, viewStatusBar, multiPatientCheckbox
  let onPrechartCb = null

  // Per-show state.
  let countdownInterval = null
  let submitted = false

  const listeners = []
  function on(el, type, fn) {
    if (!el) return
    el.addEventListener(type, fn)
    listeners.push([el, type, fn])
  }

  function submitName(name) {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
    const multi = multiPatientCheckbox?.checked || false
    setVisible(patientForm, false)
    ipc.submitPatientName(name, multi)
  }

  function show() {
    setVisible(patientForm, true)
    setVisible(viewStatusBar, false)
    patientInput.value = ''
    if (multiPatientCheckbox) multiPatientCheckbox.checked = false
    patientInput.focus()

    let secondsLeft = AUTOSAVE_SECS
    submitted = false
    formCountdown.textContent = `Auto-saving in ${secondsLeft}s...`

    if (countdownInterval) clearInterval(countdownInterval)
    countdownInterval = setInterval(() => {
      secondsLeft--
      formCountdown.textContent = `Auto-saving in ${secondsLeft}s...`
      if (secondsLeft <= 0) {
        clearInterval(countdownInterval)
        countdownInterval = null
        if (!submitted) {
          submitted = true
          submitName(null)
        }
      }
    }, 1000)
  }

  return {
    mount(root, ctx = {}) {
      onPrechartCb         = ctx.onPrechart || null
      patientForm          = root.querySelector('#patient-form')
      patientInput         = root.querySelector('#patient-input')
      btnSaveName          = root.querySelector('#btn-save-name')
      btnSkipName          = root.querySelector('#btn-skip-name')
      btnPrechart          = root.querySelector('#btn-patient-prechart')
      formCountdown        = root.querySelector('#form-countdown')
      viewStatusBar        = root.querySelector('#view-status-bar')
      multiPatientCheckbox = root.querySelector('#patient-multi-patient')

      on(btnSaveName, 'click', () => {
        if (submitted) return
        submitted = true
        submitName(patientInput.value || null)
      })

      // Open the Pre-chart capture screen. Pause the auto-save countdown so the
      // case isn't auto-submitted while the scribe is adding context; the form
      // stays open underneath and the user submits manually on return.
      on(btnPrechart, 'click', () => {
        if (submitted) return
        if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
        if (formCountdown) formCountdown.textContent = ''
        if (onPrechartCb) onPrechartCb()
      })

      on(btnSkipName, 'click', () => {
        if (submitted) return
        submitted = true
        submitName(null)
      })

      on(patientInput, 'keydown', (e) => {
        if (e.key === 'Enter') btnSaveName.click()
        if (e.key === 'Escape') btnSkipName.click()
      })
    },

    update() { /* state-independent */ },

    unmount() {
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null }
      listeners.forEach(([el, type, fn]) => el.removeEventListener(type, fn))
      listeners.length = 0
    },

    show,
  }
}
