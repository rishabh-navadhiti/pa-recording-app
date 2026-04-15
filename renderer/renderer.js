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
const uploadForm         = document.getElementById('upload-form')
const uploadPatientInput = document.getElementById('upload-patient-input')
const btnUploadSaveName  = document.getElementById('btn-upload-save-name')
const btnUploadSkipName  = document.getElementById('btn-upload-skip-name')
const setupWarning       = document.getElementById('setup-warning')
const configWarnings    = document.getElementById('config-warnings')
const warnElevenLabs    = document.getElementById('warn-elevenlabs')
const elevenLabsInput   = document.getElementById('elevenlabs-input')
const btnSaveElevenLabs = document.getElementById('btn-save-elevenlabs')
const warnDoctor        = document.getElementById('warn-doctor')
const doctorInput       = document.getElementById('doctor-input')
const btnSaveDoctor     = document.getElementById('btn-save-doctor')

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
  uploadForm.classList.add('hidden')

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
      const btnUpload = makeButton('Upload Audio File', async () => {
        const filePath = await api.browseAudioFile()
        if (!filePath) return  // user cancelled picker
        showUploadForm(filePath)
      }, 'outline')
      const btnStop = makeButton('Stop Session', async () => {
        await api.stopSession()
      }, 'secondary')
      actionButtons.appendChild(btnRec)
      actionButtons.appendChild(btnUpload)
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
// Upload audio form
// ---------------------------------------------------------------------------

function showUploadForm(filePath) {
  // Hide action buttons while naming — prevent double-submits
  actionButtons.innerHTML = ''
  uploadForm.classList.remove('hidden')
  uploadPatientInput.value = ''
  uploadPatientInput.focus()

  let submitted = false

  function submitUpload(name) {
    if (submitted) return
    submitted = true
    uploadForm.classList.add('hidden')
    api.processAudioFile(filePath, name)
  }

  btnUploadSaveName.onclick = () => submitUpload(uploadPatientInput.value || null)
  btnUploadSkipName.onclick = () => submitUpload(null)

  uploadPatientInput.onkeydown = (e) => {
    if (e.key === 'Enter')  btnUploadSaveName.click()
    if (e.key === 'Escape') btnUploadSkipName.click()
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
// Config warnings (ElevenLabs key / doctor name)
// ---------------------------------------------------------------------------

function updateConfigWarningsVisibility() {
  const anyVisible = !warnElevenLabs.classList.contains('hidden') ||
                     !warnDoctor.classList.contains('hidden')
  configWarnings.style.display = anyVisible ? '' : 'none'
}

async function initConfigWarnings() {
  const cfg = await api.getConfigStatus()

  if (cfg.elevenLabsKeyMissing) {
    warnElevenLabs.classList.remove('hidden')
  }

  if (!cfg.doctorName) {
    warnDoctor.classList.remove('hidden')
  } else {
    doctorInput.value = cfg.doctorName
  }

  updateConfigWarningsVisibility()
}

btnSaveElevenLabs.addEventListener('click', async () => {
  const key = elevenLabsInput.value.trim()
  if (!key) return
  btnSaveElevenLabs.disabled = true
  const res = await api.saveElevenLabsKey(key)
  if (res.ok) {
    warnElevenLabs.classList.add('hidden')
    updateConfigWarningsVisibility()
  }
  btnSaveElevenLabs.disabled = false
})

elevenLabsInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnSaveElevenLabs.click()
})

btnSaveDoctor.addEventListener('click', async () => {
  const name = doctorInput.value.trim()
  if (!name) return
  btnSaveDoctor.disabled = true
  const res = await api.saveDoctorName(name)
  if (res.ok) {
    warnDoctor.classList.add('hidden')
    updateConfigWarningsVisibility()
  }
  btnSaveDoctor.disabled = false
})

doctorInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnSaveDoctor.click()
})

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  const state = await api.getState()
  render(state)
  await initConfigWarnings()

  api.onStateChange(render)
  api.onShowPatientForm(showPatientForm)
  api.onSetupWarning(showSetupWarning)
}

init().catch(console.error)
