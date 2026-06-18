'use strict'

// Single source of truth for the app state machine enum.
// Imported by main.js (Node/Electron) and exposed to the renderer via preload.
// renderer/renderer.js currently has its own copy — the drift test in
// tests/unit/shared-drift.test.js asserts they stay in sync until Phase 4
// wires the renderer to this file directly.

const STATE = Object.freeze({
  IDLE:           'IDLE',
  SESSION_ACTIVE: 'SESSION_ACTIVE',
  RECORDING:      'RECORDING',
  PAUSED:         'PAUSED',
  PROCESSING:     'PROCESSING'
})

module.exports = { STATE }
