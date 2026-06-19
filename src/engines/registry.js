'use strict'

// Ordered engine chain: soap → icd → cdi → em-score → patient-summary.
// Engines run in this order per case. ICD runs after SOAP (needs the SOAP
// note to exist). CDI runs after ICD (needs ICD codes baked into the note).
// em-score + patient-summary run after CDI; both are toggle-gated and write to
// the generic engine_outputs table (JSON only — no MD/docx of their own).
// Adding a new engine = add its descriptor here + one migration + one skill folder.

const soap           = require('./soap')
const icd            = require('./icd')
const cdi            = require('./cdi')
const emScore        = require('./emScore')
const patientSummary = require('./patientSummary')

module.exports = [soap, icd, cdi, emScore, patientSummary]
