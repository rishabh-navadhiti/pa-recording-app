// Record tab — the 5-case state switch (renderer.js lines 212-326) plus the
// sub-views it owns: patient form, upload form, doctor picker, and the
// setup/service/config warnings. recordView is the orchestrator for everything
// inside #tab-record.
//
// update(state) IS the original render(state): it resets the shared elements
// and rebuilds the action buttons + status label + indicator + timer for the
// given STATE. prevState tracking is preserved so RECORDING resumes the timer
// when coming from PAUSED (vs starting fresh).
//
// All show/hide goes through setVisible (the `.hidden` class) — replacing the
// original's mix of `.classList.add('hidden')` and inline `.style.display`.

import { ipc } from '../ipc/client.js'
import { STATE } from '../constants.js'
import { setVisible } from '../components/visible.js'
import { makeButton } from '../components/button.js'
import { createTimer } from '../components/timer.js'
import { confirmAction } from '../components/confirm.js'

import { createPatientForm } from './patientForm.js'
import { createUploadForm } from './uploadForm.js'
import { createDoctorPicker } from './doctorPicker.js'
import { createWarnings } from './warnings.js'
import { createPrechartCapture } from './prechartCapture.js'

export function createRecordView() {
  let indicator, statusLabel, timerEl, actionButtons, patientForm, uploadFormEl,
      doctorPickerEl, viewStatusBar, prechartCaptureEl
  let timer = null

  // Sub-views.
  const patientFormView = createPatientForm()
  const uploadFormView  = createUploadForm()
  const doctorPickerView = createDoctorPicker()
  const warningsView    = createWarnings()
  const prechartCaptureView = createPrechartCapture()

  let currentRenderedState = STATE.IDLE

  // The render(state) routine — verbatim logic from the original.
  function render(state) {
    const prevState = currentRenderedState
    currentRenderedState = state

    // Reset shared elements
    actionButtons.innerHTML = ''
    // The doctor picker / upload form hide #action-buttons via setVisible while
    // open (the original used inline display). render() always rebuilds the
    // buttons, so make sure the container is visible again — otherwise a state
    // push that arrives while the picker is open would leave the new buttons
    // hidden. (No-op in the normal flow where the picker is already resolved.)
    setVisible(actionButtons, true)
    indicator.className = ''
    setVisible(patientForm, false)
    setVisible(uploadFormEl, false)
    setVisible(doctorPickerEl, false)
    setVisible(viewStatusBar, false)
    // Close the in-recording Pre-chart screen on any state push (e.g. recording
    // ended). The latest context is already saved to main on every change.
    if (prechartCaptureEl) setVisible(prechartCaptureEl, false)

    switch (state) {
      case STATE.IDLE: {
        indicator.className = ''
        statusLabel.textContent = 'No active session'
        timer.stop()

        const btnStart = makeButton('Start Session', async () => {
          const result = await ipc.startSession()
          if (result && !result.ok && result.error === 'no-doctors') {
            if (typeof render.onNoDoctors === 'function') render.onNoDoctors()
          }
        })
        actionButtons.appendChild(btnStart)
        break
      }

      case STATE.SESSION_ACTIVE: {
        indicator.className = 'active'
        statusLabel.textContent = 'Session active'
        timer.stop()
        setVisible(viewStatusBar, true)

        const btnRec = makeButton('Start Recording', async () => {
          await ipc.startRecording()
        })
        const btnUpload = makeButton('Upload Audio File', async () => {
          const filePath = await ipc.browseAudioFile()
          if (!filePath) return  // user cancelled picker
          uploadFormView.show(filePath, {
            clearActionButtons: () => { actionButtons.innerHTML = '' },
            onClose: () => render(STATE.SESSION_ACTIVE),
          })
        }, 'outline')
        const btnStop = makeButton('Stop Session', async () => {
          await ipc.stopSession()
        }, 'secondary')
        actionButtons.appendChild(btnRec)
        actionButtons.appendChild(btnUpload)
        actionButtons.appendChild(btnStop)
        break
      }

      case STATE.RECORDING: {
        indicator.className = 'pulsing'
        statusLabel.textContent = 'Recording...'
        setVisible(viewStatusBar, true)
        if (prevState === STATE.PAUSED) {
          timer.resume()
        } else {
          timer.start()
        }

        const btnPause = makeButton('Pause', async () => {
          await ipc.pauseRecording()
        }, 'warning')
        const btnSave = makeButton('Save Case', async () => {
          await ipc.stopRecording()
        }, 'danger')
        const btnDiscard = makeButton('Discard', async () => {
          if (!confirmAction('Discard this recording? This cannot be undone.')) return
          await ipc.discardRecording()
          timer.stop()
        }, 'secondary')
        const btnPrechart = makeButton('Pre-chart', () => prechartCaptureView.open(), 'outline')
        actionButtons.appendChild(btnPause)
        actionButtons.appendChild(btnSave)
        actionButtons.appendChild(btnDiscard)
        actionButtons.appendChild(btnPrechart)
        break
      }

      case STATE.PAUSED: {
        indicator.className = 'paused'
        statusLabel.textContent = 'Paused'
        setVisible(viewStatusBar, true)
        timer.pause()

        const btnResume = makeButton('Resume', async () => {
          await ipc.resumeRecording()
        })
        const btnSave = makeButton('Save Case', async () => {
          await ipc.stopRecording()
        }, 'danger')
        const btnDiscard = makeButton('Discard', async () => {
          if (!confirmAction('Discard this recording? This cannot be undone.')) return
          await ipc.discardRecording()
          timer.stop()
        }, 'secondary')
        const btnPrechart = makeButton('Pre-chart', () => prechartCaptureView.open(), 'outline')
        actionButtons.appendChild(btnResume)
        actionButtons.appendChild(btnSave)
        actionButtons.appendChild(btnDiscard)
        actionButtons.appendChild(btnPrechart)
        break
      }

      case STATE.PROCESSING: {
        indicator.className = 'active'
        statusLabel.textContent = 'Processing...'
        setVisible(viewStatusBar, true)
        timer.stop()

        const btnDisabled = makeButton('Please wait...', null)
        btnDisabled.disabled = true
        actionButtons.appendChild(btnDisabled)
        break
      }
    }
  }

  return {
    mount(root, ctx = {}) {
      indicator      = root.querySelector('#indicator')
      statusLabel    = root.querySelector('#status-label')
      timerEl        = root.querySelector('#timer')
      actionButtons  = root.querySelector('#action-buttons')
      patientForm    = root.querySelector('#patient-form')
      uploadFormEl   = root.querySelector('#upload-form')
      doctorPickerEl = root.querySelector('#doctor-picker')
      viewStatusBar  = root.querySelector('#view-status-bar')
      prechartCaptureEl = root.querySelector('#prechart-capture-view')

      timer = createTimer(timerEl)

      // The router passes a callback to open settings when Start Session
      // reports no-doctors (original called showSettings()).
      render.onNoDoctors = ctx.onNoDoctors || null

      // Sub-views mount against the same root (their elements live inside it).
      // Opening the Pre-chart capture screen — shared by the recording action
      // row and both patient-name forms. It's a pure overlay (restores the prior
      // controls on close), so the recording timer keeps running throughout.
      const openPrechart = () => prechartCaptureView.open()
      patientFormView.mount(root, { ...ctx, onPrechart: openPrechart })
      uploadFormView.mount(root, { ...ctx, onPrechart: openPrechart })
      doctorPickerView.mount(root, ctx)
      warningsView.mount(root, ctx)
      prechartCaptureView.mount(root)

      render(currentRenderedState)
    },

    update(state) {
      render(state)
    },

    unmount() {
      if (timer) timer.stop()
      patientFormView.unmount()
      uploadFormView.unmount()
      doctorPickerView.unmount()
      warningsView.unmount()
      prechartCaptureView.unmount()
    },

    // Extra surface the router calls on push events:
    showPatientForm: (...a) => patientFormView.show(...a),
    showDoctorPicker: (...a) => doctorPickerView.show(...a),
    showSetupWarning: (...a) => warningsView.showSetupWarning(...a),
    showServiceWarning: (...a) => warningsView.showServiceWarning(...a),
    initConfigWarnings: (...a) => warningsView.initConfigWarnings(...a),
    clearDoctorWarning: (...a) => warningsView.clearDoctorWarning(...a),
    get state() { return currentRenderedState },
  }
}
