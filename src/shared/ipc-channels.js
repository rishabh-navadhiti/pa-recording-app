'use strict'

// Frozen map of every IPC channel string used between main and renderer.
// HANDLE channels are request/response (ipcMain.handle / ipcRenderer.invoke).
// SEND channels are fire-and-forget events (ipcMain.webContents.send / ipcRenderer.on).
//
// Phase 0: created here as the single source.
// Phase 3: preload.js and main.js's registerIpcHandlers() will import from
// here so a typo becomes a load-time undefined instead of a silent hang.

const CHANNELS = Object.freeze({
  // ---- state & config ----
  GET_STATE:            'get-state',
  GET_BUILD_INFO:       'get-build-info',
  GET_CONFIG_STATUS:    'get-config-status',
  GET_SETTINGS:         'get-settings',
  SAVE_SETTINGS:        'save-settings',
  GET_NOTES_DIR:        'get-notes-dir',
  CHANGE_NOTES_DIR:     'change-notes-dir',
  GET_ELEVENLABS_KEY:   'get-elevenlabs-key',
  SAVE_ELEVENLABS_KEY:  'save-elevenlabs-key',
  GET_ANTHROPIC_KEY:    'get-anthropic-key',
  SAVE_ANTHROPIC_KEY:   'save-anthropic-key',
  GET_GEMINI_KEY:       'get-gemini-key',
  SAVE_GEMINI_KEY:      'save-gemini-key',
  GET_OPENAI_KEY:       'get-openai-key',
  SAVE_OPENAI_KEY:      'save-openai-key',
  HIDE_WINDOW:          'hide-window',

  // ---- session & recording ----
  START_SESSION:        'start-session',
  STOP_SESSION:         'stop-session',
  START_RECORDING:      'start-recording',
  STOP_RECORDING:       'stop-recording',
  PAUSE_RECORDING:      'pause-recording',
  RESUME_RECORDING:     'resume-recording',
  DISCARD_RECORDING:    'discard-recording',
  SUBMIT_PATIENT_NAME:  'submit-patient-name',

  // ---- audio upload ----
  BROWSE_AUDIO_FILE:    'browse-audio-file',
  PROCESS_AUDIO_FILE:   'process-audio-file',

  // ---- doctors ----
  GET_DOCTORS:              'get-doctors',
  ADD_DOCTOR:               'add-doctor',
  UPDATE_DOCTOR:            'update-doctor',
  UPDATE_DOCTOR_TEMPLATE:   'update-doctor-template',
  UPDATE_DOCTOR_SPECIALTY:  'update-doctor-specialty',
  REMOVE_DOCTOR:            'remove-doctor',
  SELECT_DOCTOR:            'select-doctor',

  // ---- templates ----
  BROWSE_NOTES_FILES:       'browse-notes-files',
  BROWSE_CORRECTIONS_FILE:  'browse-corrections-file',
  START_TEMPLATE_CREATION:  'start-template-creation',
  START_TEMPLATE_UPDATE:    'start-template-update',
  GET_DOCTORS_WITH_TEMPLATES: 'get-doctors-with-templates',
  GET_TEMPLATE_JOB_STATUS:  'get-template-job-status',
  CANCEL_TEMPLATE_CREATION: 'cancel-template-creation',
  DISMISS_TEMPLATE_JOB:     'dismiss-template-job',

  // ---- prechart ----
  BROWSE_PRECHART_FILES:    'browse-prechart-files',
  LIST_RECENT_PATIENT_CASES: 'list-recent-patient-cases',
  BROWSE_PATIENT_CASE_FOLDER: 'browse-patient-case-folder',
  START_PRECHART_JOB:       'start-prechart-job',
  // in-recording pre-chart context capture (fed into initial note generation)
  SAVE_PRECHART_CONTEXT:    'save-prechart-context',
  GET_PRECHART_CONTEXT:     'get-prechart-context',

  // ---- status window ----
  GET_SESSION_RECORDINGS:   'get-session-recordings',
  OPEN_STATUS_WINDOW:       'open-status-window',
  CLOSE_STATUS_WINDOW:      'close-status-window',
  OPEN_SOAP_NOTE:           'open-soap-note',
  LIST_AUDIO_DEVICES:       'list-audio-devices',

  // ---- events (send / on) ----
  STATE_CHANGE:             'state-change',
  SHOW_PATIENT_FORM:        'show-patient-form',
  SETUP_WARNING:            'setup-warning',
  AUTO_START_RECORDING:     'auto-start-recording',
  PICK_DOCTOR:              'pick-doctor',
  SERVICE_WARNING:          'service-warning',
  RECORDING_STATUS_UPDATE:  'recording-status-update',
  TEMPLATE_JOB_STATUS:      'template-job-status',
  COSTIGAN_REPORT_READY:    'costigan-report-ready'
})

module.exports = { CHANNELS }
