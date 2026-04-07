'use strict'

// ---------------------------------------------------------------------------
// State constants (must match main.js)
// ---------------------------------------------------------------------------

const STATE = {
  IDLE:           'IDLE',
  SESSION_ACTIVE: 'SESSION_ACTIVE',
  RECORDING:      'RECORDING',
  PROCESSING:     'PROCESSING'
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const indicator     = document.getElementById('indicator')
const statusLabel   = document.getElementById('status-label')
const timerEl       = document.getElementById('timer')
const actionButtons = document.getElementById('action-buttons')
const patientForm   = document.getElementById('patient-form')
const patientInput  = document.getElementById('patient-input')
const btnSaveName   = document.getElementById('btn-save-name')
const btnSkipName   = document.getElementById('btn-skip-name')
const formCountdown = document.getElementById('form-countdown')
const setupWarning  = document.getElementById('setup-warning')

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------

let timerInterval = null
let timerSeconds = 0

function startTimer() {
  timerSeconds = 0
  timerEl.textContent = '00:00'
  timerEl.classList.remove('hidden')
  if (timerInterval) clearInterval(timerInterval)
  timerInterval = setInterval(() => {
    timerSeconds++
    const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0')
    const s = String(timerSeconds % 60).padStart(2, '0')
    timerEl.textContent = `${m}:${s}`
  }, 1000)
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
  timerEl.classList.add('hidden')
}

// ---------------------------------------------------------------------------
// Render UI for a given state
// ---------------------------------------------------------------------------

function render(state) {
  // Reset shared elements
  actionButtons.innerHTML = ''
  indicator.className = ''
  patientForm.classList.add('hidden')

  switch (state) {
    case STATE.IDLE: {
      indicator.className = ''
      statusLabel.textContent = 'No active session'
      stopTimer()

      const btnStart = makeButton('Start Session', async () => {
        await api.startSession()
      })
      actionButtons.appendChild(btnStart)
      break
    }

    case STATE.SESSION_ACTIVE: {
      indicator.className = 'active'
      statusLabel.textContent = 'Session active'
      stopTimer()

      const btnRec = makeButton('Start Recording', async () => {
        await api.startRecording()
      })
      const btnStop = makeButton('Stop Session', async () => {
        await api.stopSession()
      }, 'secondary')
      actionButtons.appendChild(btnRec)
      actionButtons.appendChild(btnStop)
      break
    }

    case STATE.RECORDING: {
      indicator.className = 'pulsing'
      statusLabel.textContent = 'Recording...'
      startTimer()

      const btnSave = makeButton('Save Case', async () => {
        await api.stopRecording()
      }, 'danger')
      actionButtons.appendChild(btnSave)
      break
    }

    case STATE.PROCESSING: {
      indicator.className = 'active'
      statusLabel.textContent = 'Processing...'
      stopTimer()

      const btnDisabled = makeButton('Please wait...', null)
      btnDisabled.disabled = true
      actionButtons.appendChild(btnDisabled)
      break
    }
  }
}

function makeButton(label, onClick, variant) {
  const btn = document.createElement('button')
  btn.textContent = label
  if (variant) btn.classList.add(variant)
  if (onClick) {
    btn.addEventListener('click', () => {
      btn.disabled = true
      onClick().catch(console.error).finally(() => { btn.disabled = false })
    })
  }
  return btn
}

// ---------------------------------------------------------------------------
// Patient name form
// ---------------------------------------------------------------------------

const AUTOSAVE_SECS = 30

function showPatientForm() {
  patientForm.classList.remove('hidden')
  patientInput.value = ''
  patientInput.focus()

  let secondsLeft = AUTOSAVE_SECS
  let submitted = false
  formCountdown.textContent = `Auto-saving in ${secondsLeft}s...`

  const countdownInterval = setInterval(() => {
    secondsLeft--
    formCountdown.textContent = `Auto-saving in ${secondsLeft}s...`
    if (secondsLeft <= 0) {
      clearInterval(countdownInterval)
      if (!submitted) {
        submitted = true
        submitName(null)
      }
    }
  }, 1000)

  function submitName(name) {
    clearInterval(countdownInterval)
    patientForm.classList.add('hidden')
    api.submitPatientName(name)
  }

  btnSaveName.onclick = () => {
    if (submitted) return
    submitted = true
    submitName(patientInput.value || null)
  }

  btnSkipName.onclick = () => {
    if (submitted) return
    submitted = true
    submitName(null)
  }

  patientInput.onkeydown = (e) => {
    if (e.key === 'Enter') btnSaveName.click()
    if (e.key === 'Escape') btnSkipName.click()
  }
}

// ---------------------------------------------------------------------------
// Setup warning
// ---------------------------------------------------------------------------

function showSetupWarning(msg) {
  setupWarning.textContent = msg
  setupWarning.classList.remove('hidden')
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  const state = await api.getState()
  render(state)

  api.onStateChange(render)
  api.onShowPatientForm(showPatientForm)
  api.onSetupWarning(showSetupWarning)
}

init().catch(console.error)
