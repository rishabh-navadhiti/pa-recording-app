'use strict'

// IMPORTANT: this preload runs SANDBOXED (Electron's default — webPreferences
// has no `sandbox:false`). A sandboxed preload's require() is a limited polyfill
// that can ONLY load `electron` + a few builtins — NOT local files. So we must
// NOT pull in the shared ipc-channels module here (it would throw → window.api
// never gets exposed → the whole UI silently loses its data). Channel strings are kept
// as literals; the drift test (tests/unit/shared-drift.test.js) asserts they all
// exist in the CHANNELS map, which is the single source the main-process side uses.
// (A bundler in Phase 6 will let the renderer/preload import shared constants.)

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  getState:          ()     => ipcRenderer.invoke('get-state'),
  getBuildInfo:      ()     => ipcRenderer.invoke('get-build-info'),
  startSession:      ()     => ipcRenderer.invoke('start-session'),
  stopSession:       ()     => ipcRenderer.invoke('stop-session'),
  startRecording:    ()     => ipcRenderer.invoke('start-recording'),
  stopRecording:     ()     => ipcRenderer.invoke('stop-recording'),
  pauseRecording:    ()     => ipcRenderer.invoke('pause-recording'),
  resumeRecording:   ()     => ipcRenderer.invoke('resume-recording'),
  discardRecording:  ()     => ipcRenderer.invoke('discard-recording'),
  submitPatientName: (name, multiPatient) => ipcRenderer.invoke('submit-patient-name', name, multiPatient),

  getConfigStatus:    ()     => ipcRenderer.invoke('get-config-status'),
  getElevenLabsKey:  ()     => ipcRenderer.invoke('get-elevenlabs-key'),
  saveElevenLabsKey: (key)   => ipcRenderer.invoke('save-elevenlabs-key', key),
  getAnthropicKey:   ()     => ipcRenderer.invoke('get-anthropic-key'),
  saveAnthropicKey:  (key)   => ipcRenderer.invoke('save-anthropic-key', key),
  getGeminiKey:      ()     => ipcRenderer.invoke('get-gemini-key'),
  saveGeminiKey:     (key)   => ipcRenderer.invoke('save-gemini-key', key),
  getOpenRouterKey:  ()     => ipcRenderer.invoke('get-openrouter-key'),
  saveOpenRouterKey: (key)   => ipcRenderer.invoke('save-openrouter-key', key),
  getDoctors:         ()     => ipcRenderer.invoke('get-doctors'),
  addDoctor:              (name) => ipcRenderer.invoke('add-doctor', name),
  updateDoctor:          (id, name) => ipcRenderer.invoke('update-doctor', id, name),
  updateDoctorTemplate:  (id)   => ipcRenderer.invoke('update-doctor-template', id),
  updateDoctorSpecialty: (id, specialty) => ipcRenderer.invoke('update-doctor-specialty', id, specialty),
  removeDoctor:           (id)   => ipcRenderer.invoke('remove-doctor', id),
  selectDoctor:       (id)   => ipcRenderer.invoke('select-doctor', id),

  browseAudioFile:    ()                       => ipcRenderer.invoke('browse-audio-file'),
  processAudioFile:   (filePath, patientName, multiPatient) => ipcRenderer.invoke('process-audio-file', filePath, patientName, multiPatient),

  browseNotesFiles:         ()                                                           => ipcRenderer.invoke('browse-notes-files'),
  browseCorrectionsFile:    ()                                                           => ipcRenderer.invoke('browse-corrections-file'),
  startTemplateCreation:    (doctorName, filePaths)                                      => ipcRenderer.invoke('start-template-creation', doctorName, filePaths),
  startTemplateUpdate:      (doctorName, corrections, correctionsFile, sampleFiles)      => ipcRenderer.invoke('start-template-update', doctorName, corrections, correctionsFile, sampleFiles),
  getDoctorsWithTemplates:  ()                           => ipcRenderer.invoke('get-doctors-with-templates'),
  getTemplateJobStatus:     ()                           => ipcRenderer.invoke('get-template-job-status'),
  cancelTemplateCreation:   ()                           => ipcRenderer.invoke('cancel-template-creation'),
  dismissTemplateJob:       ()                           => ipcRenderer.invoke('dismiss-template-job'),

  browsePrechartFiles:      ()                                       => ipcRenderer.invoke('browse-prechart-files'),
  listRecentPatientCases:   ()                                       => ipcRenderer.invoke('list-recent-patient-cases'),
  browsePatientCaseFolder:  ()                                       => ipcRenderer.invoke('browse-patient-case-folder'),
  startPrechartJob:         (doctorId, caseDir, instructions, attachmentPaths, chartText) => ipcRenderer.invoke('start-prechart-job', doctorId, caseDir, instructions, attachmentPaths, chartText),
  savePrechartContext:      (text, files)                            => ipcRenderer.invoke('save-prechart-context', text, files),
  getPrechartContext:       ()                                       => ipcRenderer.invoke('get-prechart-context'),

  getSettings:        ()          => ipcRenderer.invoke('get-settings'),
  saveSettings:       (settings)  => ipcRenderer.invoke('save-settings', settings),
  listAudioDevices:   ()          => ipcRenderer.invoke('list-audio-devices'),
  getNotesDir:        ()          => ipcRenderer.invoke('get-notes-dir'),
  changeNotesDir:     (mode)      => ipcRenderer.invoke('change-notes-dir', mode),

  hideWindow:             ()   => ipcRenderer.invoke('hide-window'),

  getSessionRecordings:    ()           => ipcRenderer.invoke('get-session-recordings'),
  openStatusWindow:        ()           => ipcRenderer.invoke('open-status-window'),
  closeStatusWindow:       ()           => ipcRenderer.invoke('close-status-window'),
  openSoapNote:            (filePath)   => ipcRenderer.invoke('open-soap-note', filePath),

  onStateChange:           (cb) => ipcRenderer.on('state-change',            (_, s)       => cb(s)),
  onShowPatientForm:       (cb) => ipcRenderer.on('show-patient-form',       ()           => cb()),
  onSetupWarning:          (cb) => ipcRenderer.on('setup-warning',           (_, msg)     => cb(msg)),
  onAutoStartRecording:    (cb) => ipcRenderer.on('auto-start-recording',    ()           => cb()),
  onPickDoctor:            (cb) => ipcRenderer.on('pick-doctor',             (_, doctors) => cb(doctors)),
  onServiceWarning:        (cb) => ipcRenderer.on('service-warning',         (_, data)    => cb(data)),
  onRecordingStatusUpdate: (cb) => ipcRenderer.on('recording-status-update', (_, data)    => cb(data)),
  onTemplateJobStatus:     (cb) => ipcRenderer.on('template-job-status',     (_, job)     => cb(job)),
  onCostiganReportReady:   (cb) => ipcRenderer.on('costigan-report-ready',   (_, data)    => cb(data))
})
