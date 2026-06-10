'use strict'

// Ordered engine chain: soap → icd → cdi.
// Engines run in this order per case. ICD runs after SOAP (needs the SOAP
// note to exist). CDI runs after ICD (needs ICD codes baked into the note).
// Adding a new engine = add its descriptor here + one migration + one skill folder.

const soap = require('./soap')
const icd  = require('./icd')
const cdi  = require('./cdi')

module.exports = [soap, icd, cdi]
