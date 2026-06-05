'use strict'

const { contextBridge, ipcRenderer } = require('electron')
const { CHANNELS } = require('./src/shared/ipc-channels')

contextBridge.exposeInMainWorld('api', {
  getState:          ()     => ipcRenderer.invoke(CHANNELS.GET_STATE),
  getBuildInfo:      ()     => ipcRenderer.invoke(CHANNELS.GET_BUILD_INFO),
  startSession:      ()     => ipcRenderer.invoke(CHANNELS.START_SESSION),
  stopSession:       ()     => ipcRenderer.invoke(CHANNELS.STOP_SESSION),
  startRecording:    ()     => ipcRenderer.invoke(CHANNELS.START_RECORDING),
  stopRecording:     ()     => ipcRenderer.invoke(CHANNELS.STOP_RECORDING),
  pauseRecording:    ()     => ipcRenderer.invoke(CHANNELS.PAUSE_RECORDING),
  resumeRecording:   ()     => ipcRenderer.invoke(CHANNELS.RESUME_RECORDING),
  discardRecording:  ()     => ipcRenderer.invoke(CHANNELS.DISCARD_RECORDING),
  submitPatientName: (name) => ipcRenderer.invoke(CHANNELS.SUBMIT_PATIENT_NAME, name),

  getConfigStatus:    ()     => ipcRenderer.invoke(CHANNELS.GET_CONFIG_STATUS),
  getElevenLabsKey:  ()     => ipcRenderer.invoke(CHANNELS.GET_ELEVENLABS_KEY),
  saveElevenLabsKey: (key)   => ipcRenderer.invoke(CHANNELS.SAVE_ELEVENLABS_KEY, key),

  getDoctors:         ()     => ipcRenderer.invoke(CHANNELS.GET_DOCTORS),
  addDoctor:              (name) => ipcRenderer.invoke(CHANNELS.ADD_DOCTOR, name),
  updateDoctor:          (id, name) => ipcRenderer.invoke(CHANNELS.UPDATE_DOCTOR, id, name),
  updateDoctorTemplate:  (id)   => ipcRenderer.invoke(CHANNELS.UPDATE_DOCTOR_TEMPLATE, id),
  updateDoctorSpecialty: (id, specialty) => ipcRenderer.invoke(CHANNELS.UPDATE_DOCTOR_SPECIALTY, id, specialty),
  removeDoctor:           (id)   => ipcRenderer.invoke(CHANNELS.REMOVE_DOCTOR, id),
  selectDoctor:       (id)   => ipcRenderer.invoke(CHANNELS.SELECT_DOCTOR, id),

  browseAudioFile:    ()                       => ipcRenderer.invoke(CHANNELS.BROWSE_AUDIO_FILE),
  processAudioFile:   (filePath, patientName)  => ipcRenderer.invoke(CHANNELS.PROCESS_AUDIO_FILE, filePath, patientName),

  browseNotesFiles:         ()                                                           => ipcRenderer.invoke(CHANNELS.BROWSE_NOTES_FILES),
  browseCorrectionsFile:    ()                                                           => ipcRenderer.invoke(CHANNELS.BROWSE_CORRECTIONS_FILE),
  startTemplateCreation:    (doctorName, filePaths)                                      => ipcRenderer.invoke(CHANNELS.START_TEMPLATE_CREATION, doctorName, filePaths),
  startTemplateUpdate:      (doctorName, corrections, correctionsFile, sampleFiles)      => ipcRenderer.invoke(CHANNELS.START_TEMPLATE_UPDATE, doctorName, corrections, correctionsFile, sampleFiles),
  getDoctorsWithTemplates:  ()                           => ipcRenderer.invoke(CHANNELS.GET_DOCTORS_WITH_TEMPLATES),
  getTemplateJobStatus:     ()                           => ipcRenderer.invoke(CHANNELS.GET_TEMPLATE_JOB_STATUS),
  cancelTemplateCreation:   ()                           => ipcRenderer.invoke(CHANNELS.CANCEL_TEMPLATE_CREATION),
  dismissTemplateJob:       ()                           => ipcRenderer.invoke(CHANNELS.DISMISS_TEMPLATE_JOB),

  browsePrechartFiles:      ()                                       => ipcRenderer.invoke(CHANNELS.BROWSE_PRECHART_FILES),
  listRecentPatientCases:   ()                                       => ipcRenderer.invoke(CHANNELS.LIST_RECENT_PATIENT_CASES),
  browsePatientCaseFolder:  ()                                       => ipcRenderer.invoke(CHANNELS.BROWSE_PATIENT_CASE_FOLDER),
  startPrechartJob:         (doctorId, caseDir, instructions, attachmentPaths) => ipcRenderer.invoke(CHANNELS.START_PRECHART_JOB, doctorId, caseDir, instructions, attachmentPaths),

  getSettings:        ()          => ipcRenderer.invoke(CHANNELS.GET_SETTINGS),
  saveSettings:       (settings)  => ipcRenderer.invoke(CHANNELS.SAVE_SETTINGS, settings),
  listAudioDevices:   ()          => ipcRenderer.invoke(CHANNELS.LIST_AUDIO_DEVICES),
  getNotesDir:        ()          => ipcRenderer.invoke(CHANNELS.GET_NOTES_DIR),
  changeNotesDir:     (mode)      => ipcRenderer.invoke(CHANNELS.CHANGE_NOTES_DIR, mode),

  hideWindow:             ()   => ipcRenderer.invoke(CHANNELS.HIDE_WINDOW),

  getSessionRecordings:    ()           => ipcRenderer.invoke(CHANNELS.GET_SESSION_RECORDINGS),
  openStatusWindow:        ()           => ipcRenderer.invoke(CHANNELS.OPEN_STATUS_WINDOW),
  closeStatusWindow:       ()           => ipcRenderer.invoke(CHANNELS.CLOSE_STATUS_WINDOW),
  openSoapNote:            (filePath)   => ipcRenderer.invoke(CHANNELS.OPEN_SOAP_NOTE, filePath),

  onStateChange:           (cb) => ipcRenderer.on(CHANNELS.STATE_CHANGE,            (_, s)       => cb(s)),
  onShowPatientForm:       (cb) => ipcRenderer.on(CHANNELS.SHOW_PATIENT_FORM,       ()           => cb()),
  onSetupWarning:          (cb) => ipcRenderer.on(CHANNELS.SETUP_WARNING,           (_, msg)     => cb(msg)),
  onAutoStartRecording:    (cb) => ipcRenderer.on(CHANNELS.AUTO_START_RECORDING,    ()           => cb()),
  onPickDoctor:            (cb) => ipcRenderer.on(CHANNELS.PICK_DOCTOR,             (_, doctors) => cb(doctors)),
  onServiceWarning:        (cb) => ipcRenderer.on(CHANNELS.SERVICE_WARNING,         (_, data)    => cb(data)),
  onRecordingStatusUpdate: (cb) => ipcRenderer.on(CHANNELS.RECORDING_STATUS_UPDATE, (_, data)    => cb(data)),
  onTemplateJobStatus:     (cb) => ipcRenderer.on(CHANNELS.TEMPLATE_JOB_STATUS,     (_, job)     => cb(job))
})
