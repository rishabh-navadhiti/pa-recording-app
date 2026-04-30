'use strict'

// ---------------------------------------------------------------------------
// State constants (must match main.js)
// ---------------------------------------------------------------------------

const STATE = {
  IDLE:           'IDLE',
  SESSION_ACTIVE: 'SESSION_ACTIVE',
  RECORDING:      'RECORDING',
  PAUSED:         'PAUSED',
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
const btnWindowClose     = document.getElementById('btn-window-close')
const btnSettings        = document.getElementById('btn-settings')
const settingsView       = document.getElementById('settings-view')
const btnSettingsClose   = document.getElementById('btn-settings-close')
const chkAutoRecord          = document.getElementById('chk-auto-record')
const deviceSelect           = document.getElementById('device-select')
const soapModelSelect        = document.getElementById('soap-model-select')
const templateModelSelect    = document.getElementById('template-model-select')
const btnAdvancedToggle      = document.getElementById('btn-advanced-toggle')
const advancedSettingsContent = document.getElementById('advanced-settings-content')
const uploadForm         = document.getElementById('upload-form')
const uploadPatientInput = document.getElementById('upload-patient-input')
const btnUploadSaveName  = document.getElementById('btn-upload-save-name')
const btnUploadSkipName  = document.getElementById('btn-upload-skip-name')
const btnUploadClose     = document.getElementById('btn-upload-close')
const setupWarning            = document.getElementById('setup-warning')
const serviceWarning          = document.getElementById('service-warning')
const serviceWarningTitle     = document.getElementById('service-warning-title')
const serviceWarningMessage   = document.getElementById('service-warning-message')
const btnServiceWarningDismiss = document.getElementById('btn-service-warning-dismiss')
const configWarnings    = document.getElementById('config-warnings')
const warnElevenLabs    = document.getElementById('warn-elevenlabs')
const elevenLabsInput   = document.getElementById('elevenlabs-input')
const btnSaveElevenLabs = document.getElementById('btn-save-elevenlabs')
const warnDoctor        = document.getElementById('warn-doctor')
const doctorInput       = document.getElementById('doctor-input')
const btnSaveDoctor     = document.getElementById('btn-save-doctor')
const doctorPicker      = document.getElementById('doctor-picker')
const doctorPickerList  = document.getElementById('doctor-picker-list')
const btnDoctorPickerCancel = document.getElementById('btn-doctor-picker-cancel')
const doctorListEl      = document.getElementById('doctor-list')
const newDoctorInput    = document.getElementById('new-doctor-input')
const btnAddDoctor      = document.getElementById('btn-add-doctor')
const notesDirPath      = document.getElementById('notes-dir-path')
const btnChangeNotesDir = document.getElementById('btn-change-notes-dir')
const folderSetup       = document.getElementById('folder-setup')
const btnBrowseNotesDir = document.getElementById('btn-browse-notes-dir')

// --- Tabs + Templates tab refs ---
const tabRecord                 = document.getElementById('tab-record')
const tabTemplates              = document.getElementById('tab-templates')
const tabBar                    = document.getElementById('tab-bar')
const tabTitle                  = document.getElementById('tab-title')
const statusRow                 = document.getElementById('status-row')
const btnTabRecord              = document.getElementById('btn-tab-record')
const btnTabTemplates           = document.getElementById('btn-tab-templates')
const templateDoctorListEl      = document.getElementById('template-doctor-list')
const newTemplateDoctorInput    = document.getElementById('new-template-doctor-input')
const btnAddTemplateDoctor      = document.getElementById('btn-add-template-doctor')
const templateJobBanner         = document.getElementById('template-job-banner')
const templateJobBannerText     = document.getElementById('template-job-banner-text')
const btnTemplateJobCancel      = document.getElementById('btn-template-job-cancel')
const templateListView          = document.getElementById('template-list-view')
const btnTemplateCreateAi       = document.getElementById('btn-template-create-ai')
const createTemplateView        = document.getElementById('create-template-view')
const btnCreateTemplateBack     = document.getElementById('btn-create-template-back')
const createTemplateDoctorInput = document.getElementById('create-template-doctor-input')
const createTemplateFilesEl     = document.getElementById('create-template-files')
const btnCreateTemplateAddFiles = document.getElementById('btn-create-template-add-files')
const btnCreateTemplateStart    = document.getElementById('btn-create-template-start')
const createTemplateError       = document.getElementById('create-template-error')
const btnTemplateUpdateAi                  = document.getElementById('btn-template-update-ai')
const updateTemplateView                   = document.getElementById('update-template-view')
const btnUpdateTemplateBack                = document.getElementById('btn-update-template-back')
const updateTemplateDoctorSel              = document.getElementById('update-template-doctor-select')
const updateTemplateCorrections            = document.getElementById('update-template-corrections')
const updateTemplateCorrectionsFileEl      = document.getElementById('update-template-corrections-file')
const btnUpdateTemplateAddCorrectionsFile  = document.getElementById('btn-update-template-add-corrections-file')
const updateTemplateFilesEl                = document.getElementById('update-template-files')
const btnUpdateTemplateAddFiles            = document.getElementById('btn-update-template-add-files')
const btnUpdateTemplateStart               = document.getElementById('btn-update-template-start')
const updateTemplateError                  = document.getElementById('update-template-error')
const btnTemplateViewChanges               = document.getElementById('btn-template-view-changes')
const templateChangesPanel                 = document.getElementById('template-changes-panel')
const btnTemplateChangesClose              = document.getElementById('btn-template-changes-close')
const templateChangesText                  = document.getElementById('template-changes-text')

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

function pauseTimer() {
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
  // keep timer visible and timerSeconds intact
}

function resumeTimer() {
  if (timerInterval) clearInterval(timerInterval)
  timerInterval = setInterval(() => {
    timerSeconds++
    const m = String(Math.floor(timerSeconds / 60)).padStart(2, '0')
    const s = String(timerSeconds % 60).padStart(2, '0')
    timerEl.textContent = `${m}:${s}`
  }, 1000)
}

// ---------------------------------------------------------------------------
// Render UI for a given state
// ---------------------------------------------------------------------------

let currentRenderedState = STATE.IDLE
let settingsOpen = false

function render(state) {
  const prevState = currentRenderedState
  currentRenderedState = state
  if (settingsOpen) return

  // Reset shared elements
  actionButtons.innerHTML = ''
  indicator.className = ''
  patientForm.classList.add('hidden')
  uploadForm.classList.add('hidden')
  doctorPicker.classList.add('hidden')

  switch (state) {
    case STATE.IDLE: {
      indicator.className = ''
      statusLabel.textContent = 'No active session'
      stopTimer()

      const btnStart = makeButton('Start Session', async () => {
        const result = await api.startSession()
        if (result && !result.ok && result.error === 'no-doctors') {
          showSettings()
        }
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
      if (prevState === STATE.PAUSED) {
        resumeTimer()
      } else {
        startTimer()
      }

      const btnPause = makeButton('Pause', async () => {
        await api.pauseRecording()
      }, 'warning')
      const btnSave = makeButton('Save Case', async () => {
        await api.stopRecording()
      }, 'danger')
      const btnDiscard = makeButton('Discard', async () => {
        if (!confirm('Discard this recording? This cannot be undone.')) return
        await api.discardRecording()
        stopTimer()
      }, 'secondary')
      actionButtons.appendChild(btnPause)
      actionButtons.appendChild(btnSave)
      actionButtons.appendChild(btnDiscard)
      break
    }

    case STATE.PAUSED: {
      indicator.className = 'paused'
      statusLabel.textContent = 'Paused'
      pauseTimer()

      const btnResume = makeButton('Resume', async () => {
        await api.resumeRecording()
      })
      const btnSave = makeButton('Save Case', async () => {
        await api.stopRecording()
      }, 'danger')
      const btnDiscard = makeButton('Discard', async () => {
        if (!confirm('Discard this recording? This cannot be undone.')) return
        await api.discardRecording()
        stopTimer()
      }, 'secondary')
      actionButtons.appendChild(btnResume)
      actionButtons.appendChild(btnSave)
      actionButtons.appendChild(btnDiscard)
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

  btnUploadClose.onclick = () => {
    uploadForm.classList.add('hidden')
    render(STATE.SESSION_ACTIVE)
  }

  uploadPatientInput.onkeydown = (e) => {
    if (e.key === 'Enter') btnUploadSaveName.click()
  }
}

// ---------------------------------------------------------------------------
// Setup warning
// ---------------------------------------------------------------------------

function showSetupWarning(msg) {
  setupWarning.textContent = msg
  setupWarning.classList.remove('hidden')
}

function showServiceWarning({ title, message }) {
  serviceWarningTitle.textContent = title
  serviceWarningMessage.textContent = message
  serviceWarning.classList.remove('hidden')
}

btnServiceWarningDismiss.addEventListener('click', () => {
  serviceWarning.classList.add('hidden')
})

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

  if (cfg.elevenLabsKeyInvalid) {
    showServiceWarning({
      title: 'ElevenLabs API key invalid',
      message: 'Your API key was rejected. Update it in Settings to enable transcription.'
    })
  }

  if (cfg.noDoctors) {
    warnDoctor.classList.remove('hidden')
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
  const res = await api.addDoctor(name)
  btnSaveDoctor.disabled = false
  if (res.ok) {
    doctorInput.value = ''
    warnDoctor.classList.add('hidden')
    updateConfigWarningsVisibility()
    if (settingsOpen) await renderDoctorList()
  }
})

doctorInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnSaveDoctor.click()
})

// ---------------------------------------------------------------------------
// Settings view
// ---------------------------------------------------------------------------

function showSettings() {
  settingsOpen = true
  // Hide both tabs + tab bar; settings is a full overlay
  if (tabRecord)    tabRecord.style.display    = 'none'
  if (tabTemplates) tabTemplates.style.display = 'none'
  if (tabBar)       tabBar.style.display       = 'none'
  settingsView.classList.remove('hidden')
  loadSettings()
}

function hideSettings() {
  settingsOpen = false
  settingsView.classList.add('hidden')
  if (tabBar) tabBar.style.display = ''
  // Restore the currently-active tab
  showTab(activeTab)
  render(currentRenderedState)
}

async function loadSettings() {
  const s = await api.getSettings()
  chkAutoRecord.checked = s.autoRecord || false
  await renderDoctorList()
  const dir = await api.getNotesDir()
  notesDirPath.textContent = dir
  notesDirPath.title = dir
}

btnChangeNotesDir.addEventListener('click', async () => {
  const res = await api.changeNotesDir()
  if (res.ok) {
    notesDirPath.textContent = res.path
    notesDirPath.title = res.path
  }
})

async function renderDoctorList(containerEl) {
  const el = containerEl || doctorListEl
  if (!el) return
  const doctors = await api.getDoctors()
  el.innerHTML = ''
  if (doctors.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'doctor-empty'
    empty.textContent = 'No doctors added yet'
    el.appendChild(empty)
    return
  }
  doctors.forEach(doc => {
    const row = document.createElement('div')
    row.className = 'doctor-row'

    function renderViewMode() {
      row.innerHTML = ''
      row.classList.remove('doctor-row--editing')

      const nameSpan = document.createElement('span')
      nameSpan.className = 'doctor-name'
      nameSpan.textContent = doc.name

      let templateEl
      if (doc.templatePath) {
        templateEl = document.createElement('span')
        templateEl.className = 'doctor-template'
        templateEl.textContent = doc.templatePath.split(/[\\/]/).pop()
      } else {
        templateEl = document.createElement('button')
        templateEl.className = 'doctor-select-template'
        templateEl.textContent = 'Select Template'
        templateEl.addEventListener('click', async () => {
          const res = await api.updateDoctorTemplate(doc.id)
          if (res.ok) { doc.templatePath = res.doctor.templatePath; renderViewMode() }
        })
      }

      const editBtn = document.createElement('button')
      editBtn.className = 'doctor-edit'
      editBtn.textContent = '✎'
      editBtn.title = 'Edit doctor'
      editBtn.addEventListener('click', () => renderEditMode())

      const removeBtn = document.createElement('button')
      removeBtn.className = 'doctor-remove'
      removeBtn.textContent = '✕'
      removeBtn.title = 'Remove doctor'
      removeBtn.addEventListener('click', async () => {
        await api.removeDoctor(doc.id)
        await renderDoctorList(el)
        const cfg = await api.getConfigStatus()
        if (!cfg.noDoctors) {
          warnDoctor.classList.add('hidden')
          updateConfigWarningsVisibility()
        }
      })

      row.appendChild(nameSpan)
      row.appendChild(templateEl)
      row.appendChild(editBtn)
      row.appendChild(removeBtn)
    }

    function renderEditMode() {
      row.innerHTML = ''
      row.classList.add('doctor-row--editing')

      const nameInput = document.createElement('input')
      nameInput.className = 'doctor-edit-name-input'
      nameInput.value = doc.name
      nameInput.placeholder = 'Doctor name'

      const templateLabel = document.createElement('span')
      templateLabel.className = 'doctor-edit-template-label'
      templateLabel.textContent = doc.templatePath ? doc.templatePath.split(/[\\/]/).pop() : 'No template'

      const changeTemplateBtn = document.createElement('button')
      changeTemplateBtn.className = 'doctor-edit-change-template'
      changeTemplateBtn.textContent = 'Change Template'
      changeTemplateBtn.addEventListener('click', async () => {
        const res = await api.updateDoctorTemplate(doc.id)
        if (res.ok) {
          doc.templatePath = res.doctor.templatePath
          templateLabel.textContent = doc.templatePath.split(/[\\/]/).pop()
        }
      })

      const saveBtn = document.createElement('button')
      saveBtn.className = 'doctor-edit-save small'
      saveBtn.textContent = 'Save'
      saveBtn.addEventListener('click', async () => {
        const newName = nameInput.value.trim()
        if (!newName) return
        const res = await api.updateDoctor(doc.id, newName)
        if (res.ok) { doc.name = newName; renderViewMode() }
      })

      nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveBtn.click() })

      const cancelBtn = document.createElement('button')
      cancelBtn.className = 'doctor-edit-cancel small secondary'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.addEventListener('click', () => renderViewMode())

      row.appendChild(nameInput)
      row.appendChild(templateLabel)
      row.appendChild(changeTemplateBtn)
      row.appendChild(saveBtn)
      row.appendChild(cancelBtn)
    }

    renderViewMode()
    el.appendChild(row)
  })
}

async function loadDeviceList(selectedIndex) {
  deviceSelect.innerHTML = '<option value="">Loading...</option>'
  const result = await api.listAudioDevices()
  deviceSelect.innerHTML = ''

  if (result.devices.length === 0) {
    deviceSelect.innerHTML = '<option value="">No loopback devices found</option>'
    return
  }

  result.devices.forEach(dev => {
    const opt = document.createElement('option')
    opt.value = dev.index
    opt.textContent = dev.name + (dev.isDefault ? ' (default)' : '')
    if (selectedIndex != null && dev.index === selectedIndex) opt.selected = true
    deviceSelect.appendChild(opt)
  })
}

btnWindowClose.addEventListener('click', () => api.hideWindow())
btnSettings.addEventListener('click', showSettings)
btnSettingsClose.addEventListener('click', hideSettings)

chkAutoRecord.addEventListener('change', () => {
  api.saveSettings({ autoRecord: chkAutoRecord.checked })
})

btnAdvancedToggle.addEventListener('click', async () => {
  const isOpen = !advancedSettingsContent.classList.contains('hidden')
  if (isOpen) {
    advancedSettingsContent.classList.add('hidden')
    btnAdvancedToggle.classList.remove('open')
  } else {
    advancedSettingsContent.classList.remove('hidden')
    btnAdvancedToggle.classList.add('open')
    const s = await api.getSettings()
    await loadDeviceList(s.selectedDeviceIndex)
    if (soapModelSelect)     soapModelSelect.value     = s.soapModel     || 'claude-sonnet-4-6'
    if (templateModelSelect) templateModelSelect.value = s.templateModel || 'claude-opus-4-7'
  }
})

soapModelSelect.addEventListener('change', () => {
  api.saveSettings({ soapModel: soapModelSelect.value })
})

templateModelSelect.addEventListener('change', () => {
  api.saveSettings({ templateModel: templateModelSelect.value })
})

deviceSelect.addEventListener('change', () => {
  const val = deviceSelect.value
  api.saveSettings({
    manualDeviceSelection: val !== '',
    selectedDeviceIndex: val !== '' ? parseInt(val, 10) : null
  })
})

btnAddDoctor.addEventListener('click', async () => {
  const name = newDoctorInput.value.trim()
  if (!name) return
  btnAddDoctor.disabled = true
  const res = await api.addDoctor(name)
  btnAddDoctor.disabled = false
  if (res.ok) {
    newDoctorInput.value = ''
    await renderDoctorList()
    warnDoctor.classList.add('hidden')
    updateConfigWarningsVisibility()
  }
})

newDoctorInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') btnAddDoctor.click()
})

// ---------------------------------------------------------------------------
// Doctor picker (shown at session start when multiple doctors exist)
// ---------------------------------------------------------------------------

function showDoctorPicker(doctors) {
  doctorPicker.classList.remove('hidden')
  actionButtons.style.display = 'none'
  doctorPickerList.innerHTML = ''
  doctors.forEach(doc => {
    const btn = document.createElement('button')
    btn.textContent = doc.name
    btn.addEventListener('click', () => {
      doctorPicker.classList.add('hidden')
      actionButtons.style.display = ''
      api.selectDoctor(doc.id)
    })
    doctorPickerList.appendChild(btn)
  })
}

btnDoctorPickerCancel.addEventListener('click', () => {
  doctorPicker.classList.add('hidden')
  actionButtons.style.display = ''
  api.selectDoctor(null)
})

// ---------------------------------------------------------------------------
// Folder setup (first launch — no notes dir configured)
// ---------------------------------------------------------------------------

const MAIN_CONTENT_ELS = [
  () => document.getElementById('header-row'),
  () => tabRecord,
  () => tabTemplates,
  () => tabBar
]

function showFolderSetup() {
  folderSetup.classList.remove('hidden')
  MAIN_CONTENT_ELS.forEach(get => { const el = get(); if (el) el.style.display = 'none' })
}

function hideFolderSetup() {
  folderSetup.classList.add('hidden')
  MAIN_CONTENT_ELS.forEach(get => { const el = get(); if (el) el.style.display = '' })
  // Reapply tab visibility after restoring main content
  showTab(activeTab)
}

btnBrowseNotesDir.addEventListener('click', async () => {
  const res = await api.changeNotesDir()
  if (res.ok) {
    hideFolderSetup()
    notesDirPath.textContent = res.path
    notesDirPath.title = res.path
    await initConfigWarnings()
    const state = await api.getState()
    render(state)
    registerAppListeners()
  }
})

function registerAppListeners() {
  api.onStateChange(render)
  api.onShowPatientForm(showPatientForm)
  api.onSetupWarning(showSetupWarning)
  api.onServiceWarning(showServiceWarning)
  api.onPickDoctor(showDoctorPicker)
  api.onAutoStartRecording(async () => {
    setTimeout(() => api.startRecording(), 500)
  })
  api.onTemplateJobStatus(handleTemplateJobStatus)
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

let activeTab = 'record'

function showTab(name) {
  activeTab = name
  const showingRecord = name === 'record'

  if (tabRecord)    tabRecord.style.display    = showingRecord ? '' : 'none'
  if (tabTemplates) {
    tabTemplates.classList.toggle('hidden', showingRecord)
    tabTemplates.style.display = showingRecord ? 'none' : ''
  }

  if (statusRow) statusRow.style.display = showingRecord ? '' : 'none'
  if (tabTitle)  tabTitle.classList.toggle('hidden', showingRecord)

  if (btnTabRecord)    btnTabRecord.classList.toggle('tab-active', showingRecord)
  if (btnTabTemplates) btnTabTemplates.classList.toggle('tab-active', !showingRecord)

  if (!showingRecord) {
    // Reset any open sub-view when re-entering the templates tab
    hideCreateTemplateSubview()
    renderDoctorList(templateDoctorListEl)
    refreshTemplateJobBanner()
  }
}

if (btnTabRecord)    btnTabRecord.addEventListener('click', () => showTab('record'))
if (btnTabTemplates) btnTabTemplates.addEventListener('click', () => showTab('templates'))

// ---------------------------------------------------------------------------
// Templates tab — list + actions
// ---------------------------------------------------------------------------

// --- Add doctor from Templates tab ---
if (btnAddTemplateDoctor) {
  btnAddTemplateDoctor.addEventListener('click', async () => {
    const name = (newTemplateDoctorInput.value || '').trim()
    if (!name) { newTemplateDoctorInput.focus(); return }
    btnAddTemplateDoctor.disabled = true
    const res = await api.addDoctor(name)
    btnAddTemplateDoctor.disabled = false
    if (res.ok) {
      newTemplateDoctorInput.value = ''
      await renderDoctorList(templateDoctorListEl)
      warnDoctor.classList.add('hidden')
      updateConfigWarningsVisibility()
    }
  })
}
if (newTemplateDoctorInput) {
  newTemplateDoctorInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') btnAddTemplateDoctor.click()
  })
}

// ---------------------------------------------------------------------------
// Templates tab — Create with AI sub-view
// ---------------------------------------------------------------------------

let createTemplateFiles = []

function showCreateTemplateSubview() {
  createTemplateFiles = []
  if (createTemplateDoctorInput) createTemplateDoctorInput.value = ''
  renderCreateTemplateFiles()
  hideCreateTemplateError()
  if (btnCreateTemplateStart) btnCreateTemplateStart.disabled = true
  if (templateListView)     templateListView.classList.add('hidden')
  if (createTemplateView)   createTemplateView.classList.remove('hidden')
  if (createTemplateDoctorInput) createTemplateDoctorInput.focus()
}

function hideCreateTemplateSubview() {
  if (createTemplateView) createTemplateView.classList.add('hidden')
  if (templateListView)   templateListView.classList.remove('hidden')
}

function renderCreateTemplateFiles() {
  if (!createTemplateFilesEl) return
  createTemplateFilesEl.innerHTML = ''
  if (createTemplateFiles.length === 0) {
    createTemplateFilesEl.classList.add('create-template-files-empty')
    createTemplateFilesEl.textContent = 'No files added yet'
    return
  }
  createTemplateFilesEl.classList.remove('create-template-files-empty')
  createTemplateFiles.forEach((fp, idx) => {
    const row = document.createElement('div')
    row.className = 'create-template-file-row'
    const name = document.createElement('span')
    name.className = 'create-template-file-name'
    name.textContent = fp.split(/[\\/]/).pop()
    name.title = fp
    const rm = document.createElement('button')
    rm.className = 'create-template-file-remove'
    rm.textContent = '✕'
    rm.title = 'Remove'
    rm.addEventListener('click', () => {
      createTemplateFiles.splice(idx, 1)
      renderCreateTemplateFiles()
      updateCreateTemplateStartEnabled()
    })
    row.appendChild(name)
    row.appendChild(rm)
    createTemplateFilesEl.appendChild(row)
  })
}

function updateCreateTemplateStartEnabled() {
  if (!btnCreateTemplateStart) return
  const name = (createTemplateDoctorInput?.value || '').trim()
  btnCreateTemplateStart.disabled = !name || createTemplateFiles.length === 0
}

function showCreateTemplateError(msg) {
  if (!createTemplateError) return
  createTemplateError.textContent = msg
  createTemplateError.classList.remove('hidden')
}

function hideCreateTemplateError() {
  if (createTemplateError) createTemplateError.classList.add('hidden')
}

if (btnCreateTemplateBack) {
  btnCreateTemplateBack.addEventListener('click', hideCreateTemplateSubview)
}

if (btnTemplateCreateAi) {
  btnTemplateCreateAi.addEventListener('click', showCreateTemplateSubview)
}

if (createTemplateDoctorInput) {
  createTemplateDoctorInput.addEventListener('input', updateCreateTemplateStartEnabled)
}

if (btnCreateTemplateAddFiles) {
  btnCreateTemplateAddFiles.addEventListener('click', async () => {
    btnCreateTemplateAddFiles.disabled = true
    try {
      const paths = await api.browseNotesFiles()
      if (Array.isArray(paths) && paths.length > 0) {
        // De-duplicate against already-added files
        const set = new Set(createTemplateFiles)
        paths.forEach(p => set.add(p))
        createTemplateFiles = Array.from(set)
        renderCreateTemplateFiles()
        updateCreateTemplateStartEnabled()
      }
    } finally {
      btnCreateTemplateAddFiles.disabled = false
    }
  })
}

if (btnCreateTemplateStart) {
  btnCreateTemplateStart.addEventListener('click', async () => {
    hideCreateTemplateError()
    const name = (createTemplateDoctorInput.value || '').trim()
    if (!name) {
      showCreateTemplateError('Doctor name is required')
      return
    }
    if (createTemplateFiles.length === 0) {
      showCreateTemplateError('Add at least one source file')
      return
    }

    btnCreateTemplateStart.disabled = true
    const res = await api.startTemplateCreation(name, createTemplateFiles)
    if (!res.ok) {
      showCreateTemplateError(res.error || 'Failed to start')
      btnCreateTemplateStart.disabled = false
      return
    }
    // Return to the list view; the job banner will show progress
    hideCreateTemplateSubview()
    refreshTemplateJobBanner()
  })
}

// ---------------------------------------------------------------------------
// Templates tab — Update with AI sub-view
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Update-with-AI — state
// ---------------------------------------------------------------------------

let updateTemplateCorrectionsFile = null
let updateTemplateSampleFiles     = []

function renderUpdateCorrectionsFile() {
  if (!updateTemplateCorrectionsFileEl) return
  if (!updateTemplateCorrectionsFile) {
    updateTemplateCorrectionsFileEl.classList.add('create-template-files-empty')
    updateTemplateCorrectionsFileEl.textContent = 'No file added'
    return
  }
  updateTemplateCorrectionsFileEl.classList.remove('create-template-files-empty')
  updateTemplateCorrectionsFileEl.innerHTML = ''
  const row = document.createElement('div')
  row.className = 'create-template-file-row'
  const name = document.createElement('span')
  name.className = 'create-template-file-name'
  name.textContent = updateTemplateCorrectionsFile.split(/[\\/]/).pop()
  name.title = updateTemplateCorrectionsFile
  const rm = document.createElement('button')
  rm.className = 'create-template-file-remove'
  rm.textContent = '✕'
  rm.title = 'Remove'
  rm.addEventListener('click', () => {
    updateTemplateCorrectionsFile = null
    renderUpdateCorrectionsFile()
    validateUpdateForm()
  })
  row.appendChild(name)
  row.appendChild(rm)
  updateTemplateCorrectionsFileEl.appendChild(row)
}

function renderUpdateTemplateFiles() {
  if (!updateTemplateFilesEl) return
  updateTemplateFilesEl.innerHTML = ''
  if (updateTemplateSampleFiles.length === 0) {
    updateTemplateFilesEl.classList.add('create-template-files-empty')
    updateTemplateFilesEl.textContent = 'No files added yet'
    return
  }
  updateTemplateFilesEl.classList.remove('create-template-files-empty')
  updateTemplateSampleFiles.forEach((fp, idx) => {
    const row = document.createElement('div')
    row.className = 'create-template-file-row'
    const name = document.createElement('span')
    name.className = 'create-template-file-name'
    name.textContent = fp.split(/[\\/]/).pop()
    name.title = fp
    const rm = document.createElement('button')
    rm.className = 'create-template-file-remove'
    rm.textContent = '✕'
    rm.title = 'Remove'
    rm.addEventListener('click', () => {
      updateTemplateSampleFiles.splice(idx, 1)
      renderUpdateTemplateFiles()
      validateUpdateForm()
    })
    row.appendChild(name)
    row.appendChild(rm)
    updateTemplateFilesEl.appendChild(row)
  })
}

function showUpdateTemplateSubview() {
  updateTemplateCorrectionsFile = null
  updateTemplateSampleFiles = []
  if (updateTemplateDoctorSel) updateTemplateDoctorSel.innerHTML = '<option value="">Select doctor…</option>'
  if (updateTemplateCorrections) updateTemplateCorrections.value = ''
  if (updateTemplateError) updateTemplateError.classList.add('hidden')
  if (btnUpdateTemplateStart) btnUpdateTemplateStart.disabled = true
  renderUpdateCorrectionsFile()
  renderUpdateTemplateFiles()
  if (templateListView) templateListView.classList.add('hidden')
  if (updateTemplateView) updateTemplateView.classList.remove('hidden')
}

function hideUpdateTemplateSubview() {
  if (updateTemplateView) updateTemplateView.classList.add('hidden')
  if (templateListView) templateListView.classList.remove('hidden')
}

function validateUpdateForm() {
  if (!btnUpdateTemplateStart) return
  const hasDoctor = updateTemplateDoctorSel && updateTemplateDoctorSel.value
  const hasCorrections = updateTemplateCorrections && updateTemplateCorrections.value.trim()
  const hasFile = !!updateTemplateCorrectionsFile
  const hasSamples = updateTemplateSampleFiles.length > 0
  btnUpdateTemplateStart.disabled = !(hasDoctor && (hasCorrections || hasFile || hasSamples))
}

if (btnTemplateUpdateAi) {
  btnTemplateUpdateAi.addEventListener('click', async () => {
    showUpdateTemplateSubview()
    if (!api.getDoctorsWithTemplates) return
    const doctors = await api.getDoctorsWithTemplates()
    if (!updateTemplateDoctorSel) return
    updateTemplateDoctorSel.innerHTML = '<option value="">Select doctor…</option>'
    doctors.forEach(name => {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      updateTemplateDoctorSel.appendChild(opt)
    })
  })
}

if (btnUpdateTemplateBack) {
  btnUpdateTemplateBack.addEventListener('click', hideUpdateTemplateSubview)
}

if (updateTemplateDoctorSel) {
  updateTemplateDoctorSel.addEventListener('change', validateUpdateForm)
}

if (updateTemplateCorrections) {
  updateTemplateCorrections.addEventListener('input', validateUpdateForm)
}

if (btnUpdateTemplateAddCorrectionsFile) {
  btnUpdateTemplateAddCorrectionsFile.addEventListener('click', async () => {
    if (!api.browseCorrectionsFile) return
    const filePath = await api.browseCorrectionsFile()
    if (filePath) {
      updateTemplateCorrectionsFile = filePath
      renderUpdateCorrectionsFile()
      validateUpdateForm()
    }
  })
}

if (btnUpdateTemplateAddFiles) {
  btnUpdateTemplateAddFiles.addEventListener('click', async () => {
    const paths = await api.browseNotesFiles()
    if (Array.isArray(paths) && paths.length > 0) {
      const set = new Set(updateTemplateSampleFiles)
      paths.forEach(p => set.add(p))
      updateTemplateSampleFiles = Array.from(set)
      renderUpdateTemplateFiles()
      validateUpdateForm()
    }
  })
}

if (btnUpdateTemplateStart) {
  btnUpdateTemplateStart.addEventListener('click', async () => {
    if (updateTemplateError) updateTemplateError.classList.add('hidden')
    const doctorName  = updateTemplateDoctorSel ? updateTemplateDoctorSel.value : ''
    const corrections = updateTemplateCorrections ? updateTemplateCorrections.value.trim() : ''
    if (!doctorName) return

    btnUpdateTemplateStart.disabled = true
    const err = await api.startTemplateUpdate(
      doctorName,
      corrections,
      updateTemplateCorrectionsFile,
      updateTemplateSampleFiles
    )
    if (err) {
      if (updateTemplateError) {
        updateTemplateError.textContent = err
        updateTemplateError.classList.remove('hidden')
      }
      btnUpdateTemplateStart.disabled = false
      return
    }
    hideUpdateTemplateSubview()
    refreshTemplateJobBanner()
  })
}

// ---------------------------------------------------------------------------
// Templates tab — Running job banner
// ---------------------------------------------------------------------------

let jobPollInterval = null

function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m > 0 ? `${m} min ${s}s` : `${s}s`
}

function handleTemplateJobStatus(job) {
  if (!templateJobBanner) return
  if (!job || job.status === 'idle') {
    templateJobBanner.classList.add('hidden')
    stopJobPolling()
    return
  }
  const isUpdate = job.type === 'update'
  if (job.status === 'running') {
    templateJobBanner.classList.remove('hidden')
    templateJobBanner.classList.remove('banner-failed', 'banner-success')
    const elapsed = formatElapsed(Date.now() - (job.startedAt || Date.now()))
    const verb = isUpdate ? 'Updating' : 'Creating'
    templateJobBannerText.innerHTML = `${verb} template for <strong>${job.doctorName || 'doctor'}</strong> — ${elapsed}`
    if (btnTemplateJobCancel) btnTemplateJobCancel.classList.remove('hidden')
    startJobPolling()
  } else if (job.status === 'success') {
    templateJobBanner.classList.remove('hidden')
    templateJobBanner.classList.add('banner-success')
    templateJobBanner.classList.remove('banner-failed')
    const doneText = isUpdate ? 'Template updated for' : 'Template ready for'
    templateJobBannerText.innerHTML = `${doneText} <strong>${job.doctorName || 'doctor'}</strong>`
    if (btnTemplateJobCancel) btnTemplateJobCancel.classList.add('hidden')
    stopJobPolling()
    renderDoctorList(templateDoctorListEl)
    // A doctor was added — dismiss the "Doctor not set up" warning if present
    warnDoctor.classList.add('hidden')
    updateConfigWarningsVisibility()

    // Show "View changes" button if a changes report is available
    if (job.changesReport) {
      currentChangesReport = job.changesReport
      if (btnTemplateViewChanges) btnTemplateViewChanges.classList.remove('hidden')
    } else {
      if (btnTemplateViewChanges) btnTemplateViewChanges.classList.add('hidden')
    }

    // Only auto-dismiss if there's no changes report to view
    if (!job.changesReport) {
      setTimeout(() => {
        if (templateJobBanner && templateJobBanner.classList.contains('banner-success')) {
          templateJobBanner.classList.add('hidden')
        }
      }, 6000)
    }
  } else if (job.status === 'failed') {
    templateJobBanner.classList.remove('hidden')
    templateJobBanner.classList.add('banner-failed')
    templateJobBanner.classList.remove('banner-success')
    const failLabel = isUpdate ? 'Template update failed' : 'Template creation failed'
    templateJobBannerText.innerHTML = `<strong>${failLabel}</strong> — ${job.error || 'unknown error'}`
    if (btnTemplateJobCancel) btnTemplateJobCancel.classList.remove('hidden')
    stopJobPolling()
  }
}

async function refreshTemplateJobBanner() {
  if (!api.getTemplateJobStatus) return
  const job = await api.getTemplateJobStatus()
  handleTemplateJobStatus(job)
}

function startJobPolling() {
  if (jobPollInterval) return
  jobPollInterval = setInterval(async () => {
    const job = await api.getTemplateJobStatus()
    // Keep the banner fresh so elapsed-time updates even if no push arrived
    handleTemplateJobStatus(job)
  }, 3000)
}

function stopJobPolling() {
  if (jobPollInterval) {
    clearInterval(jobPollInterval)
    jobPollInterval = null
  }
}

// ---------------------------------------------------------------------------
// Templates tab — Changes panel
// ---------------------------------------------------------------------------

let currentChangesReport = null

if (btnTemplateViewChanges) {
  btnTemplateViewChanges.addEventListener('click', () => {
    if (!currentChangesReport) return
    if (templateChangesText) templateChangesText.textContent = currentChangesReport
    if (templateListView) templateListView.classList.add('hidden')
    if (templateChangesPanel) templateChangesPanel.classList.remove('hidden')
  })
}

if (btnTemplateChangesClose) {
  btnTemplateChangesClose.addEventListener('click', () => {
    if (templateChangesPanel) templateChangesPanel.classList.add('hidden')
    if (templateListView) templateListView.classList.remove('hidden')
  })
}

if (btnTemplateJobCancel) {
  btnTemplateJobCancel.addEventListener('click', async () => {
    const job = await api.getTemplateJobStatus()
    if (!job || job.status !== 'running') {
      await api.dismissTemplateJob()
      templateJobBanner.classList.add('hidden')
      return
    }
    const cancelMsg = job.type === 'update'
      ? 'Cancel template update? Progress will be lost.'
      : 'Cancel template creation? Progress will be lost.'
    if (!confirm(cancelMsg)) return
    btnTemplateJobCancel.disabled = true
    await api.cancelTemplateCreation()
    btnTemplateJobCancel.disabled = false
  })
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  const state = await api.getState()
  render(state)
  const cfg = await api.getConfigStatus()

  if (cfg.notesDirMissing) {
    showFolderSetup()
    return
  }

  await initConfigWarnings()
  registerAppListeners()
}

init().catch(console.error)
