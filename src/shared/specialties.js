'use strict'

// Closed enum of specialties for the per-doctor CDI specialty dropdown.
// The `value` field is persisted to doctors.specialty in app.db and is what
// the cdi-review skill receives in its prompt. The skill loads
// notes-claude/standards/specialties/<value>.md at runtime — in v1 only
// `orthopedics.md` exists; selecting any other specialty makes the skill
// emit status='skipped' until the file is added.
//
// renderer/renderer.js has a copy of this array until Phase 4 wires it here.
// The drift test in tests/unit/shared-drift.test.js asserts they match.

const DOCTOR_SPECIALTIES = Object.freeze([
  { value: 'cardiology',          label: 'Cardiology' },
  { value: 'emergency_medicine',  label: 'Emergency Medicine' },
  { value: 'ent',                 label: 'ENT' },
  { value: 'hospitalist',         label: 'Hospitalist' },
  { value: 'obgyn',               label: 'OB-GYN' },
  { value: 'oncology',            label: 'Oncology' },
  { value: 'orthopedics',         label: 'Orthopedics' },
  { value: 'pain_management',     label: 'Pain Management / Spine' },
  { value: 'pulmonology',         label: 'Pulmonology' }
])

module.exports = { DOCTOR_SPECIALTIES }
