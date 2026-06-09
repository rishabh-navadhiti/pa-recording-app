// Renderer-side copies of the shared enums.
//
// The renderer is sandboxed + context-isolated — it has no `require` and can't
// import the CommonJS src/shared/*.js files. So these are deliberate copies,
// kept in sync by the drift test (tests/unit/shared-drift.test.js). True
// single-sourcing arrives with the Phase 6 bundler (which can convert CJS↔ESM).

export const STATE = {
  IDLE:           'IDLE',
  SESSION_ACTIVE: 'SESSION_ACTIVE',
  RECORDING:      'RECORDING',
  PAUSED:         'PAUSED',
  PROCESSING:     'PROCESSING',
}

// Closed enum of specialties for the per-doctor CDI specialty dropdown.
// value → persisted to doctors.specialty; the cdi-review skill loads
// standards/specialties/<value>.md at runtime.
export const DOCTOR_SPECIALTIES = [
  { value: 'cardiology',          label: 'Cardiology' },
  { value: 'emergency_medicine',  label: 'Emergency Medicine' },
  { value: 'ent',                 label: 'ENT' },
  { value: 'hospitalist',         label: 'Hospitalist' },
  { value: 'obgyn',               label: 'OB-GYN' },
  { value: 'oncology',            label: 'Oncology' },
  { value: 'orthopedics',         label: 'Orthopedics' },
  { value: 'pain_management',     label: 'Pain Management / Spine' },
  { value: 'pulmonology',         label: 'Pulmonology' },
]

// Pipeline stage → human label for the floating status window.
export const STATUS_LABELS = {
  transcribing:    'Transcribing...',
  generating_note: 'Generating note...',
  queued:          'Queued',
  coding_icd:      'Adding ICD codes...',
  running_cdi:     'Running CDI review...',
  converting:      'Converting...',
  completed:       'Completed',
  failed:          'Failed',
}

// CDI mode options for the manual CDI tab.
// Mirrored from src/shared/cdi-modes.js; guarded by tests/unit/shared-drift.test.js.
export const CDI_MODES = [
  { value: 'balanced',   label: 'Balanced' },
  { value: 'compliance', label: 'Compliance' },
  { value: 'aggressive', label: 'Aggressive' },
]

export function specialtyLabel(value) {
  if (!value) return null
  const entry = DOCTOR_SPECIALTIES.find(s => s.value === value)
  return entry ? entry.label : value
}
