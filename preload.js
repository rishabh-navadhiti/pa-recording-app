'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getState:          ()     => ipcRenderer.invoke('get-state'),
  startSession:      ()     => ipcRenderer.invoke('start-session'),
  stopSession:       ()     => ipcRenderer.invoke('stop-session'),
  startRecording:    ()     => ipcRenderer.invoke('start-recording'),
  stopRecording:     ()     => ipcRenderer.invoke('stop-recording'),
  pauseRecording:    ()     => ipcRenderer.invoke('pause-recording'),
  resumeRecording:   ()     => ipcRenderer.invoke('resume-recording'),
  discardRecording:  ()     => ipcRenderer.invoke('discard-recording'),
  submitPatientName: (name) => ipcRenderer.invoke('submit-patient-name', name),

  getConfigStatus:    ()     => ipcRenderer.invoke('get-config-status'),
  saveElevenLabsKey: (key)   => ipcRenderer.invoke('save-elevenlabs-key', key),

  getDoctors:         ()     => ipcRenderer.invoke('get-doctors'),
  addDoctor:              (name) => ipcRenderer.invoke('add-doctor', name),
  updateDoctor:          (id, name) => ipcRenderer.invoke('update-doctor', id, name),
  updateDoctorTemplate:  (id)   => ipcRenderer.invoke('update-doctor-template', id),
  removeDoctor:           (id)   => ipcRenderer.invoke('remove-doctor', id),
  selectDoctor:       (id)   => ipcRenderer.invoke('select-doctor', id),

  browseAudioFile:    ()                       => ipcRenderer.invoke('browse-audio-file'),
  processAudioFile:   (filePath, patientName)  => ipcRenderer.invoke('process-audio-file', filePath, patientName),

  getSettings:        ()          => ipcRenderer.invoke('get-settings'),
  saveSettings:       (settings)  => ipcRenderer.invoke('save-settings', settings),
  listAudioDevices:   ()          => ipcRenderer.invoke('list-audio-devices'),
  getNotesDir:        ()          => ipcRenderer.invoke('get-notes-dir'),
  changeNotesDir:     (mode)      => ipcRenderer.invoke('change-notes-dir', mode),

  hideWindow:             ()   => ipcRenderer.invoke('hide-window'),

  getSessionRecordings:    ()   => ipcRenderer.invoke('get-session-recordings'),
  openStatusWindow:        ()   => ipcRenderer.invoke('open-status-window'),
  closeStatusWindow:       ()   => ipcRenderer.invoke('close-status-window'),

  onStateChange:           (cb) => ipcRenderer.on('state-change',            (_, s)       => cb(s)),
  onShowPatientForm:       (cb) => ipcRenderer.on('show-patient-form',       ()           => cb()),
  onSetupWarning:          (cb) => ipcRenderer.on('setup-warning',           (_, msg)     => cb(msg)),
  onAutoStartRecording:    (cb) => ipcRenderer.on('auto-start-recording',    ()           => cb()),
  onPickDoctor:            (cb) => ipcRenderer.on('pick-doctor',             (_, doctors) => cb(doctors)),
  onServiceWarning:        (cb) => ipcRenderer.on('service-warning',         (_, data)    => cb(data)),
  onRecordingStatusUpdate: (cb) => ipcRenderer.on('recording-status-update', (_, data)    => cb(data))
})
