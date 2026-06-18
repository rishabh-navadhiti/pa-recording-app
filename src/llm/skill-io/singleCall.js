'use strict'

const { parseSkillManifest } = require('./manifest')

// Strip YAML frontmatter (---\n...\n---\n) from the start of a skill file
// so the raw markdown body becomes the system prompt.
function stripFrontmatter(text) {
  const m = text.match(/^---\n[\s\S]*?\n---\n/)
  return m ? text.slice(m[0].length) : text
}

/**
 * Build the system + user messages for a single-call API note generation.
 *
 * @param {object} opts
 * @param {string} opts.skillText        Raw contents of generate-note-api/SKILL.md
 * @param {string} opts.templateText     Doctor template markdown (may be empty)
 * @param {string} opts.transcriptText   Transcript markdown
 * @param {string} opts.caseDir          Absolute path to the case folder (for the manifest)
 * @param {string} opts.soapNoteMdPath   Absolute path where the app will write the SOAP note
 * @param {string} opts.doctorLastname   Doctor lastname (e.g. "sabbag")
 * @returns {{ system: string, user: string }}
 */
function buildSingleCallNoteGen({ skillText, templateText, transcriptText, caseDir, soapNoteMdPath, doctorLastname }) {
  const system = stripFrontmatter(skillText)

  const parts = [
    `Generate a SOAP note for doctor ${doctorLastname}.`,
    `recording_folder: "${caseDir}"`,
    `soap_note_md: "${soapNoteMdPath}"`,
    '',
    'DOCTOR TEMPLATE:',
    '---',
    templateText || '(no template provided)',
    '---',
    '',
    'TRANSCRIPT:',
    '---',
    transcriptText,
    '---',
    '',
    'Write the complete SOAP note as plain text directly in your reply (no code fences, no preamble). ' +
    'End your reply with the single-line JSON manifest exactly as Step 7 defines, ' +
    'using the recording_folder and soap_note_md paths given above.',
  ]

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

module.exports = { buildSingleCallNoteGen, splitNoteAndManifest }
