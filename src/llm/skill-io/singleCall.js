'use strict'

const { parseSkillManifest } = require('./manifest')

/**
 * Strip YAML frontmatter (---\n...\n---\n) from the start of a skill file
 * so the raw markdown body becomes the system prompt.
 */
function stripFrontmatter(text) {
  const m = text.match(/^---\n[\s\S]*?\n---\n/)
  return m ? text.slice(m[0].length) : text
}

/**
 * Build the system + user messages for a single-call API note generation.
 *
 * @param {object} opts
 * @param {string} opts.skillText        Raw contents of generate-note-api/SKILL.md
 * @param {string} [opts.templateText]   Doctor template markdown (may be empty; omitted in detectionMode)
 * @param {string} opts.transcriptText   Transcript markdown
 * @param {string} opts.caseDir          Absolute path to the case folder (for the manifest)
 * @param {string} opts.soapNoteMdPath   Absolute path where the app will write the SOAP note
 * @param {string} opts.doctorLastname   Doctor lastname (e.g. "sabbag")
 * @param {string} [opts.patientName]    Patient name from the patient-name form (optional)
 * @param {string} [opts.dateOfService]  Date of service MM/DD/YYYY (optional)
 * @param {string} [opts.doctorFullName] Doctor full name (optional, falls back to lastname)
 * @param {string} [opts.targetPatient]  For multi-patient fan-out: generate only this patient
 * @param {boolean} [opts.detectionMode] When true: lean detection call — no template, no Patient Name,
 *                                       appends MODE: MULTI-PATIENT DETECTION instruction.
 * @param {string} [opts.prechartText]   In-recording pre-chart context (clinician-supplied background;
 *                                       injected on note-writing calls only, not the detection call)
 * @returns {{ system: string, user: string }}
 */
function buildSingleCallNoteGen({ skillText, templateText, transcriptText, caseDir, soapNoteMdPath, doctorLastname,
  patientName, dateOfService, doctorFullName, targetPatient, detectionMode = false, prechartText }) {
  const system = stripFrontmatter(skillText)

  const dateLine   = dateOfService ? dateOfService : '(not provided — use transcript or placeholder)'
  const doctorLine = doctorFullName || doctorLastname

  const injectedFacts = [
    'INJECTED FACTS (authoritative — use exactly where given):',
  ]

  // In detection mode we omit Patient Name — it's unused and confusing without a template.
  if (!detectionMode) {
    const patientLine = patientName ? patientName : '(not provided — use transcript or placeholder)'
    injectedFacts.push(`- Patient Name: ${patientLine}`)
  }

  injectedFacts.push(
    `- Date of Service: ${dateLine}`,
    `- Doctor: ${doctorLine}`,
    `- recording_folder: ${caseDir}`,
    `- soap_note_md: ${soapNoteMdPath}`,
  )

  if (targetPatient) {
    injectedFacts.push(`- Target patient (multi-patient fan-out — generate ONLY this patient, ignore the others): ${targetPatient}`)
  }

  const parts = [
    detectionMode
      ? 'Identify every patient in this transcript.'
      : `Generate the SOAP note for doctor ${doctorLastname}.`,
    '',
    injectedFacts.join('\n'),
  ]

  // Pre-chart context — note-writing calls only (omitted from the lean detection
  // call, which writes no note). Ranked just under INJECTED FACTS.
  if (!detectionMode && prechartText && prechartText.trim()) {
    parts.push(
      '',
      'PRE-CHART CONTEXT (clinician-supplied — authoritative background for this visit, second only to INJECTED FACTS):',
      '---',
      prechartText.trim(),
      '---'
    )
  }

  if (!detectionMode) {
    parts.push(
      '',
      'DOCTOR TEMPLATE:',
      '---',
      templateText || '(no template provided)',
      '---',
    )
  }

  parts.push(
    '',
    'TRANSCRIPT:',
    '---',
    transcriptText,
    '---',
    '',
    detectionMode
      ? 'MODE: MULTI-PATIENT DETECTION — list every patient, write no note; if truly one patient, return multi_patient:false with that one patient.'
      : 'Write the full SOAP note now, following the DOCTOR TEMPLATE and the rules, then the manifest line.',
  )

  return { system, user: parts.join('\n') }
}

/**
 * Split the model's combined response into the note body and the parsed manifest.
 * The manifest is the last JSON object in the text (last non-empty line or brace-balanced block).
 *
 * @param {string} text  Full model response text
 * @returns {{ noteBody: string, manifest: object|null }}
 */
function splitNoteAndManifest(text) {
  const manifest = parseSkillManifest(text)
  if (!manifest) return { noteBody: text.trim(), manifest: null }

  // Find the manifest JSON in the text by locating the last balanced { ... }
  // (same brace-balance approach as parseSkillManifest layer 3).
  let end = text.lastIndexOf('}')
  while (end >= 0) {
    let depth = 0
    let start = -1
    for (let i = end; i >= 0; i--) {
      const ch = text[i]
      if (ch === '}') depth++
      else if (ch === '{') { depth--; if (depth === 0) { start = i; break } }
    }
    if (start >= 0) {
      try {
        JSON.parse(text.slice(start, end + 1))
        const noteBody = text.slice(0, start).trim()
        return { noteBody, manifest }
      } catch {}
    }
    end = text.lastIndexOf('}', end - 1)
  }

  return { noteBody: text.trim(), manifest }
}

/**
 * Build the system + user messages for a single-call API note edit (pre-chart).
 * Node.js has already read all source files and created the backup.
 *
 * @param {object} opts
 * @param {string} opts.skillText          Raw contents of edit-note-api/SKILL.md
 * @param {string} opts.templateText       Doctor template markdown (may be empty)
 * @param {string} opts.existingNoteText   Current SOAP note content
 * @param {string} [opts.transcriptText]   Transcript markdown (cross-reference only)
 * @param {string} [opts.attachmentText]   Combined attachment text (may be empty)
 * @param {string} [opts.instructions]     Free-text scribe instructions (may be empty)
 * @param {string} opts.existingNotePath   Absolute path of the note to overwrite
 * @param {string} opts.backupPath         Absolute path of the backup (already created)
 * @returns {{ system: string, user: string }}
 */
function buildSingleCallNoteEdit({ skillText, templateText, existingNoteText, transcriptText,
  attachmentText, instructions, existingNotePath, backupPath }) {
  const system = stripFrontmatter(skillText)

  const parts = [
    'Edit the SOAP note for this case.',
    '',
    'INJECTED FACTS (authoritative — use exactly as given):',
    `- existing_note_path: ${existingNotePath}`,
    `- backup_path: ${backupPath}`,
    '',
    'DOCTOR TEMPLATE:',
    '---',
    templateText || '(no template provided)',
    '---',
    '',
    'EXISTING SOAP NOTE (base — preserve all manual edits):',
    '---',
    existingNoteText,
    '---',
  ]

  if (transcriptText && transcriptText.trim()) {
    parts.push(
      '', 'TRANSCRIPT (cross-reference only — do not re-extract content already in the note):',
      '---', transcriptText, '---'
    )
  }

  if (attachmentText && attachmentText.trim()) {
    parts.push(
      '', 'ATTACHMENT (new clinical content to integrate):',
      '---', attachmentText, '---'
    )
  }

  if (instructions && instructions.trim()) {
    parts.push(
      '', 'SCRIBE INSTRUCTIONS (highest authority — apply literally):',
      instructions.trim()
    )
  }

  parts.push('', 'Write the complete updated SOAP note now, then the manifest line.')

  return { system, user: parts.join('\n') }
}

/**
 * Build the system + user messages for a single-call API engine that emits ONE
 * JSON object (em-score, patient-summary). Generic — the engine supplies the
 * skill text, a one-line instruction, authoritative facts, the inline context
 * blocks (note / transcript / standards pack), and a closer telling the model to
 * return raw JSON only. Node reads all inputs and writes the resulting file; the
 * model returns nothing but the JSON object (no manifest line).
 *
 * @param {object} opts
 * @param {string}   opts.skillText        Raw contents of the *-api SKILL.md (frontmatter stripped → system)
 * @param {string}   opts.instruction      One-line task line, e.g. "Score the E/M level for this note."
 * @param {string[]} [opts.injectedFacts]  Authoritative facts, e.g. ["Patient: jane_doe", "Doctor: sabbag"]
 * @param {Array<{title:string, body:string}>} [opts.contextBlocks]  Inline content blocks (note, transcript, pack)
 * @param {string}   opts.closer           Final instruction, e.g. "Output the JSON object now — raw JSON only."
 * @returns {{ system: string, user: string }}
 */
function buildSingleCallEngineJson({ skillText, instruction, injectedFacts = [], contextBlocks = [], closer }) {
  const system = stripFrontmatter(skillText)
  const parts = [instruction, '']

  if (injectedFacts.length) {
    parts.push('INJECTED FACTS (authoritative — use exactly as given):')
    for (const f of injectedFacts) parts.push(`- ${f}`)
    parts.push('')
  }

  for (const { title, body } of contextBlocks) {
    if (!body || !body.trim()) continue
    parts.push(`${title}:`, '---', body, '---', '')
  }

  parts.push(closer)
  return { system, user: parts.join('\n') }
}

/**
 * Parse a single JSON object out of a model response. The *-api engine skills
 * instruct the model to return raw JSON only, so the primary path is a direct
 * JSON.parse; the fence-strip + largest-balanced-block fallbacks are defensive
 * against a stray code fence or surrounding prose.
 *
 * @param {string} text  Full model response text
 * @returns {object|null}  Parsed object, or null if no valid JSON found
 */
function parseJsonResponse(text) {
  if (!text) return null
  let t = text.trim()

  // Strip a wrapping ```json … ``` (or bare ``` … ```) fence if present.
  const fence = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/)
  if (fence) t = fence[1].trim()

  try { return JSON.parse(t) } catch {}

  // Fallback: widest balanced span between the first { and the last }.
  const start = t.indexOf('{')
  const end   = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)) } catch {}
  }

  return null
}

module.exports = {
  buildSingleCallNoteGen, buildSingleCallNoteEdit, splitNoteAndManifest, stripFrontmatter,
  buildSingleCallEngineJson, parseJsonResponse,
}
