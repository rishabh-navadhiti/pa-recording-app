'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getState:          ()     => ipcRenderer.invoke('get-state'),
  startSession:      ()     => ipcRenderer.invoke('start-session'),
  stopSession:       ()     => ipcRenderer.invoke('stop-session'),
  startRecording:    ()     => ipcRenderer.invoke('start-recording'),
  stopRecording:     ()     => ipcRenderer.invoke('stop-recording'),
  submitPatientName: (name) => ipcRenderer.invoke('submit-patient-name', name),

  getConfigStatus:    ()    => ipcRenderer.invoke('get-config-status'),
  saveDoctorName:    (name) => ipcRenderer.invoke('save-doctor-name', name),
  saveElevenLabsKey: (key)  => ipcRenderer.invoke('save-elevenlabs-key', key),

  browseAudioFile:    ()                       => ipcRenderer.invoke('browse-audio-file'),
  processAudioFile:   (filePath, patientName)  => ipcRenderer.invoke('process-audio-file', filePath, patientName),

  onStateChange:     (cb) => ipcRenderer.on('state-change',    (_, s)   => cb(s)),
  onShowPatientForm: (cb) => ipcRenderer.on('show-patient-form', ()      => cb()),
  onSetupWarning:    (cb) => ipcRenderer.on('setup-warning',   (_, msg) => cb(msg))
})
