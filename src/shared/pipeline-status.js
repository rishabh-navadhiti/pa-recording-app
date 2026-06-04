'use strict'

// Pipeline stage labels shown in the floating status window.
// Single source: main.js reads these; the status window CSS uses the same
// key names as CSS classes. Keeping them here avoids the three-file drift
// (main.js STATUS_LABELS / status.css classes / status.js ad-hoc strings).

const STATUS_LABELS = Object.freeze({
  transcribing:    'Transcribing...',
  generating_note: 'Generating note...',
  queued:          'Queued',
  coding_icd:      'Adding ICD codes...',
  running_cdi:     'Running CDI review...',
  converting:      'Converting...',
  completed:       'Completed',
  failed:          'Failed'
})

module.exports = { STATUS_LABELS }
