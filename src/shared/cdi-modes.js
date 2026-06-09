'use strict'

// CDI mode options — single source. Mirrored in renderer/constants.js (ESM).
// Guarded by the drift test in tests/unit/shared-drift.test.js.

const CDI_MODES = [
  { value: 'balanced',   label: 'Balanced' },
  { value: 'compliance', label: 'Compliance' },
  { value: 'aggressive', label: 'Aggressive' },
]

module.exports = { CDI_MODES }
