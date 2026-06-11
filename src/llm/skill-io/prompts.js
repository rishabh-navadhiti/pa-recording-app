'use strict'

// Prompt builders — one per skill.
// Each returns the exact string passed to `claude -p <prompt>`.
// Because the prompt is a separate argv element (not shell-interpolated),
// NO escaping is needed here — the string is passed verbatim to the model.
//
// Inputs are structured objects, not pre-built strings.  This is the single
// place where the Node-side prompt contract lives; grep here to find or
// change a skill's expected invocation format.

/**
 * @param {object} input
 * @param {string} [input.templateRel]   Relative path to the doctor template .md
 * @param {string}  input.transcriptRel  Relative path to transcript.md
 */
function generateNote({ templateRel, transcriptRel }) {
  if (templateRel) {
    return `generate a note using template "${templateRel}" and transcript "${transcriptRel}"`
  }
  return `generate a note using transcript "${transcriptRel}"`
}

/**
 * @param {object} input
 * @param {string}  input.soapRel  Relative path to the SOAP note .md
 */
function addIcdCodes({ soapRel }) {
  return `add ICD codes. Soap note: "${soapRel}".`
}

/**
 * @param {object} input
 * @param {string}  input.caseDir      Absolute path to the case folder
 * @param {string}  input.specialty    Doctor specialty (e.g. 'orthopedics')
 * @param {string}  input.mode         'balanced'|'compliance'|'aggressive'
 * @param {string}  input.doctor       Doctor full name
 * @param {string}  input.standardsDir Absolute path to the standards directory
 */
function cdiReview({ caseDir, specialty, mode, doctor, standardsDir }) {
  return `review cdi. Case: ${caseDir}. Specialty: ${specialty}. Mode: ${mode}. Doctor: ${doctor}. Standards: ${standardsDir}`
}

/**
 * @param {object} input
 * @param {string}  input.doctorName  Full doctor name
 * @param {string}  input.stagingRel  Relative path to the staging folder
 */
function createDoctorProfile({ doctorName, stagingRel }) {
  return `create a doctor profile for "${doctorName}" from source folder "${stagingRel}"`
}

/**
 * @param {object} input
 * @param {string}   input.doctorName      Full doctor name
 * @param {string}   input.templatePath    Absolute path to the template .md
 * @param {string}   input.corrections     Free-text corrections (typed by user)
 * @param {string}   [input.correctionsFile]  Path to corrections file (optional)
 * @param {string} [input.correctionsFile]  Absolute path to a corrections file (or '' )
 * @param {string} [input.samplesDir]        Absolute path to the staged-samples FOLDER (or '')
 *
 * NOTE: the update-doctor-profile skill's Step 0 parses by FIXED markers and
 * reads `Samples:` as a single folder path — so all five markers are ALWAYS
 * emitted (empty value when absent) and `samplesDir` is a directory, not a list.
 * See notes-claude/skills/update-doctor-profile/SKILL.md Step 0.
 */
function updateDoctorProfile({ doctorName, templatePath, corrections, correctionsFile, samplesDir }) {
  return `update doctor profile. Doctor: ${doctorName}. Template: ${templatePath}. Corrections: ${corrections}. CorrectionsFile: ${correctionsFile || ''}. Samples: ${samplesDir || ''}`
}

/**
 * @param {object} input
 * @param {string}  input.caseDir       Absolute path to the case folder
 * @param {string}  input.templatePath  Absolute path to the doctor template .md
 * @param {string}  input.attachmentPath  Absolute path to combined attachment .md (or empty string)
 * @param {string}  input.instructions  Free-text instructions from the user
 */
function editNote({ caseDir, templatePath, attachmentPath, instructions }) {
  return `edit note. Case: ${caseDir}. Template: ${templatePath}. Attachment: ${attachmentPath || ''}. Instructions: ${instructions}`
}

/**
 * @param {object} input
 * @param {string}  input.caseDir      Absolute path to the case folder
 * @param {string}  input.specialty    Doctor specialty (e.g. 'orthopedics')
 * @param {string}  input.standardsDir Absolute path to the standards directory
 */
function scoreEm({ caseDir, specialty, standardsDir }) {
  return `score em. Case: ${caseDir}. Specialty: ${specialty}. Standards: ${standardsDir}`
}

/**
 * @param {object} input
 * @param {string}  input.caseDir  Absolute path to the case folder
 */
function patientSummary({ caseDir }) {
  return `summarize for patient. Case: ${caseDir}`
}

const BUILDERS = {
  'generate-note':        generateNote,
  'add-icd-codes':        addIcdCodes,
  'cdi-review':           cdiReview,
  'create-doctor-profile': createDoctorProfile,
  'update-doctor-profile': updateDoctorProfile,
  'edit-note':            editNote,
  'em-score':             scoreEm,
  'patient-summary':      patientSummary,
}

/**
 * Build the prompt string for a skill invocation.
 *
 * @param {string} skillId  e.g. 'generate-note', 'cdi-review'
 * @param {object} input    Structured input — see per-skill functions above
 * @returns {string}
 */
function buildPrompt(skillId, input) {
  const builder = BUILDERS[skillId]
  if (!builder) throw new Error(`Unknown skillId: ${skillId}`)
  return builder(input)
}

module.exports = { buildPrompt, BUILDERS }
